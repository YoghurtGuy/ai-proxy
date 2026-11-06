import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export async function POST(req: Request): Promise<Response> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions(req), maxAge: 0 });
  return Response.json({ ok: true });
}