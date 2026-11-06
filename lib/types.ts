/**
 * 配置与用量的类型定义。
 * 这个文件不依赖任何运行时，前后端都可以 import。
 */

export const CONFIG_VERSION = 1;

export interface WeightSettings {
  /** 优先级因子权重，数值越小优先级越高 */
  priority: number;
  /** 负载因子权重（1 - inflight/concurrency） */
  load: number;
  /** 套餐额度余量权重 */
  quota: number;
  /** 错误率权重 */
  errorRate: number;
  /** 从候选中按分数加权随机取前 K 个 */
  topK: number;
}

export interface Settings {
  /** 套餐额度轮询间隔（秒），0 关闭 */
  quotaPollSec: number;
  /** 429 没有给出重置时间时的兜底冷却（秒） */
  cooldownDefaultSec: number;
  /** 冷却时间上限（秒） */
  cooldownMaxSec: number;
  /** 粘性会话 TTL（分钟），0 关闭 */
  stickyTtlMin: number;
  /** 单个请求最多尝试几个上游 */
  maxAttempts: number;
  /** 明细日志保留天数 */
  logRetentionDays: number;
  weights: WeightSettings;
}

export type QuotaProvider = "volcengine-afp";

/** 只有套餐类额度才参与调度；按量计费上游留空 quota 即可。 */
export interface UpstreamQuota {
  provider: QuotaProvider;
  region: string;
  accessKey: string;
  secretKey: string;
  /** 剩余比例低于该值时暂停调度 */
  minRemainingPct: number;
}

export interface Upstream {
  id: string;
  name: string;
  /** 上游 OpenAI 兼容根地址，例如 https://ark.cn-beijing.volces.com/api/v3 */
  baseUrl: string;
  apiKey: string;
  /** 支持的上游模型名，["*"] 表示全部 */
  models: string[];
  /** 数值越小越优先 */
  priority: number;
  /** 并发上限 */
  concurrency: number;
  enabled: boolean;
  quota: UpstreamQuota | null;
}

export interface KeyLimits {
  /** 每分钟请求数上限，0 不限 */
  rpm: number;
  /** 并发上限，0 不限 */
  concurrency: number;
  /** 每日请求数上限，0 不限 */
  dailyRequests: number;
  /** 每日 token 上限，0 不限 */
  dailyTokens: number;
  /** 允许的模型，["*"] 表示全部 */
  allowedModels: string[];
  /** ISO 时间字符串，null 表示不过期 */
  expiresAt: string | null;
}

export interface DownstreamKey {
  id: string;
  name: string;
  /** 下发给客户端的 key，形如 sk-xxxx */
  key: string;
  enabled: boolean;
  limits: KeyLimits;
}

export interface Config {
  version: number;
  settings: Settings;
  upstreams: Upstream[];
  keys: DownstreamKey[];
}

/** 单个统计桶。ttftSum/ttftN 用于算首字延迟均值。 */
export interface Bucket {
  req: number;
  err: number;
  pt: number;
  ct: number;
  ttftSum: number;
  ttftN: number;
  msSum: number;
}

export interface UsageFile {
  version: number;
  /** 日期 -> 扁平维度 key -> 桶。维度形如 total / upstream:<id> / key:<id> / model:<name> */
  days: Record<string, Record<string, Bucket>>;
}

/** 内存里的额度快照，不落盘。 */
export interface QuotaWindow {
  quota: number;
  used: number;
  resetTime: number;
}

export interface QuotaSnapshot {
  planType?: string;
  /** 剩余比例 0-100，取所有窗口的最小值 */
  remainingPct: number;
  windows: Record<string, QuotaWindow>;
  fetchedAt: number;
  error?: string;
}

export interface RequestLogLine {
  ts: number;
  keyId: string;
  upId: string;
  model: string;
  status: number;
  stream: boolean;
  pt: number;
  ct: number;
  ttftMs: number;
  ms: number;
  retries: number;
  err: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  quotaPollSec: 300,
  cooldownDefaultSec: 5,
  cooldownMaxSec: 7200,
  stickyTtlMin: 30,
  maxAttempts: 3,
  logRetentionDays: 14,
  weights: { priority: 1, load: 1, quota: 1.5, errorRate: 0.8, topK: 3 },
};

export const DEFAULT_KEY_LIMITS: KeyLimits = {
  rpm: 0,
  concurrency: 0,
  dailyRequests: 0,
  dailyTokens: 0,
  allowedModels: ["*"],
  expiresAt: null,
};

export function emptyBucket(): Bucket {
  return { req: 0, err: 0, pt: 0, ct: 0, ttftSum: 0, ttftN: 0, msSum: 0 };
}

export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, settings: { ...DEFAULT_SETTINGS }, upstreams: [], keys: [] };
}

/** 模型是否被允许（支持 "*" 通配）。 */
export function modelAllowed(allowed: string[], model: string): boolean {
  if (allowed.includes("*")) return true;
  return allowed.includes(model);
}

// ---------------------------------------------------------------------------
// 校验：config.json 是用户可以直接手改的，这里按信任边界处理。
// ---------------------------------------------------------------------------

class Invalid extends Error {}

function fail(where: string, what: string): never {
  throw new Invalid(`${where}: ${what}`);
}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(where, "应为对象");
  return v as Record<string, unknown>;
}

function asNumber(v: unknown, where: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null) return def;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) fail(where, "应为数字");
  return Math.min(max, Math.max(min, n));
}

function asBool(v: unknown, where: string, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") fail(where, "应为布尔值");
  return v;
}

function asString(v: unknown, where: string, def = ""): string {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string") fail(where, "应为字符串");
  return v;
}

function asStringArray(v: unknown, where: string, def: string[]): string[] {
  if (v === undefined || v === null) return def;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(where, "应为字符串数组");
  return v as string[];
}

function normalizeBaseUrl(raw: string, where: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) fail(where, "不能为空");
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") fail(where, "只支持 http/https");
  } catch {
    fail(where, "不是合法的 URL");
  }
  return trimmed;
}

export function normalizeSettings(raw: unknown): Settings {
  const o = raw ? asObject(raw, "settings") : {};
  const w = o.weights ? asObject(o.weights, "settings.weights") : {};
  const d = DEFAULT_SETTINGS;
  return {
    quotaPollSec: asNumber(o.quotaPollSec, "settings.quotaPollSec", d.quotaPollSec, 0, 86400),
    cooldownDefaultSec: asNumber(o.cooldownDefaultSec, "settings.cooldownDefaultSec", d.cooldownDefaultSec, 0, 7200),
    cooldownMaxSec: asNumber(o.cooldownMaxSec, "settings.cooldownMaxSec", d.cooldownMaxSec, 1, 86400),
    stickyTtlMin: asNumber(o.stickyTtlMin, "settings.stickyTtlMin", d.stickyTtlMin, 0, 10080),
    maxAttempts: Math.round(asNumber(o.maxAttempts, "settings.maxAttempts", d.maxAttempts, 1, 10)),
    logRetentionDays: Math.round(asNumber(o.logRetentionDays, "settings.logRetentionDays", d.logRetentionDays, 1, 365)),
    weights: {
      priority: asNumber(w.priority, "settings.weights.priority", d.weights.priority, 0, 100),
      load: asNumber(w.load, "settings.weights.load", d.weights.load, 0, 100),
      quota: asNumber(w.quota, "settings.weights.quota", d.weights.quota, 0, 100),
      errorRate: asNumber(w.errorRate, "settings.weights.errorRate", d.weights.errorRate, 0, 100),
      topK: Math.round(asNumber(w.topK, "settings.weights.topK", d.weights.topK, 1, 20)),
    },
  };
}

export function normalizeKeyLimits(raw: unknown, where: string): KeyLimits {
  const o = raw ? asObject(raw, where) : {};
  const d = DEFAULT_KEY_LIMITS;
  return {
    rpm: Math.round(asNumber(o.rpm, `${where}.rpm`, d.rpm, 0, 1_000_000)),
    concurrency: Math.round(asNumber(o.concurrency, `${where}.concurrency`, d.concurrency, 0, 10_000)),
    dailyRequests: Math.round(asNumber(o.dailyRequests, `${where}.dailyRequests`, d.dailyRequests, 0, 1_000_000_000)),
    dailyTokens: Math.round(asNumber(o.dailyTokens, `${where}.dailyTokens`, d.dailyTokens, 0, 1_000_000_000_000)),
    allowedModels: asStringArray(o.allowedModels, `${where}.allowedModels`, d.allowedModels),
    expiresAt: o.expiresAt == null || o.expiresAt === "" ? null : asString(o.expiresAt, `${where}.expiresAt`),
  };
}

export function normalizeUpstream(raw: unknown, index: number): Upstream {
  const where = `upstreams[${index}]`;
  const o = asObject(raw, where);
  const id = asString(o.id, `${where}.id`) || `u_${index}`;
  const quotaRaw = o.quota == null ? null : asObject(o.quota, `${where}.quota`);

  let quota: UpstreamQuota | null = null;
  if (quotaRaw) {
    const provider = asString(quotaRaw.provider, `${where}.quota.provider`, "volcengine-afp");
    if (provider !== "volcengine-afp") {
      fail(`${where}.quota.provider`, `暂不支持 "${provider}"，可用值：volcengine-afp`);
    }
    quota = {
      provider,
      region: asString(quotaRaw.region, `${where}.quota.region`, "cn-beijing"),
      accessKey: asString(quotaRaw.accessKey, `${where}.quota.accessKey`),
      secretKey: asString(quotaRaw.secretKey, `${where}.quota.secretKey`),
      minRemainingPct: asNumber(quotaRaw.minRemainingPct, `${where}.quota.minRemainingPct`, 5, 0, 100),
    };
  }

  return {
    id,
    name: asString(o.name, `${where}.name`) || id,
    baseUrl: normalizeBaseUrl(asString(o.baseUrl, `${where}.baseUrl`, ""), `${where}.baseUrl`),
    apiKey: asString(o.apiKey, `${where}.apiKey`),
    models: asStringArray(o.models, `${where}.models`, ["*"]),
    priority: asNumber(o.priority, `${where}.priority`, 50, 0, 1_000_000),
    concurrency: Math.round(asNumber(o.concurrency, `${where}.concurrency`, 8, 1, 10_000)),
    enabled: asBool(o.enabled, `${where}.enabled`, true),
    quota,
  };
}

export function normalizeKey(raw: unknown, index: number): DownstreamKey {
  const where = `keys[${index}]`;
  const o = asObject(raw, where);
  const id = asString(o.id, `${where}.id`) || `k_${index}`;
  return {
    id,
    name: asString(o.name, `${where}.name`) || id,
    key: asString(o.key, `${where}.key`),
    enabled: asBool(o.enabled, `${where}.enabled`, true),
    limits: normalizeKeyLimits(o.limits, `${where}.limits`),
  };
}

export function normalizeConfig(raw: unknown): Config {
  const o = raw ? asObject(raw, "config") : {};
  const upstreams = o.upstreams == null ? [] : o.upstreams;
  const keys = o.keys == null ? [] : o.keys;
  if (!Array.isArray(upstreams)) fail("upstreams", "应为数组");
  if (!Array.isArray(keys)) fail("keys", "应为数组");

  const parsedUpstreams = upstreams.map(normalizeUpstream);
  const parsedKeys = keys.map(normalizeKey);

  const upIds = new Set<string>();
  for (const u of parsedUpstreams) {
    if (upIds.has(u.id)) fail("upstreams", `id 重复: ${u.id}`);
    upIds.add(u.id);
  }
  const keyIds = new Set<string>();
  for (const k of parsedKeys) {
    if (keyIds.has(k.id)) fail("keys", `id 重复: ${k.id}`);
    keyIds.add(k.id);
  }

  return {
    version: CONFIG_VERSION,
    settings: normalizeSettings(o.settings),
    upstreams: parsedUpstreams,
    keys: parsedKeys,
  };
}