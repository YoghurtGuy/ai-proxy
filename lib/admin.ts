import { connection } from "next/server";
import { requireAdmin } from "./auth";

/**
 * 管理端 API 的统一外壳。
 *
 * connection() 是必须的：开启 cacheComponents 后，不碰请求期数据的 GET handler
 * 会在 build 阶段被预渲染成静态响应，那样管理端永远看到构建时的数据。
 */
export async function adminHandler(fn: () => Promise<Response>): Promise<Response> {
  await connection();
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;
  try {
    return await fn();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体应为 JSON 对象");
  return parsed as Record<string, unknown>;
}