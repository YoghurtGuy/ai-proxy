import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { Bucket, Config, RequestLogLine } from "./types";

/**
 * 异步批量写入 MySQL：
 * - 转发链路零阻塞：只入内存缓冲队列，按条数 / 字节 / 定时批量刷盘。
 * - 冷热分表：request_logs 存轻量化元数据；request_bodies 存 gzip 压缩后的输入输出正文。
 * - 背压保护：队列超过 MAX_QUEUE_BYTES 时优先丢弃正文，绝不拖垮主进程内存。
 */

export interface TraceBodyInput {
  req: string;
  resp: string;
  truncated: boolean;
}

export interface LogDetail {
  log: RequestLogLine;
  req: string | null;
  resp: string | null;
  truncated: boolean;
}

interface QueuedEntry {
  line: RequestLogLine;
  body: TraceBodyInput | null;
  bytes: number;
}

interface MysqlState {
  pool: Pool | null;
  ready: boolean;
  initPromise: Promise<boolean> | null;
  queue: QueuedEntry[];
  queueBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
}

const FLUSH_ITEMS = 100;
const FLUSH_BYTES = 2 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 1500;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const META_ESTIMATE_BYTES = 256;

const g = globalThis as unknown as { __aiProxyMysql?: MysqlState };
const state: MysqlState = (g.__aiProxyMysql ??= {
  pool: null,
  ready: false,
  initPromise: null,
  queue: [],
  queueBytes: 0,
  flushTimer: null,
  flushing: null,
});

export function isMysqlConfigured(): boolean {
  return Boolean(process.env.MYSQL_URL?.trim());
}

/** 生成 26 位按时间有序的唯一 ID（12 位 base36 时间戳 + 14 位随机 base36）。 */
export function generateLogId(ts = Date.now()): string {
  const timePart = Math.max(0, Math.floor(ts)).toString(36).padStart(12, "0").slice(-12);
  let randPart = "";
  for (let i = 0; i < 14; i++) {
    randPart += crypto.randomInt(36).toString(36);
  }
  return timePart + randPart;
}

const CREATE_LOGS_SQL = `
CREATE TABLE IF NOT EXISTS request_logs (
  id        CHAR(26) PRIMARY KEY,
  ts        BIGINT NOT NULL,
  key_id    VARCHAR(64) NOT NULL,
  up_id     VARCHAR(64) NOT NULL,
  model     VARCHAR(128) NOT NULL,
  status    SMALLINT NOT NULL,
  stream    TINYINT(1) NOT NULL DEFAULT 0,
  pt        INT NOT NULL DEFAULT 0,
  ct        INT NOT NULL DEFAULT 0,
  cached_pt INT NOT NULL DEFAULT 0,
  ttft_ms   INT NOT NULL DEFAULT 0,
  ms        INT NOT NULL DEFAULT 0,
  retries   TINYINT NOT NULL DEFAULT 0,
  err       VARCHAR(512) NULL,
  has_body  TINYINT(1) NOT NULL DEFAULT 0,
  INDEX idx_ts (ts DESC),
  INDEX idx_key_ts (key_id, ts DESC),
  INDEX idx_up_ts (up_id, ts DESC),
  INDEX idx_model_ts (model, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const CREATE_BODIES_SQL = `
CREATE TABLE IF NOT EXISTS request_bodies (
  log_id    CHAR(26) PRIMARY KEY,
  ts        BIGINT NOT NULL,
  req_gz    MEDIUMBLOB NULL,
  resp_gz   MEDIUMBLOB NULL,
  truncated TINYINT(1) NOT NULL DEFAULT 0,
  INDEX idx_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const CREATE_CONFIG_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
  k          VARCHAR(64) PRIMARY KEY,
  value      LONGTEXT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const CREATE_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS usage_daily (
  day       CHAR(10) NOT NULL,
  dim       VARCHAR(160) NOT NULL,
  req       BIGINT NOT NULL DEFAULT 0,
  err       BIGINT NOT NULL DEFAULT 0,
  pt        BIGINT NOT NULL DEFAULT 0,
  ct        BIGINT NOT NULL DEFAULT 0,
  cached_pt BIGINT NOT NULL DEFAULT 0,
  ttft_sum  BIGINT NOT NULL DEFAULT 0,
  ttft_n    BIGINT NOT NULL DEFAULT 0,
  ms_sum    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim),
  INDEX idx_day (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

async function ensureDatabaseExists(url: string): Promise<void> {
  const parsed = new URL(url);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
    throw new Error(`非法数据库名: ${dbName}`);
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = "/";
  const conn = await mysql.createConnection(adminUrl.toString());
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end();
  }
}

export async function initMysql(): Promise<boolean> {
  const url = process.env.MYSQL_URL?.trim();
  if (!url) return false;
  if (state.ready && state.pool) return true;
  if (state.initPromise) return state.initPromise;

  state.initPromise = (async () => {
    try {
      const pool =
        state.pool ??
        mysql.createPool({
          uri: url,
          connectionLimit: 4,
          queueLimit: 20,
          waitForConnections: true,
          connectTimeout: 5000,
          enableKeepAlive: true,
        });
      state.pool = pool;
      try {
        await pool.query(CREATE_LOGS_SQL);
      } catch (err) {
        const dbErr = err as { code?: string; errno?: number };
        if (dbErr.code === "ER_BAD_DB_ERROR" || dbErr.errno === 1049) {
          await ensureDatabaseExists(url);
          await pool.query(CREATE_LOGS_SQL);
        } else {
          throw err;
        }
      }
      await pool.query(CREATE_BODIES_SQL);
      await pool.query(CREATE_CONFIG_SQL);
      await pool.query(CREATE_USAGE_SQL);
      state.ready = true;
      return true;
    } catch (err) {
      console.error("[mysql] 初始化失败:", (err as Error).message);
      await state.pool?.end().catch(() => undefined);
      state.pool = null;
      state.ready = false;
      return false;
    } finally {
      state.initPromise = null;
    }
  })();

  return state.initPromise;
}

interface ConfigRow extends RowDataPacket {
  value: string;
}

export async function loadMysqlConfig(): Promise<unknown | null> {
  const ok = await initMysql();
  if (!ok || !state.pool) throw new Error("MySQL 未就绪");
  const [rows] = await state.pool.query<ConfigRow[]>(
    "SELECT value FROM app_config WHERE k = 'main' LIMIT 1",
  );
  if (rows.length === 0) return null;
  return JSON.parse(rows[0].value);
}

export async function saveMysqlConfig(config: Config): Promise<void> {
  const ok = await initMysql();
  if (!ok || !state.pool) throw new Error("MySQL 未就绪");
  await state.pool.query(
    "INSERT INTO app_config (k, value, updated_at) VALUES ('main', ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
    [JSON.stringify(config), Date.now()],
  );
}

interface UsageRow extends RowDataPacket {
  day: string;
  dim: string;
  req: number | string;
  err: number | string;
  pt: number | string;
  ct: number | string;
  cached_pt: number | string;
  ttft_sum: number | string;
  ttft_n: number | string;
  ms_sum: number | string;
}

export async function loadMysqlUsage(): Promise<Record<string, Record<string, Bucket>>> {
  const ok = await initMysql();
  if (!ok || !state.pool) throw new Error("MySQL 未就绪");
  const [rows] = await state.pool.query<UsageRow[]>(
    "SELECT day, dim, req, err, pt, ct, cached_pt, ttft_sum, ttft_n, ms_sum FROM usage_daily",
  );
  const days: Record<string, Record<string, Bucket>> = {};
  for (const r of rows) {
    const dayMap = (days[r.day] ??= {});
    const cachedPt = Number(r.cached_pt) || 0;
    dayMap[r.dim] = {
      req: Number(r.req) || 0,
      err: Number(r.err) || 0,
      pt: Number(r.pt) || 0,
      ct: Number(r.ct) || 0,
      ...(cachedPt > 0 ? { cachedPt } : {}),
      ttftSum: Number(r.ttft_sum) || 0,
      ttftN: Number(r.ttft_n) || 0,
      msSum: Number(r.ms_sum) || 0,
    };
  }
  return days;
}

export async function upsertMysqlUsageBuckets(
  entries: { day: string; dim: string; bucket: Bucket }[],
): Promise<void> {
  if (entries.length === 0) return;
  const ok = await initMysql();
  if (!ok || !state.pool) throw new Error("MySQL 未就绪");

  const sql = `INSERT INTO usage_daily (day, dim, req, err, pt, ct, cached_pt, ttft_sum, ttft_n, ms_sum)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      req = VALUES(req),
      err = VALUES(err),
      pt = VALUES(pt),
      ct = VALUES(ct),
      cached_pt = VALUES(cached_pt),
      ttft_sum = VALUES(ttft_sum),
      ttft_n = VALUES(ttft_n),
      ms_sum = VALUES(ms_sum)`;

  for (let i = 0; i < entries.length; i += 500) {
    const rows = entries.slice(i, i + 500).map(({ day, dim, bucket }) => [
      day.slice(0, 10),
      dim.slice(0, 160),
      bucket.req,
      bucket.err,
      bucket.pt,
      bucket.ct,
      bucket.cachedPt ?? 0,
      bucket.ttftSum,
      bucket.ttftN,
      bucket.msSum,
    ]);
    await state.pool.query(sql, [rows]);
  }
}

function scheduleFlush(): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flushMysqlLogs();
  }, FLUSH_INTERVAL_MS);
  state.flushTimer.unref?.();
}

export function enqueueMysqlLog(line: RequestLogLine, body?: TraceBodyInput | null): void {
  if (!isMysqlConfigured()) return;

  let entryBody = body ?? null;
  let bytes =
    META_ESTIMATE_BYTES +
    (entryBody ? Buffer.byteLength(entryBody.req, "utf8") + Buffer.byteLength(entryBody.resp, "utf8") : 0);

  if (state.queueBytes + bytes > MAX_QUEUE_BYTES) {
    // 队列接近上限时先丢弃新记录的正文，保住轻量元数据和主进程内存
    if (entryBody) {
      entryBody = null;
      bytes = META_ESTIMATE_BYTES;
    }
    while (state.queue.length > 0 && state.queueBytes + bytes > MAX_QUEUE_BYTES) {
      const dropped = state.queue.shift()!;
      state.queueBytes = Math.max(0, state.queueBytes - dropped.bytes);
    }
  }

  const normalizedLine: RequestLogLine = {
    ...line,
    id: line.id ?? generateLogId(line.ts),
    hasBody: Boolean(entryBody),
  };

  state.queue.push({ line: normalizedLine, body: entryBody, bytes });
  state.queueBytes += bytes;

  if (state.queue.length >= FLUSH_ITEMS || state.queueBytes >= FLUSH_BYTES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    void flushMysqlLogs();
  } else {
    scheduleFlush();
  }
}

async function flushOnce(): Promise<void> {
  if (state.queue.length === 0) return;
  const ok = await initMysql();
  if (!ok || !state.pool) {
    // MySQL 暂不可用时清空缓冲避免内存无界滞留
    state.queue = [];
    state.queueBytes = 0;
    return;
  }

  while (state.queue.length > 0) {
    const batch = state.queue.splice(0, FLUSH_ITEMS);
    let batchBytes = 0;
    for (const item of batch) batchBytes += item.bytes;
    state.queueBytes = Math.max(0, state.queueBytes - batchBytes);

    const logRows = batch.map(({ line, body }) => [
      line.id ?? generateLogId(line.ts),
      line.ts,
      line.keyId.slice(0, 64),
      line.upId.slice(0, 64),
      line.model.slice(0, 128),
      line.status,
      line.stream ? 1 : 0,
      line.pt,
      line.ct,
      line.cachedPt ?? 0,
      line.ttftMs,
      line.ms,
      Math.min(127, Math.max(0, line.retries)),
      line.err ? line.err.slice(0, 512) : null,
      body ? 1 : 0,
    ]);

    const bodyRows: unknown[][] = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (!item.body) continue;
      const logId = logRows[i][0] as string;
      const reqGz = item.body.req ? gzipSync(Buffer.from(item.body.req, "utf8")) : null;
      const respGz = item.body.resp ? gzipSync(Buffer.from(item.body.resp, "utf8")) : null;
      bodyRows.push([logId, item.line.ts, reqGz, respGz, item.body.truncated ? 1 : 0]);
    }

    try {
      await state.pool.query(
        "INSERT INTO request_logs (id, ts, key_id, up_id, model, status, stream, pt, ct, cached_pt, ttft_ms, ms, retries, err, has_body) VALUES ?",
        [logRows],
      );
      if (bodyRows.length > 0) {
        await state.pool.query(
          "INSERT INTO request_bodies (log_id, ts, req_gz, resp_gz, truncated) VALUES ?",
          [bodyRows],
        );
      }
    } catch (err) {
      console.error("[mysql] 批量写入日志失败:", (err as Error).message);
    }
  }
}

export async function flushMysqlLogs(): Promise<void> {
  if (state.flushing) return state.flushing;
  state.flushing = flushOnce().finally(() => {
    state.flushing = null;
  });
  return state.flushing;
}

interface LogRow extends RowDataPacket {
  id: string;
  ts: number | string;
  key_id: string;
  up_id: string;
  model: string;
  status: number;
  stream: number;
  pt: number;
  ct: number;
  cached_pt: number;
  ttft_ms: number;
  ms: number;
  retries: number;
  err: string | null;
  has_body: number;
}

function rowToLog(r: LogRow): RequestLogLine {
  return {
    id: r.id,
    ts: Number(r.ts),
    keyId: r.key_id,
    upId: r.up_id,
    model: r.model,
    status: Number(r.status),
    stream: Boolean(r.stream),
    pt: Number(r.pt),
    ct: Number(r.ct),
    cachedPt: Number(r.cached_pt) || undefined,
    ttftMs: Number(r.ttft_ms),
    ms: Number(r.ms),
    retries: Number(r.retries),
    err: r.err ?? null,
    hasBody: Boolean(r.has_body),
  };
}

export async function queryMysqlLogs(
  limit = 200,
  filter?: { keyId?: string; upId?: string; model?: string; status?: string },
): Promise<RequestLogLine[]> {
  const ok = await initMysql();
  if (!ok || !state.pool) return [];

  const where: string[] = [];
  const params: unknown[] = [];

  if (filter?.keyId) {
    where.push("key_id = ?");
    params.push(filter.keyId);
  }
  if (filter?.upId) {
    where.push("up_id = ?");
    params.push(filter.upId);
  }
  if (filter?.model) {
    where.push("model = ?");
    params.push(filter.model);
  }
  if (filter?.status === "error") {
    where.push("(status >= 400 OR err IS NOT NULL)");
  } else if (filter?.status === "ok") {
    where.push("(status < 400 AND err IS NULL)");
  }

  const sql = `SELECT id, ts, key_id, up_id, model, status, stream, pt, ct, cached_pt, ttft_ms, ms, retries, err, has_body
    FROM request_logs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ts DESC
    LIMIT ?`;
  params.push(limit);

  const [rows] = await state.pool.query<LogRow[]>(sql, params);
  return rows.map(rowToLog);
}

interface BodyRow extends RowDataPacket {
  req_gz: Buffer | Uint8Array | null;
  resp_gz: Buffer | Uint8Array | null;
  truncated: number;
}

function unzipField(raw: Buffer | Uint8Array | null): string | null {
  if (!raw || raw.length === 0) return null;
  try {
    return gunzipSync(Buffer.from(raw)).toString("utf8");
  } catch {
    return null;
  }
}

export async function getMysqlLogBody(id: string): Promise<LogDetail | null> {
  const ok = await initMysql();
  if (!ok || !state.pool) return null;

  const [logRows] = await state.pool.query<LogRow[]>(
    "SELECT id, ts, key_id, up_id, model, status, stream, pt, ct, cached_pt, ttft_ms, ms, retries, err, has_body FROM request_logs WHERE id = ? LIMIT 1",
    [id],
  );
  if (logRows.length === 0) return null;

  const [bodyRows] = await state.pool.query<BodyRow[]>(
    "SELECT req_gz, resp_gz, truncated FROM request_bodies WHERE log_id = ? LIMIT 1",
    [id],
  );

  const bodyRow = bodyRows[0];
  return {
    log: rowToLog(logRows[0]),
    req: bodyRow ? unzipField(bodyRow.req_gz) : null,
    resp: bodyRow ? unzipField(bodyRow.resp_gz) : null,
    truncated: bodyRow ? Boolean(bodyRow.truncated) : false,
  };
}

export async function cleanupMysqlLogs(retentionDays: number, now = Date.now()): Promise<number> {
  const ok = await initMysql();
  if (!ok || !state.pool) return 0;

  const cutoff = now - retentionDays * 86_400_000;
  let removed = 0;

  for (const table of ["request_bodies", "request_logs"] as const) {
    for (let round = 0; round < 50; round++) {
      const [res] = await state.pool.query<ResultSetHeader>(
        `DELETE FROM ${table} WHERE ts < ? LIMIT 2000`,
        [cutoff],
      );
      const affected = res.affectedRows ?? 0;
      if (table === "request_logs") removed += affected;
      if (affected < 2000) break;
    }
  }
  return removed;
}
