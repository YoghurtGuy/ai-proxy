import { cookies } from "next/headers";

/**
 * 单管理员鉴权：env 里一个 ADMIN_PASSWORD，登录后发一个 HMAC 签名的 cookie。
 * 用 Web Crypto 而不是 node:crypto，这样 proxy.ts 和 route handler 都能用同一套代码。
 */

export const SESSION_COOKIE = "aiproxy_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
let cachedKey: { material: string; key: Promise<CryptoKey> } | null = null;

function secretMaterial(): string {
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) {
    throw new Error("缺少环境变量 ADMIN_PASSWORD（或 AUTH_SECRET），无法启用管理端鉴权");
  }
  return secret;
}

function sessionKey(): Promise<CryptoKey> {
  const material = secretMaterial();
  if (cachedKey?.material !== material) {
    cachedKey = {
      material,
      key: crypto.subtle.importKey("raw", encoder.encode(material), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]),
    };
  }
  return cachedKey.key;
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 定长比较，避免用长度或逐字节短路泄露信息。 */
function timingSafeEqual(a: string, b: string): boolean {
  const av = encoder.encode(a);
  const bv = encoder.encode(b);
  let diff = av.length ^ bv.length;
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) diff |= (av[i] ?? 0) ^ (bv[i] ?? 0);
  return diff === 0;
}

export function adminPasswordConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD || process.env.AUTH_SECRET);
}

export function checkPassword(candidate: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(candidate, expected);
}

export async function createSessionToken(now = Date.now()): Promise<string> {
  const payload = String(now + SESSION_TTL_MS);
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(), encoder.encode(payload));
  return `${payload}.${toBase64Url(sig)}`;
}

export async function verifySessionToken(token: string | undefined | null, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = toBase64Url(await crypto.subtle.sign("HMAC", await sessionKey(), encoder.encode(payload)));
  return timingSafeEqual(signature, expected);
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

/** route handler 里判断当前请求是否已登录。 */
export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value);
}

/** 未登录时返回 401 响应，已登录返回 null。 */
export async function requireAdmin(): Promise<Response | null> {
  if (await isAdmin()) return null;
  return Response.json({ error: "未登录" }, { status: 401 });
}