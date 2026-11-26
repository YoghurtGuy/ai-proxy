import { adminHandler } from "@/lib/admin";
import { isMysqlConfigured } from "@/lib/mysql";
import { keyInflight, upstreamSnapshot } from "@/lib/scheduler";
import { getTodayBuckets, recentSeries, summarize } from "@/lib/stats";
import { DATA_DIR, getConfig } from "@/lib/store";
import { calculateModelCost, canonicalModelName, findModelPricing, mergeBuckets, type Bucket } from "@/lib/types";

/** 仪表盘需要的所有数据一次给全，省得前端串行发一堆请求。 */
export async function GET(): Promise<Response> {
  return adminHandler(async () => {
    const config = await getConfig();
    const buckets = await getTodayBuckets();
    const runtime = upstreamSnapshot();

    const upstreams = config.upstreams.map((up) => {
      const state = runtime[up.id];
      return {
        id: up.id,
        name: up.name,
        enabled: up.enabled,
        models: up.models,
        priority: up.priority,
        concurrency: up.concurrency,
        hasQuota: Boolean(up.quota),
        minRemainingPct: up.quota?.minRemainingPct ?? 0,
        today: summarize(buckets[`upstream:${up.id}`]),
        runtime: {
          inflight: state?.inflight ?? 0,
          cooldownUntil: state?.cooldownUntil ?? 0,
          cooldownReason: state?.cooldownReason ?? "",
          errEwma: state?.errEwma ?? 0,
          successTotal: state?.successTotal ?? 0,
          failTotal: state?.failTotal ?? 0,
          lastStatus: state?.lastStatus ?? 0,
          lastLatencyMs: state?.lastLatencyMs ?? 0,
          quota: state?.quota ?? null,
        },
      };
    });

    const keys = config.keys.map((key) => ({
      id: key.id,
      name: key.name,
      key: key.key,
      enabled: key.enabled,
      limits: key.limits,
      today: summarize(buckets[`key:${key.id}`]),
      inflight: keyInflight(key.id),
    }));

    const mergedModels = new Map<string, Bucket>();
    for (const [dim, bucket] of Object.entries(buckets)) {
      if (!dim.startsWith("model:")) continue;
      const rawModel = dim.slice("model:".length).trim();
      if (!rawModel) continue;
      const canonical = canonicalModelName(rawModel);
      const prev = mergedModels.get(canonical);
      mergedModels.set(canonical, prev ? mergeBuckets(prev, bucket) : bucket);
    }

    const allModelEntries = [...mergedModels.entries()].map(([model, bucket]) => {
      const s = summarize(bucket);
      const pricing = findModelPricing(config.modelPrices, model);
      const cost = pricing ? calculateModelCost(s.pt, s.ct, s.cachedPt, pricing) : null;
      return { model, ...s, cost };
    });

    const totalCost = allModelEntries.reduce((sum, m) => sum + (m.cost ?? 0), 0);
    const pricedModels = allModelEntries.filter((m) => m.cost !== null).length;

    const modelEntries = allModelEntries.sort((a, b) => b.req - a.req).slice(0, 20);

    return Response.json({
      totals: { ...summarize(buckets.total), cost: totalCost, pricedModels },
      series: recentSeries(60),
      upstreams,
      keys,
      models: modelEntries,
      dataDir: isMysqlConfigured() ? "MySQL" : DATA_DIR,
      settings: config.settings,
    });
  });
}