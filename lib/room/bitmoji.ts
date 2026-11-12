import crypto from "node:crypto";

// Bitmoji connect, test version (owner 2026-11-12). A verified client links their Bitmoji through Snap Login Kit
// (web, public client with PKCE, scope user.bitmoji.avatar); only the avatar's image URL is kept on Client. Snap's
// tokens are used once to read the avatar and never stored.
//
// Behind BITMOJI_CONNECT_ENABLED: a comma-separated list of broker subdomains where it is on ("qoretrader").
// Unset or empty = off everywhere. There is no "on for all" value, so a new broker never gets it by accident.

export const SNAP_AUTH_URL = "https://accounts.snapchat.com/accounts/oauth2/auth";
export const SNAP_TOKEN_URL = "https://accounts.snapchat.com/accounts/oauth2/token";
export const SNAP_ME_URL = "https://kit.snapchat.com/v1/me";
export const BITMOJI_SCOPE = "https://auth.snapchat.com/oauth2/api/user.bitmoji.avatar";
export const BITMOJI_COOKIE = "bitmoji_oauth";
export const BITMOJI_CALLBACK_PATH = "/api/bitmoji/callback";
export const BITMOJI_COOKIE_MAX_AGE = 600; // Snap's code lives 10 minutes

/** Is Bitmoji connect on for this broker (by its subdomain)? */
export function bitmojiEnabledFor(subdomain: string, flag: string | undefined = process.env.BITMOJI_CONNECT_ENABLED): boolean {
  if (!flag) return false;
  const on = flag.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return on.includes(subdomain.toLowerCase());
}

/** Snap's public OAuth client ID, or null when not configured (the feature then stays off). */
export function snapClientId(): string | null {
  const id = process.env.SNAP_KIT_CLIENT_ID?.trim();
  return id ? id : null;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** state + PKCE verifier/challenge (S256) for one connect attempt. */
export function newConnectAttempt(): { state: string; verifier: string; challenge: string } {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { state, verifier, challenge };
}

/** The cookie that ties the callback to the attempt and to the signed-in client: clientId.state.verifier */
export function attemptCookie(clientId: string, state: string, verifier: string): string {
  return `${clientId}.${state}.${verifier}`;
}
export function readAttemptCookie(raw: string | undefined): { clientId: string; state: string; verifier: string } | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return { clientId: parts[0], state: parts[1], verifier: parts[2] };
}

/** Constant-time string compare. */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function snapAuthUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: BITMOJI_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${SNAP_AUTH_URL}?${q.toString()}`;
}

/** Only an https image on Bitmoji's or Snap's own hosts is ever saved or shown. */
export function isBitmojiAvatarUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2048) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return ["bitmoji.com", "snapchat.com", "snapkit.com", "bitmoji-sdk-images.s3.amazonaws.com"].some((d) => h === d || h.endsWith(`.${d}`))
    || (h === "s3.amazonaws.com" && u.pathname.startsWith("/bitmoji-sdk-images/"));
}

type Fetch = typeof fetch;

/** code -> access token -> the avatar's image URL. Throws a short reason on any failure; tokens are not kept. */
export async function fetchBitmojiAvatar(
  opts: { clientId: string; redirectUri: string; code: string; verifier: string },
  doFetch: Fetch = fetch,
): Promise<string> {
  const tokenRes = await doFetch(SNAP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: opts.code, redirect_uri: opts.redirectUri, client_id: opts.clientId, code_verifier: opts.verifier }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const token = (await tokenRes.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null;
  if (!tokenRes.ok || !token || typeof token.access_token !== "string") {
    throw new Error(`token ${tokenRes.status}${token && typeof token.error === "string" ? ` ${token.error}` : ""}`);
  }
  const meRes = await doFetch(SNAP_ME_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({ query: "{me{bitmoji{avatar}}}" }),
    signal: AbortSignal.timeout(10_000),
  });
  const me = (await meRes.json().catch(() => null)) as { data?: { me?: { bitmoji?: { avatar?: unknown } | null } } } | null;
  if (!meRes.ok) throw new Error(`me ${meRes.status}`);
  const avatar = me?.data?.me?.bitmoji?.avatar;
  if (avatar === undefined || avatar === null || avatar === "") throw new Error("no-avatar");
  if (!isBitmojiAvatarUrl(avatar)) throw new Error("bad-avatar-url");
  return avatar;
}

/** The avatar to draw instead of the initials: the saved Bitmoji while the flag is on for this broker, else null. */
export function shownAvatar(subdomain: string, saved: string | null | undefined): string | null {
  return saved && bitmojiEnabledFor(subdomain) && isBitmojiAvatarUrl(saved) ? saved : null;
}
