import crypto from "node:crypto";
import {
  keyAcquire,
  keyRelease,
  keyRpmWait,
  markCooldown,
  markFailure,
  markSuccess,
  releaseUpstream,
  selectAndAcquire,
} from "./scheduler";
import { recordRequest, usedToday } from "./stats";
import { getConfig } from "./store";
import { tapStream, usageFromJsonBody, type UsageTotals } from "./stream";
import { modelAllowed, type Config, type DownstreamKey, type Settings, type Upstream } from "./types";

/**
 * 转发核心：鉴权 → 限流 → 选号 → 转发 → 失败换号 → 记账。
 *
 * 只有在「还没往客户端吐任何字节」时才能换号，所以流式请求一旦开始返回就锁定了上游。
 */

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "x-api-key",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authorization",
  "te",
  "trailer",
]);

function jsonError(status: number, message: string, code = "proxy_error", extra?: Record<string, string>): Response {
  return Response.json(
    { error: { message, type: "proxy_error", code } },
    { status, headers: { "cache-control": "no-store", ...extra } },
  );
}

export function extractKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey.trim();
  return null;
}

export function findKey(config: Config, candidate: string): DownstreamKey | null {
  for (const k of config.keys) {
    if (k.key === candidate) return k;
  }
  return null;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** 用「下游 key + 首条 user 消息」做会话指纹，保证多轮对话落同一个上游吃 KV cache。 */
export function sessionHash(keyId: string, body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const obj = body as Record<string, unknown>;
  let seed = "";
  if (Array.isArray(obj.messages)) {
    const firstUser = (obj.messages as unknown[]).find(
      (m) => m && typeof m === "object" && (m as Record<string, unknown>).role === "user",
    );
    if (firstUser) seed = contentToText((firstUser as Record<string, unknown>).content);
  } else if (typeof obj.prompt === "string") {
    seed = obj.prompt;
  }
  if (!seed) return "";
  return crypto.createHash("sha256").update(`${keyId}\u0000${seed.slice(0, 400)}`).digest("hex").slice(0, 32);
}

function clampCooldown(ms: number, settings: Settings): number {
  const max = settings.cooldownMaxSec * 1000;
  if (!Number.isFinite(ms)) return settings.cooldownDefaultSec * 1000;
  return Math.min(max, Math.max(1000, ms));
}

/** 解析 "1m30s" / "1.5s" / "800ms" / "6m0s" 这类时长；纯数字按秒处理。 */
export function parseDurationMs(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) return null;
    total += value * (m[2] === "ms" ? 1 : m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000);
  }
  return matched ? total : null;
}

/** 尽量从响应头/响应体里抠出该冷却多久。抠不到就用兜底值。 */
export function parseCooldownMs(headers: Headers, body: string, settings: Settings): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return clampCooldown(secs * 1000, settings);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return clampCooldown(at - Date.now(), settings);
  }

  for (const name of [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset",
    "anthropic-ratelimit-unified-reset",
  ]) {
    const value = headers.get(name);
    if (!value) continue;
    // 先看是不是秒级时间戳，再按时长解析
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1e9) return clampCooldown(numeric * 1000 - Date.now(), settings);
    const parsed = parseDurationMs(value);
    if (parsed !== null) return clampCooldown(parsed, settings);
  }

  const bodyMatch = body.match(/try again in ([\d.]+)\s*(ms|s|m|h)/i);
  if (bodyMatch) {
    const ms = parseDurationMs(`${bodyMatch[1]}${bodyMatch[2]}`);
    if (ms) return clampCooldown(ms, settings);
  }

  return clampCooldown(settings.cooldownDefaultSec * 1000, settings);
}

function backoffMs(consecutiveFails: number, settings: Settings): number {
  const base = 10_000;
  return clampCooldown(base * 2 ** Math.min(Math.max(consecutiveFails - 1, 0), 5), settings);
}

/** 这些状态码说明「这个上游现在不行」，值得换一个再试。 */
function shouldFailover(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
}

function upstreamUrl(up: Upstream, path: string): string {
  return `${up.baseUrl.replace(/\/+$/, "")}${path}`;
}

function buildRequestHeaders(req: Request, up: Upstream): Headers {
  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set("authorization", `Bearer ${up.apiKey}`);
  return headers;
}

function responseHeaders(up: Upstream, upstreamRes: Response): Headers {
  const headers = new Headers();
  const contentType = upstreamRes.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.set("x-ai-proxy-upstream", up.id);
  return headers;
}

function reasonMessage(reason: string): string {
  switch (reason) {
    case "no_model":
      return "没有上游提供该模型";
    case "all_cooling":
      return "所有上游都在限流冷却中，请稍后重试";
    case "all_busy":
      return "所有上游并发已满，请稍后重试";
    case "quota_exhausted":
      return "所有上游套餐额度已用尽";
    default:
      return "没有可用的上游";
  }
}

interface ProxyOptions {
  /** 上游相对路径，例如 /chat/completions */
  path: string;
  /** 请求体和模型是否必须存在 */
  requireModel?: boolean;
}

export async function handleProxy(req: Request, options: ProxyOptions): Promise<Response> {
  const config = await getConfig();
  const settings = config.settings;

  const presented = extractKey(req);
  if (!presented) return jsonError(401, "缺少 API key，请用 Authorization: Bearer <key>", "missing_api_key");

  const key = findKey(config, presented);
  if (!key) return jsonError(401, "API key 无效", "invalid_api_key");
  if (!key.enabled) return jsonError(403, "该 API key 已被停用", "key_disabled");
  if (key.limits.expiresAt) {
    const exp = Date.parse(key.limits.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) return jsonError(403, "该 API key 已过期", "key_expired");
  }

  const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  let parsedBody: unknown = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return jsonError(400, "请求体不是合法 JSON", "invalid_body");
    }
  }

  const model =
    parsedBody && typeof parsedBody === "object" && typeof (parsedBody as Record<string, unknown>).model === "string"
      ? ((parsedBody as Record<string, unknown>).model as string)
      : "";

  if (options.requireModel !== false && !model) {
    return jsonError(400, "请求体缺少 model 字段", "missing_model");
  }

  if (model && !modelAllowed(key.limits.allowedModels, model)) {
    return jsonError(403, `该 key 不允许访问模型 ${model}`, "model_not_allowed");
  }

  // 日限额
  const used = usedToday(`key:${key.id}`);
  if (key.limits.dailyRequests && used.req >= key.limits.dailyRequests) {
    return jsonError(429, "该 key 已达到今日请求数上限", "daily_requests_exceeded");
  }
  if (key.limits.dailyTokens && used.tokens >= key.limits.dailyTokens) {
    return jsonError(429, "该 key 已达到今日 token 上限", "daily_tokens_exceeded");
  }

  // 每分钟请求数
  const rpmWait = keyRpmWait(key);
  if (rpmWait !== null) {
    return jsonError(429, "该 key 触发每分钟请求数限制", "rate_limited", {
      "retry-after": String(Math.ceil(rpmWait / 1000)),
    });
  }

  if (!keyAcquire(key)) {
    return jsonError(429, "该 key 并发数已满", "concurrency_limited");
  }

  const streamRequested =
    Boolean(parsedBody && typeof parsedBody === "object" && (parsedBody as Record<string, unknown>).stream);
  const hash = model ? sessionHash(key.id, parsedBody) : "";
  const excluded = new Set<string>();
  const startedAt = Date.now();

  let keyHeld = true;
  const releaseKeyOnce = () => {
    if (keyHeld) {
      keyHeld = false;
      keyRelease(key.id);
    }
  };

  const record = (upId: string, status: number, usage: UsageTotals, ttftMs: number, retries: number, err: string | null) => {
    recordRequest({
      ts: Date.now(),
      keyId: key.id,
      upId,
      model,
      status,
      stream: streamRequested,
      pt: usage.pt,
      ct: usage.ct,
      ttftMs,
      ms: Date.now() - startedAt,
      retries,
      err,
    });
  };

  let lastError = "";
  let lastStatus = 503;
  let lastUpId = "";

  for (let attempt = 0; attempt < settings.maxAttempts; attempt++) {
    const picked = selectAndAcquire(config, model, hash, excluded);
    if (!picked.up) {
      lastError = reasonMessage(picked.reason);
      lastStatus = picked.reason === "all_cooling" || picked.reason === "quota_exhausted" ? 429 : 503;
      break;
    }

    const up = picked.up;
    lastUpId = up.id;
    const url = upstreamUrl(up, options.path);
    const headers = buildRequestHeaders(req, up);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(url, {
        method: req.method,
        headers,
        body: rawBody && req.method !== "GET" && req.method !== "HEAD" ? rawBody : undefined,
        signal: req.signal,
      });
    } catch (err) {
      const fails = markFailure(up.id, 0);
      markCooldown(up.id, backoffMs(fails, settings), "network");
      releaseUpstream(up.id);
      excluded.add(up.id);
      lastStatus = 502;
      lastError = `上游网络错误: ${(err as Error).message}`;
      continue;
    }

    if (shouldFailover(upstreamRes.status)) {
      const text = await upstreamRes.text().catch(() => "");
      const fails = markFailure(up.id, upstreamRes.status);
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        markCooldown(up.id, 60 * 60_000, `HTTP ${upstreamRes.status} 疑似密钥失效`);
      } else if (upstreamRes.status === 429) {
        markCooldown(up.id, parseCooldownMs(upstreamRes.headers, text, settings), "429 限流");
      } else if (upstreamRes.status >= 500) {
        markCooldown(up.id, backoffMs(fails, settings), `HTTP ${upstreamRes.status}`);
      }
      releaseUpstream(up.id);
      excluded.add(up.id);
      lastStatus = upstreamRes.status;
      lastError = text.slice(0, 300) || `上游返回 ${upstreamRes.status}`;
      continue;
    }

    // 走到这里说明这次请求有结果了：成功或者是一个不该重试的 4xx。
    const headersOut = responseHeaders(up, upstreamRes);
    const okStatus = upstreamRes.status;

    if (!streamRequested || !upstreamRes.body) {
      const text = await upstreamRes.text().catch(() => "");
      const usage = okStatus < 400 ? usageFromJsonBody(text) : { pt: 0, ct: 0, exact: false };
      releaseUpstream(up.id);
      releaseKeyOnce();
      if (okStatus < 400) markSuccess(up.id, Date.now() - startedAt);
      record(up.id, okStatus, usage, 0, attempt, okStatus >= 400 ? text.slice(0, 200) : null);
      return new Response(text, { status: okStatus, headers: headersOut });
    }

    let firstByteAt = 0;
    const tapped = tapStream(upstreamRes.body, {
      onFirstByte: () => {
        firstByteAt = Date.now();
      },
      onDone: (usage, completed) => {
        releaseUpstream(up.id);
        releaseKeyOnce();
        if (completed && okStatus < 400) markSuccess(up.id, Date.now() - startedAt);
        record(
          up.id,
          okStatus,
          usage,
          firstByteAt ? firstByteAt - startedAt : 0,
          attempt,
          completed ? null : "客户端提前断开",
        );
      },
    });
    return new Response(tapped, { status: okStatus, headers: headersOut });
  }

  releaseKeyOnce();
  record(lastUpId, lastStatus, { pt: 0, ct: 0, exact: false }, 0, settings.maxAttempts, lastError);
  return jsonError(lastStatus === 429 ? 429 : 502, lastError || "所有上游都失败了", "upstream_failed");
}