import type { Config, DownstreamKey, QuotaSnapshot, Upstream } from "./types";
import { modelAllowed } from "./types";

/**
 * 调度器。全部状态在内存里，Node 单线程执行，所以「选号 + 占槽」是原子的。
 *
 * 打分思路借鉴 sub2api：优先级 / 负载 / 额度余量 / 错误率四项加权，
 * 再对粘性会话加分，最后在 topK 里加权随机，避免所有请求同时打向同一个上游。
 */

export interface UpstreamState {
  inflight: number;
  cooldownUntil: number;
  cooldownReason: string;
  /** 错误率 EWMA，0-1 */
  errEwma: number;
  consecutiveFails: number;
  successTotal: number;
  failTotal: number;
  lastStatus: number;
  lastLatencyMs: number;
  quota: QuotaSnapshot | null;
}

export interface KeyState {
  inflight: number;
  /** 最近一分钟的请求时间戳，用于 rpm 滑窗 */
  hits: number[];
}

type Runtime = {
  upstreams: Map<string, UpstreamState>;
  keys: Map<string, KeyState>;
  sticky: Map<string, { upId: string; at: number }>;
};

const g = globalThis as unknown as { __aiProxyRuntime?: Runtime };
const runtime: Runtime = (g.__aiProxyRuntime ??= {
  upstreams: new Map(),
  keys: new Map(),
  sticky: new Map(),
});

const STICKY_MAX_ENTRIES = 50_000;

function freshUpstreamState(): UpstreamState {
  return {
    inflight: 0,
    cooldownUntil: 0,
    cooldownReason: "",
    errEwma: 0,
    consecutiveFails: 0,
    successTotal: 0,
    failTotal: 0,
    lastStatus: 0,
    lastLatencyMs: 0,
    quota: null,
  };
}

export function upState(id: string): UpstreamState {
  let s = runtime.upstreams.get(id);
  if (!s) {
    s = freshUpstreamState();
    runtime.upstreams.set(id, s);
  }
  return s;
}

function keyState(id: string): KeyState {
  let s = runtime.keys.get(id);
  if (!s) {
    s = { inflight: 0, hits: [] };
    runtime.keys.set(id, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// 冷却与健康度
// ---------------------------------------------------------------------------

export function markCooldown(upId: string, durationMs: number, reason: string, now = Date.now()): void {
  const s = upState(upId);
  const until = now + Math.max(0, durationMs);
  // 已有更长的冷却就不缩短
  if (until > s.cooldownUntil) {
    s.cooldownUntil = until;
    s.cooldownReason = reason;
  }
}

export function markSuccess(upId: string, latencyMs: number, now = Date.now()): void {
  const s = upState(upId);
  s.successTotal += 1;
  s.consecutiveFails = 0;
  s.errEwma = s.errEwma * 0.7;
  s.lastLatencyMs = latencyMs;
  s.lastStatus = 200;
  if (s.cooldownUntil && s.cooldownUntil <= now) {
    s.cooldownUntil = 0;
    s.cooldownReason = "";
  }
}

export function markFailure(upId: string, status: number): number {
  const s = upState(upId);
  s.failTotal += 1;
  s.consecutiveFails += 1;
  s.errEwma = Math.min(1, s.errEwma * 0.7 + 0.3);
  s.lastStatus = status;
  return s.consecutiveFails;
}

export function setQuota(upId: string, snapshot: QuotaSnapshot): void {
  upState(upId).quota = snapshot;
}

export function clearCooldown(upId: string): void {
  const s = upState(upId);
  s.cooldownUntil = 0;
  s.cooldownReason = "";
  s.consecutiveFails = 0;
  s.errEwma = 0;
}

// ---------------------------------------------------------------------------
// 粘性会话
// ---------------------------------------------------------------------------

export function stickyGet(hash: string, ttlMin: number, now = Date.now()): string | null {
  if (!hash || ttlMin <= 0) return null;
  const hit = runtime.sticky.get(hash);
  if (!hit) return null;
  if (now - hit.at > ttlMin * 60_000) {
    runtime.sticky.delete(hash);
    return null;
  }
  return hit.upId;
}

export function stickySet(hash: string, upId: string, now = Date.now()): void {
  if (!hash) return;
  if (runtime.sticky.size > STICKY_MAX_ENTRIES) {
    // 简单粗暴地清掉最早的 10%，避免无界增长
    const drop = Math.floor(STICKY_MAX_ENTRIES * 0.1);
    let i = 0;
    for (const k of runtime.sticky.keys()) {
      runtime.sticky.delete(k);
      if (++i >= drop) break;
    }
  }
  runtime.sticky.set(hash, { upId, at: now });
}

// ---------------------------------------------------------------------------
// 下游 key 限流
// ---------------------------------------------------------------------------

/** rpm 滑窗检查。返回 null 表示放行，否则返回剩余需要等待的毫秒数。 */
export function keyRpmWait(key: DownstreamKey, now = Date.now()): number | null {
  const rpm = key.limits.rpm;
  if (!rpm) return null;
  const s = keyState(key.id);
  const cutoff = now - 60_000;
  s.hits = s.hits.filter((t) => t > cutoff);
  if (s.hits.length < rpm) return null;
  const oldest = s.hits[0];
  return Math.max(1, oldest + 60_000 - now);
}

export function keyAcquire(key: DownstreamKey): boolean {
  const limit = key.limits.concurrency;
  const s = keyState(key.id);
  if (limit && s.inflight >= limit) return false;
  s.inflight += 1;
  s.hits.push(Date.now());
  return true;
}

export function keyRelease(keyId: string): void {
  const s = keyState(keyId);
  s.inflight = Math.max(0, s.inflight - 1);
}

export function keyInflight(keyId: string): number {
  return runtime.keys.get(keyId)?.inflight ?? 0;
}

// ---------------------------------------------------------------------------
// 选号
// ---------------------------------------------------------------------------

export type PickResult =
  | { up: Upstream; state: UpstreamState; stickyHit: boolean }
  | { up: null; reason: "no_upstream" | "no_model" | "all_cooling" | "all_busy" | "quota_exhausted" };

function quotaBlocks(up: Upstream, s: UpstreamState): boolean {
  if (!up.quota || !s.quota) return false;
  if (s.quota.error) return false;
  return s.quota.remainingPct < up.quota.minRemainingPct;
}

function quotaFactor(up: Upstream, s: UpstreamState): number {
  if (!up.quota) return 1;
  if (!s.quota) return 1; // 还没拉到数据，按满额处理
  if (s.quota.error) return 1;
  return Math.max(0, Math.min(1, s.quota.remainingPct / 100));
}

function weightedPick(candidates: { up: Upstream; state: UpstreamState; score: number }[]) {
  const total = candidates.reduce((sum, c) => sum + Math.max(0.01, c.score), 0);
  let r = Math.random() * total;
  for (const c of candidates) {
    r -= Math.max(0.01, c.score);
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1];
}

/**
 * 选出上游并占用一个并发槽。调用方必须在结束后 releaseUpstream。
 * exclude 用于重试时排除已经失败过的上游。
 */
export function selectAndAcquire(
  config: Config,
  model: string,
  sessionHash: string,
  exclude: ReadonlySet<string> = new Set(),
  now = Date.now(),
): PickResult {
  const { weights, stickyTtlMin } = config.settings;
  const stickyUpId = stickyGet(sessionHash, stickyTtlMin, now);

  const enabled = config.upstreams.filter((u) => u.enabled && !exclude.has(u.id));
  if (enabled.length === 0) {
    return { up: null, reason: config.upstreams.length === 0 ? "no_upstream" : "no_upstream" };
  }

  const forModel = enabled.filter((u) => modelAllowed(u.models, model));
  if (forModel.length === 0) return { up: null, reason: "no_model" };

  const available = forModel.filter((u) => {
    const s = upState(u.id);
    return s.cooldownUntil <= now && !quotaBlocks(u, s) && s.inflight < u.concurrency;
  });
  if (available.length === 0) {
    const anyCooling = forModel.some((u) => upState(u.id).cooldownUntil > now);
    const anyQuota = forModel.some((u) => quotaBlocks(u, upState(u.id)));
    if (anyCooling || anyQuota) return { up: null, reason: anyQuota ? "quota_exhausted" : "all_cooling" };
    return { up: null, reason: "all_busy" };
  }

  const priorities = available.map((u) => u.priority);
  const pMin = Math.min(...priorities);
  const pMax = Math.max(...priorities);

  // 粘性会话是确定性优先，不参与加权抽签：同一对话必须落在同一上游，
  // 否则上游的 KV cache 全废，这一步比均衡更重要。
  // 粘性上游冷却、并发满、额度见底时已经不在 available 里，自然就退出了。
  if (stickyUpId) {
    const stickyCandidate = available.find((u) => u.id === stickyUpId);
    if (stickyCandidate) {
      const s = upState(stickyCandidate.id);
      s.inflight += 1;
      stickySet(sessionHash, stickyCandidate.id, now);
      return { up: stickyCandidate, state: s, stickyHit: true };
    }
  }

  const scored = available.map((u) => {
    const s = upState(u.id);
    const priorityFactor = pMax > pMin ? 1 - (u.priority - pMin) / (pMax - pMin) : 1;
    const loadFactor = 1 - Math.min(1, s.inflight / u.concurrency);
    const score =
      weights.priority * priorityFactor +
      weights.load * loadFactor +
      weights.quota * quotaFactor(u, s) +
      weights.errorRate * (1 - s.errEwma);
    return { up: u, state: s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topK = Math.max(1, Math.min(weights.topK, scored.length));
  const chosen = weightedPick(scored.slice(0, topK));

  chosen.state.inflight += 1;
  if (sessionHash) stickySet(sessionHash, chosen.up.id, now);
  return { up: chosen.up, state: chosen.state, stickyHit: false };
}

export function releaseUpstream(upId: string): void {
  const s = runtime.upstreams.get(upId);
  if (s) s.inflight = Math.max(0, s.inflight - 1);
}

/** 给管理端用的运行时快照。 */
export function upstreamSnapshot(): Record<string, Omit<UpstreamState, "quota"> & { quota: QuotaSnapshot | null }> {
  const out: Record<string, UpstreamState> = {};
  for (const [id, s] of runtime.upstreams) out[id] = { ...s, quota: s.quota };
  return out;
}

/** 配置重载后清掉已经不存在的上游的运行时状态。 */
export function pruneRuntime(config: Config): void {
  const ids = new Set(config.upstreams.map((u) => u.id));
  for (const id of runtime.upstreams.keys()) if (!ids.has(id)) runtime.upstreams.delete(id);
  const keyIds = new Set(config.keys.map((k) => k.id));
  for (const id of runtime.keys.keys()) if (!keyIds.has(id)) runtime.keys.delete(id);
}