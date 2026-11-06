import { listAgentPlanModels, type AgentPlanModel } from "./quota/volcengine";
import type { Upstream } from "./types";

/**
 * 上游模型列表。三条来源，按代价从低到高尝试：
 *   1. 配置里显式写死的 models
 *   2. 数据面 GET /models（免费，但不是每家都有）
 *   3. 管控面 ListArkAgentPlanModel（需要 AK/SK，Agent Plan 专用）
 *
 * 结果带内存缓存：管控面接口有 QPS 限制，客户端可能频繁请求 /v1/models。
 */

const TTL_MS = 10 * 60_000;

export interface UpstreamModels {
  models: string[];
  source: "agent-plan" | "models-api" | "configured";
  /** Agent Plan 的完整结果，含可用性和负载，给管理端看 */
  detail?: AgentPlanModel[];
  error?: string;
}

type CacheEntry = UpstreamModels & { at: number };

const g = globalThis as unknown as { __aiProxyModelCache?: Map<string, CacheEntry> };
const cache = (g.__aiProxyModelCache ??= new Map());

/** Agent Plan 的入口没有 /models，直接跳过那一次必然 404 的探测。 */
function isAgentPlanEndpoint(baseUrl: string): boolean {
  return /\/api\/plan(\/v3)?$/.test(baseUrl.replace(/\/+$/, ""));
}

async function probeModelsEndpoint(base: string, apiKey: string): Promise<{ models: string[]; error?: string }> {
  try {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { models: [], error: `GET /models 返回 HTTP ${res.status}` };
    const parsed = (await res.json()) as { data?: { id?: unknown }[] };
    const models = (parsed.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string" && !!id);
    return { models };
  } catch (err) {
    return { models: [], error: `GET /models 失败: ${(err as Error).message}` };
  }
}

async function resolve(up: Upstream): Promise<UpstreamModels> {
  const base = up.baseUrl.replace(/\/+$/, "");
  const configured = up.models.filter((m) => m !== "*");

  // 1. 数据面 /models（Agent Plan 入口跳过）
  if (!isAgentPlanEndpoint(base)) {
    const probed = await probeModelsEndpoint(base, up.apiKey);
    if (probed.models.length > 0) return { models: probed.models, source: "models-api" };
    if (!up.quota?.accessKey) {
      return { models: configured, source: "configured", error: probed.error };
    }
  }

  // 2. 管控面 ListArkAgentPlanModel
  if (up.quota?.accessKey && up.quota.secretKey) {
    const plan = await listAgentPlanModels(up.quota);
    if (!("error" in plan)) {
      return {
        models: plan.models.filter((m) => m.available).map((m) => m.id),
        source: "agent-plan",
        detail: plan.models,
      };
    }
    return { models: configured, source: "configured", error: plan.error };
  }

  return { models: configured, source: "configured" };
}

export async function listUpstreamModels(
  up: Upstream,
  opts: { refresh?: boolean; now?: number } = {},
): Promise<UpstreamModels> {
  const now = opts.now ?? Date.now();
  if (!opts.refresh) {
    const hit = cache.get(up.id);
    if (hit && now - hit.at < TTL_MS) return hit;
  }
  const result = await resolve(up);
  cache.set(up.id, { ...result, at: now });
  return result;
}

/** 配置变更后清掉对应上游的缓存。 */
export function clearModelCache(upstreamId?: string): void {
  if (upstreamId) cache.delete(upstreamId);
  else cache.clear();
}