import { adminHandler } from "@/lib/admin";
import { initMysql, isMysqlConfigured, queryMysqlLogs } from "@/lib/mysql";
import { readLogs } from "@/lib/stats";
import { getConfig } from "@/lib/store";
import { calculateModelCost, findModelPricing } from "@/lib/types";

export async function GET(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const params = new URL(req.url).searchParams;
    const limit = Math.min(1000, Math.max(1, Number(params.get("limit") ?? 200) || 200));
    const filter = {
      keyId: params.get("keyId") || undefined,
      upId: params.get("upId") || undefined,
      model: params.get("model") || undefined,
      status: params.get("status") || undefined,
    };

    const config = await getConfig();
    const mysqlEnabled = isMysqlConfigured() && (await initMysql());
    const logs = mysqlEnabled ? await queryMysqlLogs(limit, filter) : await readLogs(limit, filter);
    const logsWithCost = logs.map((log) => {
      const pricing = findModelPricing(config.modelPrices, log.model);
      const cost = pricing ? calculateModelCost(log.pt, log.ct, log.cachedPt ?? 0, pricing) : null;
      return { ...log, cost };
    });

    return Response.json({
      logs: logsWithCost,
      mysqlEnabled,
      upstreams: config.upstreams.map((u) => ({ id: u.id, name: u.name })),
      keys: config.keys.map((k) => ({ id: k.id, name: k.name })),
    });
  });
}
