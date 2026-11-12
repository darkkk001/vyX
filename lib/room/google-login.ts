import crypto from "node:crypto";

// "Continue with Google" on the Trader's Room sign-in (owner 2026-11-12, QoreTrader first).
// Google OpenID Connect, authorization-code flow with PKCE (developers.google.com/identity/openid-connect/openid-connect):
//   /api/auth/google/start    -> Google's account chooser (state + nonce + PKCE kept in Redis for 10 minutes, the state
//                                 also in an httpOnly cookie so only the browser that started it can finish it)
//   /api/auth/google/callback -> code exchanged server-side for the ID token, checked (iss, aud, exp, nonce,
//                                 email_verified), then: an existing client with that email signs in (2FA still asked),
//                                 no client opens /register with the email filled in.
// Google's tokens are used once for this check and never saved or logged.
// Behind GOOGLE_LOGIN_ENABLED: a comma-separated list of broker subdomains where it is on ("qoretrader").

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";
export const GOOGLE_SCOPE = "openid email profile";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_STATE_COOKIE = "google_login";
export const GOOGLE_2FA_COOKIE = "google_2fa";
export const GOOGLE_COOKIE_PATH = "/api/auth/google";
export const GOOGLE_ATTEMPT_SECONDS = 600; // one trip to Google and back
export const GOOGLE_2FA_SECONDS = 300; // time to type the authenticator code
export const GOOGLE_2FA_MAX_TRIES = 5;

export const googleAttemptKey = (state: string) => `google_login:${state}`;
export const google2faKey = (ticket: string) => `google_2fa:${ticket}`;

/** What /login says after a Google sign-in that did not end signed in. */
export const GOOGLE_RESULT = {
  cancelled: "Google sign-in was cancelled.",
  expired: "That Google sign-in expired. Try again.",
  unverified: "Google has not verified that email. Sign in with your password.",
  failed: "Could not sign in with Google. Try again.",
} as const;
export type GoogleResult = keyof typeof GOOGLE_RESULT;

/** Is Google sign-in on for this broker (by its subdomain)? */
export function googleLoginEnabledFor(subdomain: string, flag: string | undefined = process.env.GOOGLE_LOGIN_ENABLED): boolean {
  if (!flag) return false;
  return flag.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(subdomain.toLowerCase());
}

/** The OAuth client, or null when not configured (the button then stays hidden). */
export function googleClient(): { id: string; secret: string } | null {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

export function googleLoginOn(subdomain: string): boolean {
  return googleLoginEnabledFor(subdomain) && googleClient() !== null;
}

export const randomToken = () => crypto.randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");

export function googleAuthUrl(clientId: string, redirectUri: string, state: string, nonce: string, verifier: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

export type GoogleIdentity = { email: string; emailVerified: boolean; name: string | null };

/**
 * The ID token's claims, checked. It came straight from Google's token endpoint over TLS in this request, so its
 * signature does not need a separate check (OpenID Connect Core 3.1.3.7, step 6); the claims still do.
 */
export function checkIdToken(idToken: string, clientId: string, nonce: string, nowSeconds = Math.floor(Date.now() / 1000)): GoogleIdentity | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
  if (!GOOGLE_ISSUERS.includes(String(c.iss))) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) return null;
  if (typeof c.exp !== "number" || c.exp < nowSeconds) return null;
  if (typeof c.nonce !== "string" || c.nonce.length !== nonce.length || !crypto.timingSafeEqual(Buffer.from(c.nonce), Buffer.from(nonce))) return null;
  if (typeof c.email !== "string" || !c.email.includes("@")) return null;
  return { email: c.email.trim().toLowerCase(), emailVerified: c.email_verified === true || c.email_verified === "true", name: typeof c.name === "string" ? c.name : null };
}

/** Exchanges the one-time code for the ID token (the access token in the same answer is dropped). */
export async function exchangeCode(
  client: { id: string; secret: string }, code: string, redirectUri: string, verifier: string, doFetch: typeof fetch = fetch,
): Promise<string | null> {
  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  return typeof body?.id_token === "string" ? body.id_token : null;
}
