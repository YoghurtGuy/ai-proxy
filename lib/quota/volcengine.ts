import crypto from "node:crypto";
import type { QuotaSnapshot, QuotaWindow, UpstreamQuota } from "../types";

/**
 * 火山引擎方舟 Agent Plan 套餐额度（AFP）查询。
 *
 * - GetAFPUsage 只适用于个人版 Agent Plan，企业版席位要用 GetSeatAFPUsage。
 * - 管控面 API 走 volcengineapi.com 网关，只能用 IAM 的 AK/SK 走 Signature V4，
 *   推理用的 Ark API Key 调不了。
 * - Quota / Used 是字符串，ResetTime / SubscribeTime 是 epoch 毫秒。
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
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k, v])),
    Authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeadersValue}, Signature=${signature}`,
  };

  return { headers, signature, canonicalRequest, stringToSign };
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

export function quotaHost(region: string): string {
  return `ark.${region.trim() || "cn-beijing"}.volcengineapi.com`;
}

/** 拉一次套餐额度。失败时返回带 error 的快照，不抛异常。 */
export async function fetchVolcengineQuota(cfg: UpstreamQuota, now = new Date()): Promise<QuotaSnapshot> {
  const region = cfg.region.trim() || "cn-beijing";
  const host = quotaHost(region);
  const body = "{}";
  const query = { Action: "GetAFPUsage", Version: API_VERSION };

  const fail = (message: string): QuotaSnapshot => ({
    remainingPct: 0,
    windows: {},
    fetchedAt: now.getTime(),
    error: message,
  });

  if (!cfg.accessKey || !cfg.secretKey) return fail("未配置 AK/SK");

  const { headers } = signRequest({
    method: "POST",
    host,
    query,
    body,
    region,
    service: SERVICE,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    now,
  });

  const url = `https://${host}/?${canonicalQuery(query)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return fail(`请求失败: ${(err as Error).message}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(`HTTP ${res.status}: 响应不是 JSON`);
  }

  const root = parsed as Record<string, unknown>;
  const meta = root.ResponseMetadata as Record<string, unknown> | undefined;
  const errObj = meta?.Error as Record<string, unknown> | undefined;
  if (!res.ok || errObj) {
    const code = errObj?.Code ? String(errObj.Code) : `HTTP ${res.status}`;
    const msg = errObj?.Message ? String(errObj.Message) : text.slice(0, 200);
    return fail(`${code}: ${msg}`);
  }

  const result = root.Result as Record<string, unknown> | undefined;
  if (!result) return fail("响应里没有 Result");

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