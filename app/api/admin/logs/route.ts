import { adminHandler } from "@/lib/admin";
import { initMysql, isMysqlConfigured, queryMysqlLogs } from "@/lib/mysql";
import { readLogs } from "@/lib/stats";

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

    const mysqlEnabled = isMysqlConfigured() && (await initMysql());
    const logs = mysqlEnabled ? await queryMysqlLogs(limit, filter) : await readLogs(limit, filter);
    return Response.json({ logs, mysqlEnabled });
  });
}
