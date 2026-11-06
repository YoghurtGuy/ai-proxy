import { cookies } from "next/headers";
import { SESSION_COOKIE, adminPasswordConfigured, checkPassword, createSessionToken, sessionCookieOptions } from "@/lib/auth";

export async function POST(req: Request): Promise<Response> {
  if (!adminPasswordConfigured()) {
    return Response.json({ error: "服务端未设置 ADMIN_PASSWORD" }, { status: 500 });
  }
  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  if (!checkPassword(password)) {
    // 稍微拖一下，防止脚本穷举
    await new Promise((r) => setTimeout(r, 300));
    return Response.json({ error: "密码错误" }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions(req));
  return Response.json({ ok: true });
}