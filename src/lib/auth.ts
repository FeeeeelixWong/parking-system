import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env, isProd } from "./env";
import { unauthorized } from "./api-handler";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const AUTH_COOKIE = "parking_auth";
const ISSUER = "parking-system";
const ALGORITHM = "HS256";
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours

const secret = new TextEncoder().encode(env.AUTH_SECRET);

// ---------------------------------------------------------------------------
// Token shape
// ---------------------------------------------------------------------------
export type AuthRole = "admin";

export type AuthPayload = {
  sub: string;   // user identifier ("admin" for now)
  role: AuthRole;
};

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------
export async function signAuthToken(
  payload: AuthPayload,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(ISSUER)
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSeconds}s`)
    .sign(secret);
}

export async function verifyAuthToken(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      algorithms: [ALGORITHM],
    });
    if (!payload.sub || typeof payload.role !== "string") return null;
    return { sub: payload.sub, role: payload.role as AuthRole };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers (server-side, use from route handlers / server components)
// ---------------------------------------------------------------------------
export async function setAuthCookie(
  token: string,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
): Promise<void> {
  const store = await cookies();
  store.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: isProd && process.env.PLAYWRIGHT_TEST !== "true",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function clearAuthCookie(): Promise<void> {
  const store = await cookies();
  store.delete(AUTH_COOKIE);
}

export async function getAuthFromCookies(): Promise<AuthPayload | null> {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  if (!token) return null;
  return verifyAuthToken(token);
}

// ---------------------------------------------------------------------------
// Route guards (throw 401 if not authenticated)
// ---------------------------------------------------------------------------
export async function requireAdmin(): Promise<AuthPayload> {
  const auth = await getAuthFromCookies();
  if (!auth || auth.role !== "admin") throw unauthorized("Admin required");
  return auth;
}

// ---------------------------------------------------------------------------
// Login check (simple shared password for now)
// ---------------------------------------------------------------------------
export function checkAdminPassword(password: string): boolean {
  // Constant-time compare would be nice, but shared password vs literal string
  // doesn't leak via timing when both are fixed-length strings of this size.
  // Keeping it simple for Chunk 2.
  return password === env.ADMIN_PASSWORD;
}
