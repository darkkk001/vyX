// Mints and verifies short-lived proof that a request to /manage/* or a
// Super Admin page came from a genuine packaged desktop app
// (manager-tauri / admin-tauri), not a browser -- see middleware.ts's
// isApplicationOnlyPage comment for why those paths are otherwise 404'd
// unconditionally on every domain.
//
// Two-step trust chain, deliberately not one secret doing both jobs:
//   1. The desktop app calls GET /api/manage/desktop-gate (or
//      /api/admin/desktop-gate) with a per-broker Broker.desktopGateSecret
//      (or the platform-wide SUPER_ADMIN_DESKTOP_GATE_SECRET) baked into
//      its build. That route (Node runtime, has Prisma) checks it against
//      the database/env, then calls mintDesktopGateToken here and sets the
//      result as an httpOnly cookie before redirecting into the real app.
//   2. Every later request -- the real page's own subsequent navigations,
//      exactly like a normal browser tab -- carries that cookie
//      automatically. middleware.ts (Edge runtime, no Prisma) calls
//      verifyDesktopGateToken to check it before falling through to its
//      existing unconditional 404.
//
// Signed with INTERNAL_SERVICE_SECRET (already an Edge-reachable env var,
// already used for exactly this kind of internal trust -- see
// resolve-broker's own comment) via Web Crypto's HMAC-SHA256, which runs
// identically in both the Node API route that mints a token and the Edge
// middleware that verifies one -- there is no Prisma/DB lookup on the
// verify path, only a signature check, so this stays cheap on every
// request the way the rest of middleware.ts already is.
const GATE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days -- reissued on every app launch, this is a ceiling not the real rotation period

async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(signature).toString("base64url");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// scope identifies what this token proves -- "manage:<brokerId>" for a
// Manager gate (bound to one specific broker, checked against the
// request's own resolved broker below so a leaked token can't be replayed
// against a different broker's domain) or "super-admin" for the Super
// Admin gate (no broker to bind to -- one platform-wide surface).
export async function mintDesktopGateToken(scope: string, secret: string): Promise<string> {
  const exp = Date.now() + GATE_TTL_MS;
  const payload = `${scope}:${exp}`;
  const signature = await hmacSign(payload, secret);
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signature}`;
}

export async function verifyDesktopGateToken(token: string, scope: string, secret: string): Promise<boolean> {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return false;

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return false;
  }

  const [payloadScope, expStr] = payload.split(":");
  if (payloadScope !== scope) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const expected = await hmacSign(payload, secret);
  return timingSafeEqualStr(expected, signature);
}
