import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeConfig, type Config } from "./types";

/**
 * 配置的唯一真相来源。启动时读一次进内存，之后所有读取都走内存，
 * 写入走「原子替换 + 串行队列」，避免半截文件。
 *
 * 注意：这是纯进程内状态，只支持单实例部署。
 */

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const USAGE_PATH = path.join(DATA_DIR, "usage.json");
export const LOG_DIR = path.join(DATA_DIR, "logs");

type StoreState = {
  config: Config | null;
  /** 写文件串行化，防止两个写入交错 */
  chain: Promise<unknown>;
  lastError: string | null;
};

const g = globalThis as unknown as { __aiProxyStore?: StoreState };
const state: StoreState = (g.__aiProxyStore ??= { config: null, chain: Promise.resolve(), lastError: null });

/** 串行执行写操作。任务失败不会阻塞后续任务。 */
export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = state.chain.then(task, task);
  state.chain = next.catch(() => undefined);
  return next;
}

/** 写临时文件再 rename，保证读到的永远是完整 JSON。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/** 等待所有挂起的写操作落地。进程退出时用。 */
export async function flushWrites(): Promise<void> {
  await state.chain.catch(() => undefined);
}

export function configPathLabel(): string {
  return CONFIG_PATH;
}

export function lastConfigError(): string | null {
  return state.lastError;
}

/** 从磁盘读取配置。文件不存在时写入一份空配置。 */
export async function loadConfig(): Promise<Config> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let text: string | null = null;
  try {
    text = await fs.readFile(CONFIG_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (text === null) {
    const fresh = normalizeConfig({});
    state.config = fresh;
    await enqueue(() => writeJsonAtomic(CONFIG_PATH, fresh));
    return fresh;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config.json 不是合法 JSON: ${(err as Error).message}`);
  }
  const config = normalizeConfig(parsed);
  state.config = config;
  state.lastError = null;
  return config;
}

/** 拿内存里的配置；未加载时同步加载一次。 */
export async function getConfig(): Promise<Config> {
  if (state.config) return state.config;
  return loadConfig();
}

export async function reloadConfig(): Promise<Config> {
  state.config = null;
  return loadConfig();
}

/**
 * 修改配置：mutator 拿到当前内存副本，返回新配置。
 * 校验通过才写盘并替换内存，失败时内存保持不变。
 */
export async function updateConfig(mutator: (draft: Config) => Config | void): Promise<Config> {
  const current = await getConfig();
  const draft = structuredClone(current);
  const result = mutator(draft) ?? draft;
  const normalized = normalizeConfig(result);
  state.config = normalized;
  await enqueue(() => writeJsonAtomic(CONFIG_PATH, normalized));
  return normalized;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

/** 下游 key：sk- 加 48 个字符，和 OpenAI 的长度一致。 */
export function newDownstreamKey(): string {
  return `sk-${crypto.randomBytes(24).toString("hex")}`;
}