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

export interface TrafficSettings {
  /** 是否启用突发流量处理与斜率保护 */
  enabled: boolean;
  /** 并发满时排队等待最大毫秒数，0 表示不排队直接拒绝 */
  burstQueueWaitMs: number;
  /** 排队队列上限（超出直接拒绝，防止内存堆积） */
  burstQueueMaxSize: number;
  /** 斜率保护统计窗口（秒），0 表示关闭斜率保护 */
  slopeWindowSec: number;
  /** 斜率保护：允许的周期增长比例（例如 0.5 表示 50%） */
  slopeMaxGrowthRatio: number;
  /** 斜率保护：上一窗口最小基线请求数（低于此值不做斜率限制） */
  slopeMinBaseline: number;
}

export interface TraceSettings {
  /** 是否记录请求输入与模型输出正文（配置 MYSQL_URL 时落库） */
  enabled: boolean;
  /** 单条输入或输出正文最大保留大小（KB） */
  maxBodyKb: number;
  /** 是否对超长 Base64 媒体内容脱敏替换（关闭则保留原图） */
  redactBase64: boolean;
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
  traffic: TrafficSettings;
  trace: TraceSettings;
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

export interface ModelPricing {
  /** 常规输入单价（元 / 百万 Token） */
  inputPerM: number;
  /** 缓存命中单价（元 / 百万 Token） */
  cachedInputPerM: number;
  /** 输出单价（元 / 百万 Token） */
  outputPerM: number;
}

export interface Config {
  version: number;
  settings: Settings;
  upstreams: Upstream[];
  keys: DownstreamKey[];
  modelPrices: Record<string, ModelPricing>;
}

/** 单个统计桶。ttftSum/ttftN 用于算首字延迟均值。 */
export interface Bucket {
  req: number;
  err: number;
  pt: number;
  ct: number;
  cachedPt?: number;
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
  id?: string;
  ts: number;
  keyId: string;
  upId: string;
  model: string;
  status: number;
  stream: boolean;
  pt: number;
  ct: number;
  cachedPt?: number;
  ttftMs: number;
  ms: number;
  retries: number;
  err: string | null;
  hasBody?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quotaPollSec: 300,
  cooldownDefaultSec: 5,
  cooldownMaxSec: 7200,
  stickyTtlMin: 30,
  maxAttempts: 3,
  logRetentionDays: 14,
  weights: { priority: 1, load: 1, quota: 1.5, errorRate: 0.8, topK: 3 },
  traffic: {
    enabled: true,
    burstQueueWaitMs: 3000,
    burstQueueMaxSize: 50,
    slopeWindowSec: 60,
    slopeMaxGrowthRatio: 0.5,
    slopeMinBaseline: 20,
  },
  trace: {
    enabled: true,
    maxBodyKb: 128,
    redactBase64: false,
  },
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
  return { version: CONFIG_VERSION, settings: { ...DEFAULT_SETTINGS }, upstreams: [], keys: [], modelPrices: {} };
}

/** 按模型单价（元 / 百万 Token）计算费用；pt 包含 cachedPt 时会自动扣除缓存命中部分。 */
export function calculateModelCost(pt: number, ct: number, cachedPt: number, pricing?: ModelPricing | null): number {
  if (!pricing) return 0;
  const cached = Math.max(0, Math.min(pt, cachedPt));
  const uncachedInput = Math.max(0, pt - cached);
  return (uncachedInput * pricing.inputPerM + cached * pricing.cachedInputPerM + ct * pricing.outputPerM) / 1_000_000;
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
  const t = o.traffic ? asObject(o.traffic, "settings.traffic") : {};
  const tr = o.trace ? asObject(o.trace, "settings.trace") : {};
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
    traffic: {
      enabled: asBool(t.enabled, "settings.traffic.enabled", d.traffic.enabled),
      burstQueueWaitMs: Math.round(
        asNumber(t.burstQueueWaitMs, "settings.traffic.burstQueueWaitMs", d.traffic.burstQueueWaitMs, 0, 60_000),
      ),
      burstQueueMaxSize: Math.round(
        asNumber(t.burstQueueMaxSize, "settings.traffic.burstQueueMaxSize", d.traffic.burstQueueMaxSize, 0, 10_000),
      ),
      slopeWindowSec: Math.round(
        asNumber(t.slopeWindowSec, "settings.traffic.slopeWindowSec", d.traffic.slopeWindowSec, 0, 3600),
      ),
      slopeMaxGrowthRatio: asNumber(
        t.slopeMaxGrowthRatio,
        "settings.traffic.slopeMaxGrowthRatio",
        d.traffic.slopeMaxGrowthRatio,
        0,
        100,
      ),
      slopeMinBaseline: Math.round(
        asNumber(t.slopeMinBaseline, "settings.traffic.slopeMinBaseline", d.traffic.slopeMinBaseline, 1, 1_000_000),
      ),
    },
    trace: {
      enabled: asBool(tr.enabled, "settings.trace.enabled", d.trace.enabled),
      maxBodyKb: Math.round(asNumber(tr.maxBodyKb, "settings.trace.maxBodyKb", d.trace.maxBodyKb, 4, 16384)),
      redactBase64: asBool(tr.redactBase64, "settings.trace.redactBase64", d.trace.redactBase64),
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
      accessKey: asString(quotaRaw.accessKey, `${where}.quota.accessKey`).trim(),
      secretKey: asString(quotaRaw.secretKey, `${where}.quota.secretKey`).trim(),
      minRemainingPct: asNumber(quotaRaw.minRemainingPct, `${where}.quota.minRemainingPct`, 5, 0, 100),
    };
  }

  return {
    id,
    name: asString(o.name, `${where}.name`) || id,
    baseUrl: normalizeBaseUrl(asString(o.baseUrl, `${where}.baseUrl`, ""), `${where}.baseUrl`),
    apiKey: asString(o.apiKey, `${where}.apiKey`).trim(),
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
    key: asString(o.key, `${where}.key`).trim(),
    enabled: asBool(o.enabled, `${where}.enabled`, true),
    limits: normalizeKeyLimits(o.limits, `${where}.limits`),
  };
}

export function normalizeModelPrices(raw: unknown): Record<string, ModelPricing> {
  if (raw == null) return {};
  const o = asObject(raw, "modelPrices");
  const out: Record<string, ModelPricing> = {};
  for (const [model, val] of Object.entries(o)) {
    const key = model.trim();
    if (!key) continue;
    const item = asObject(val, `modelPrices.${key}`);
    out[key] = {
      inputPerM: asNumber(item.inputPerM, `modelPrices.${key}.inputPerM`, 0, 0, 1_000_000),
      cachedInputPerM: asNumber(item.cachedInputPerM, `modelPrices.${key}.cachedInputPerM`, 0, 0, 1_000_000),
      outputPerM: asNumber(item.outputPerM, `modelPrices.${key}.outputPerM`, 0, 0, 1_000_000),
    };
  }
  return out;
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
    modelPrices: normalizeModelPrices(o.modelPrices),
  };
}