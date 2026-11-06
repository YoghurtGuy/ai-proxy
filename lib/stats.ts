import { promises as fs } from "node:fs";
import path from "node:path";
import { LOG_DIR, USAGE_PATH, enqueue, writeJsonAtomic } from "./store";
import { emptyBucket, type Bucket, type RequestLogLine, type UsageFile } from "./types";

/**
 * 用量统计：内存里聚合 + 防抖原子落盘，明细按天写 JSONL。
 * 不记录 prompt/completion 正文，只记元数据和 token 数。
 */

const FLUSH_DEBOUNCE_MS = 3000;
const RECENT_MINUTES = 120;

export interface MinuteBucket {
  req: number;
  err: number;
  pt: number;
  ct: number;
}

type StatsState = {
  usage: UsageFile;
  loaded: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** 待写入的 JSONL 行，攒够或超时再一次性 append */
  pendingLines: string[];
  pendingTimer: ReturnType<typeof setTimeout> | null;
  recent: Map<number, MinuteBucket>;
};

const g = globalThis as unknown as { __aiProxyStats?: StatsState };
const state: StatsState = (g.__aiProxyStats ??= {
  usage: { version: 1, days: {} },
  loaded: false,
  dirty: false,
  timer: null,
  pendingLines: [],
  pendingTimer: null,
  recent: new Map(),
});

export function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 读取 usage.json 到内存。文件不存在就当作空。 */
export async function loadUsage(): Promise<void> {
  if (state.loaded) return;
  try {
    const text = await fs.readFile(USAGE_PATH, "utf8");
    const parsed = JSON.parse(text) as UsageFile;
    if (parsed && typeof parsed === "object" && parsed.days && typeof parsed.days === "object") {
      state.usage = { version: 1, days: parsed.days };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[stats] usage.json 读取失败，按空统计启动:", (err as Error).message);
    }
  }
  state.loaded = true;
}

function bucketOf(day: string, dim: string): Bucket {
  const dayMap = (state.usage.days[day] ??= {});
  return (dayMap[dim] ??= emptyBucket());
}

function addTo(bucket: Bucket, line: RequestLogLine): void {
  bucket.req += 1;
  if (line.status >= 400 || line.err) bucket.err += 1;
  bucket.pt += line.pt;
  bucket.ct += line.ct;
  bucket.msSum += line.ms;
  if (line.ttftMs > 0) {
    bucket.ttftSum += line.ttftMs;
    bucket.ttftN += 1;
  }
}

function scheduleFlush(): void {
  state.dirty = true;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushUsage();
  }, FLUSH_DEBOUNCE_MS);
  state.timer.unref?.();
}

export async function flushUsage(): Promise<void> {
  if (!state.dirty) return;
  state.dirty = false;
  const snapshot = state.usage;
  await enqueue(() => writeJsonAtomic(USAGE_PATH, snapshot)).catch((err) => {
    state.dirty = true;
    console.error("[stats] usage.json 写入失败:", (err as Error).message);
  });
}

function scheduleLogFlush(): void {
  if (state.pendingTimer) return;
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null;
    void flushLogs();
  }, 1000);
  state.pendingTimer.unref?.();
}

export async function flushLogs(): Promise<void> {
  if (state.pendingLines.length === 0) return;
  const lines = state.pendingLines.join("");
  state.pendingLines = [];
  const file = path.join(LOG_DIR, `${localDateKey()}.jsonl`);
  await enqueue(async () => {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(file, lines, "utf8");
  }).catch((err) => {
    console.error("[stats] 明细日志写入失败:", (err as Error).message);
  });
}

/** 记一条请求。同步更新内存，落盘异步。 */
export function recordRequest(line: RequestLogLine): void {
  const day = localDateKey(new Date(line.ts));
  addTo(bucketOf(day, "total"), line);
  addTo(bucketOf(day, `upstream:${line.upId}`), line);
  addTo(bucketOf(day, `key:${line.keyId}`), line);
  addTo(bucketOf(day, `model:${line.model}`), line);

  const minute = Math.floor(line.ts / 60_000);
  let mb = state.recent.get(minute);
  if (!mb) {
    mb = { req: 0, err: 0, pt: 0, ct: 0 };
    state.recent.set(minute, mb);
  }
  mb.req += 1;
  if (line.status >= 400 || line.err) mb.err += 1;
  mb.pt += line.pt;
  mb.ct += line.ct;
  if (state.recent.size > RECENT_MINUTES) {
    const keys = [...state.recent.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - RECENT_MINUTES)) state.recent.delete(k);
  }

  state.pendingLines.push(JSON.stringify(line) + "\n");
  scheduleFlush();
  if (state.pendingLines.length >= 200) void flushLogs();
  else scheduleLogFlush();
}

/** 当日某维度已经用掉的量，用于下游 key 的日限额判断。 */
export function usedToday(dim: string): { req: number; tokens: number } {
  const b = state.usage.days[localDateKey()]?.[dim];
  if (!b) return { req: 0, tokens: 0 };
  return { req: b.req, tokens: b.pt + b.ct };
}

export interface RecentPoint {
  minute: number;
  req: number;
  err: number;
  pt: number;
  ct: number;
}

export function recentSeries(minutes = 60, now = Date.now()): RecentPoint[] {
  const current = Math.floor(now / 60_000);
  const out: RecentPoint[] = [];
  for (let i = minutes - 1; i >= 0; i--) {
    const minute = current - i;
    const b = state.recent.get(minute);
    out.push({ minute, req: b?.req ?? 0, err: b?.err ?? 0, pt: b?.pt ?? 0, ct: b?.ct ?? 0 });
  }
  return out;
}

export function todayBuckets(): Record<string, Bucket> {
  return state.usage.days[localDateKey()] ?? {};
}

/** 把累加桶换算成展示用的指标（含均值）。 */
export interface Summary {
  req: number;
  err: number;
  pt: number;
  ct: number;
  tokens: number;
  avgTtftMs: number;
  avgMs: number;
}

export function summarize(bucket?: Bucket): Summary {
  const b = bucket ?? emptyBucket();
  return {
    req: b.req,
    err: b.err,
    pt: b.pt,
    ct: b.ct,
    tokens: b.pt + b.ct,
    avgTtftMs: b.ttftN ? Math.round(b.ttftSum / b.ttftN) : 0,
    avgMs: b.req ? Math.round(b.msSum / b.req) : 0,
  };
}

export function bucketFor(day: string, dim: string): Bucket | undefined {
  return state.usage.days[day]?.[dim];
}

export function dayKeys(): string[] {
  return Object.keys(state.usage.days).sort().reverse();
}

// ---------------------------------------------------------------------------
// 明细日志读取与清理
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 4 * 1024 * 1024;

/** 从最近几天的明细里取最新的若干条。 */
export async function readLogs(limit = 200, filter?: { keyId?: string; upId?: string; status?: string }): Promise<RequestLogLine[]> {
  const out: RequestLogLine[] = [];
  let day = new Date();
  for (let i = 0; i < 3 && out.length < limit; i++) {
    const file = path.join(LOG_DIR, `${localDateKey(day)}.jsonl`);
    day = new Date(day.getTime() - 86_400_000);
    let text: string;
    try {
      const stat = await fs.stat(file);
      const start = Math.max(0, stat.size - MAX_READ_BYTES);
      const fh = await fs.open(file, "r");
      try {
        const buf = Buffer.alloc(stat.size - start);
        await fh.read(buf, 0, buf.length, start);
        text = buf.toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    const lines = text.split("\n");
    // 从后往前，跳过可能被截断的首行
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i].trim();
      if (!raw) continue;
      if (i === 0 && text.length >= MAX_READ_BYTES) break;
      let parsed: RequestLogLine;
      try {
        parsed = JSON.parse(raw) as RequestLogLine;
      } catch {
        continue;
      }
      if (filter?.keyId && parsed.keyId !== filter.keyId) continue;
      if (filter?.upId && parsed.upId !== filter.upId) continue;
      if (filter?.status === "error" && !(parsed.status >= 400 || parsed.err)) continue;
      if (filter?.status === "ok" && (parsed.status >= 400 || parsed.err)) continue;
      out.push(parsed);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 删掉超过保留期的明细文件。启动时和每日跑一次。 */
export async function cleanupOldLogs(retentionDays: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fs.readdir(LOG_DIR);
  } catch {
    return 0;
  }
  const cutoff = now - retentionDays * 86_400_000;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const datePart = name.slice(0, 10);
    const ts = Date.parse(`${datePart}T00:00:00`);
    if (!Number.isFinite(ts)) continue;
    if (ts < cutoff) {
      await fs.unlink(path.join(LOG_DIR, name)).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}