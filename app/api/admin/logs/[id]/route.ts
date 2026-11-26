import { adminHandler } from "@/lib/admin";
import { getMysqlLogBody, isMysqlConfigured } from "@/lib/mysql";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return adminHandler(async () => {
    if (!isMysqlConfigured()) {
      return Response.json({ error: "未配置 MYSQL_URL，未开启正文存储" }, { status: 400 });
    }
    const { id } = await context.params;
    const trimmed = id.trim();
    if (!trimmed) {
      return Response.json({ error: "缺少日志 ID" }, { status: 400 });
    }
    const detail = await getMysqlLogBody(trimmed);
    if (!detail) {
      return Response.json({ error: "日志不存在" }, { status: 404 });
    }
    return Response.json({ detail });
  });
}
