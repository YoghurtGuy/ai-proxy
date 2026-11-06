import { cookies } from "next/headers";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/auth";

export async function POST(): Promise<Response> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, maxAge: 0 });
  return Response.json({ ok: true });
}