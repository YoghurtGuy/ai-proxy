import { adminHandler } from "@/lib/admin";
import { readLogs } from "@/lib/stats";

export async function GET(req: Request): Promise<Response> {
  return adminHandler(async () => {
    const params = new URL(req.url).searchParams;
    const limit = Math.min(1000, Math.max(1, Number(params.get("limit") ?? 200) || 200));
    const logs = await readLogs(limit, {
      keyId: params.get("keyId") ?? undefined,
      upId: params.get("upId") ?? undefined,
      status: params.get("status") ?? undefined,
    });
    return Response.json({ logs });
  });
}