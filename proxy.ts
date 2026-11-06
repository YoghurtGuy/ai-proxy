import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * 管理端页面的「乐观」鉴权：没登录就跳去 /login。
 * 真正的权限校验在 route handler 里（requireAdmin），这里只负责省掉无谓渲染。
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authed = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login") {
    if (authed) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }
  if (!authed) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/upstreams", "/keys", "/logs", "/settings", "/login"],
};