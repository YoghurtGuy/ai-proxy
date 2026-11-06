import crypto from "node:crypto";
import type { QuotaSnapshot, QuotaWindow, UpstreamQuota } from "../types";

/**
 * 火山引擎方舟 Agent Plan 相关接口。
 *
 * 这些都是管控面 API，走 volcengineapi.com 网关，只能用 IAM 的 AK/SK 做
 * Signature V4 签名，推理用的 Ark API Key 调不了。
 *
 * 注意 AccountFlowLimitExceeded：这套接口有 QPS 限制，调用方要缓存。
 */

const SERVICE = "ark";
const API_VERSION = "2024-01-01";
const SIGNED_HEADERS = ["host", "x-content-sha256", "x-date"];

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** YYYYMMDD'T'HHMMSS'Z'，UTC */
export function amzDate(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
}

export interface SignOptions {
  method: string;
  host: string;
  query: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  now?: Date;
  /** 默认 host;x-content-sha256;x-date，测试向量需要更少的头 */
  signedHeaders?: string[];
  /** 额外要签的头，例如 content-type */
  extraHeaders?: Record<string, string>;
}

export interface SignedRequest {
  headers: Record<string, string>;
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

export function signRequest(opts: SignOptions): SignedRequest {
  const {
    method,
    host,
    query,
    body,
    region,
    service,
    accessKey,
    secretKey,
    signedHeaders = SIGNED_HEADERS,
    extraHeaders = {},
  } = opts;

  const xDate = amzDate(opts.now);
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const values: Record<string, string> = {
    host,
    "x-content-sha256": payloadHash,
    "x-date": xDate,
  };
  for (const [name, value] of Object.entries(extraHeaders)) values[name.toLowerCase()] = value.trim();

  const names = [...signedHeaders].map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${(values[n] ?? "").trim()}\n`).join("");
  const signedHeadersValue = names.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    "/",
    canonicalQuery(query),
    canonicalHeaders,
    signedHeadersValue,
    payloadHash,
  ].join("\n");

  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(secretKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const headers: Record<string, string> = {
    Host: host,
    "X-Date": xDate,
    "X-Content-Sha256": payloadHash,
    "Content-Type": "application/json",
    ...extraHeaders,
    Authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeadersValue}, Signature=${signature}`,
  };

  return { headers, signature, canonicalRequest, stringToSign };
}

// ---------------------------------------------------------------------------
// 通用调用
// ---------------------------------------------------------------------------

export interface ArkApiConfig {
  region: string;
  accessKey: string;
  secretKey: string;
}

export type ArkApiResponse = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

export function quotaHost(region: string): string {
  return `ark.${region.trim() || "cn-beijing"}.volcengineapi.com`;
}

/** 调用一个管控面 Action。失败不抛异常，把错误文案交给调用方展示。 */
export async function callArkApi(
  cfg: ArkApiConfig,
  action: string,
  body: Record<string, unknown> = {},
  now = new Date(),
): Promise<ArkApiResponse> {
  if (!cfg.accessKey || !cfg.secretKey) return { ok: false, error: "未配置 AK/SK" };

  const region = (cfg.region || "cn-beijing").trim();
  const host = quotaHost(region);
  const query = { Action: action, Version: API_VERSION };
  const payload = JSON.stringify(body);

  const { headers } = signRequest({
    method: "POST",
    host,
    query,
    body: payload,
    region,
    service: SERVICE,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    now,
  });

  let res: Response;
  try {
    res = await fetch(`https://${host}/?${canonicalQuery(query)}`, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: `请求失败: ${(err as Error).message}` };
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `HTTP ${res.status}: 响应不是 JSON` };
  }

  const root = parsed as Record<string, unknown>;
  const meta = root.ResponseMetadata as Record<string, unknown> | undefined;
  const errObj = meta?.Error as Record<string, unknown> | undefined;
  if (!res.ok || errObj) {
    const code = errObj?.Code ? String(errObj.Code) : `HTTP ${res.status}`;
    const msg = errObj?.Message ? String(errObj.Message) : text.slice(0, 200);
    return { ok: false, error: `${code}: ${msg}` };
  }

  const result = root.Result as Record<string, unknown> | undefined;
  if (!result) return { ok: false, error: "响应里没有 Result" };
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// GetAFPUsage
// ---------------------------------------------------------------------------

interface AfpWindowRaw {
  Quota?: string | number;
  Used?: string | number;
  ResetTime?: number;
  SubscribeTime?: number;
}

const WINDOW_KEYS: Record<string, string> = {
  AFPFiveHour: "fiveHour",
  AFPDaily: "daily",
  AFPWeekly: "weekly",
  AFPMonthly: "monthly",
};

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 拉一次套餐 AFP 额度。失败时返回带 error 的快照，不抛异常。
 * Quota / Used 是字符串，ResetTime 是 epoch 毫秒。
 */
export async function fetchVolcengineQuota(cfg: UpstreamQuota, now = new Date()): Promise<QuotaSnapshot> {
  const fail = (error: string): QuotaSnapshot => ({
    remainingPct: 0,
    windows: {},
    fetchedAt: now.getTime(),
    error,
  });

  const res = await callArkApi(cfg, "GetAFPUsage", {}, now);
  if (!res.ok) return fail(res.error);

  const result = res.result;
  const windows: Record<string, QuotaWindow> = {};
  let minPct = 100;
  for (const [rawKey, friendly] of Object.entries(WINDOW_KEYS)) {
    const w = result[rawKey] as AfpWindowRaw | undefined;
    if (!w) continue;
    const quota = toNumber(w.Quota);
    const used = toNumber(w.Used);
    windows[friendly] = { quota, used, resetTime: toNumber(w.ResetTime) };
    const pct = quota > 0 ? ((quota - used) / quota) * 100 : 0;
    if (pct < minPct) minPct = pct;
  }

  if (Object.keys(windows).length === 0) return fail("响应里没有可用的额度窗口");

  return {
    planType: result.PlanType ? String(result.PlanType) : undefined,
    remainingPct: Math.max(0, Math.min(100, minPct)),
    windows,
    fetchedAt: now.getTime(),
  };
}

// ---------------------------------------------------------------------------
// ListArkAgentPlanModel
// ---------------------------------------------------------------------------

export interface AgentPlanModel {
  id: string;
  /** Load.Status：1 可调度，2 暂不可用 */
  available: boolean;
  /** Load.Level：1-3，越大越忙 */
  loadLevel?: number;
}

/**
 * 套餐当前支持的模型列表。
 * Datas[].Load 会给实时负载，Status !== 1 表示当前不可调度。
 */
export async function listAgentPlanModels(
  cfg: ArkApiConfig,
  now = new Date(),
): Promise<{ models: AgentPlanModel[] } | { error: string }> {
  const res = await callArkApi(cfg, "ListArkAgentPlanModel", { Edition: "personal" }, now);
  if (!res.ok) return { error: res.error };

  const datas = res.result.Datas;
  if (!Array.isArray(datas)) return { error: "响应里没有 Datas" };

  const models: AgentPlanModel[] = [];
  for (const item of datas) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.ModelID === "string" ? row.ModelID : "";
    if (!id) continue;
    const load = (row.Load ?? {}) as Record<string, unknown>;
    const status = toNumber(load.Status);
    models.push({
      id,
      available: status === 0 || status === 1,
      loadLevel: Number.isFinite(Number(load.Level)) ? Number(load.Level) : undefined,
    });
  }

  return { models };
}