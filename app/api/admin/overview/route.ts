import { adminHandler } from "@/lib/admin";
import { keyInflight, upstreamSnapshot } from "@/lib/scheduler";
import { recentSeries, summarize, todayBuckets } from "@/lib/stats";
import { DATA_DIR, getConfig } from "@/lib/store";

/** 仪表盘需要的所有数据一次给全，省得前端串行发一堆请求。 */
export async function GET(): Promise<Response> {
  return adminHandler(async () => {
    const config = await getConfig();
    const buckets = todayBuckets();
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

    const modelEntries = Object.entries(buckets)
      .filter(([dim]) => dim.startsWith("model:"))
      .map(([dim, bucket]) => ({ model: dim.slice("model:".length), ...summarize(bucket) }))
      .sort((a, b) => b.req - a.req)
      .slice(0, 20);

    return Response.json({
      totals: summarize(buckets.total),
      series: recentSeries(60),
      upstreams,
      keys,
      models: modelEntries,
      dataDir: DATA_DIR,
      settings: config.settings,
    });
  });
}