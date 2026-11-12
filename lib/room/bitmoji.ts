import crypto from "node:crypto";

// Bitmoji connect, test version (owner 2026-11-12). A verified client links their Bitmoji through Snap Login Kit
// web; only the avatar's image URL is kept on Client. Snap's token is used once to read the avatar and never stored.
//
// The sign-in URL is the one Snap's own web SDK builds (sdk.snapkit.com/js/v1/login.js, login() ->
// getImplicitRedirectURL): client_id, redirect_uri, response_type=token, scope (full scope URLs, space-separated),
// state. That is the implicit grant for the public Client ID: Snap returns the token in the URL fragment of the
// redirect URI, so the callback page posts it back to the server, which reads the avatar with it.
//
// Behind BITMOJI_CONNECT_ENABLED: a comma-separated list of broker subdomains where it is on ("qoretrader").
// Unset or empty = off everywhere. There is no "on for all" value, so a new broker never gets it by accident.

export const SNAP_AUTH_URL = "https://accounts.snapchat.com/accounts/oauth2/auth";
export const SNAP_ME_URL = "https://kit.snapchat.com/v1/me";
// The SDK's OAUTH_SCOPE_URL_PREFIX + the scopes the Snap app has on (Display Name, Bitmoji Avatar), as in Snap's
// Login Kit example scopeList. Only the avatar is read.
export const BITMOJI_SCOPES = [
  "https://auth.snapchat.com/oauth2/api/user.display_name",
  "https://auth.snapchat.com/oauth2/api/user.bitmoji.avatar",
];
export const BITMOJI_SCOPE = BITMOJI_SCOPES.join(" ");
export const BITMOJI_COOKIE = "bitmoji_oauth";
export const BITMOJI_CALLBACK_PATH = "/api/bitmoji/callback";
export const BITMOJI_COOKIE_MAX_AGE = 600; // one sign-in attempt

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

/** The state for one connect attempt: 32 random bytes, base64url (as the SDK's generateClientState). */
export function newConnectState(): string {
  return b64url(crypto.randomBytes(32));
}

/** The cookie that ties the callback to the attempt and to the signed-in client: clientId.state */
export function attemptCookie(clientId: string, state: string): string {
  return `${clientId}.${state}`;
}
export function readAttemptCookie(raw: string | undefined): { clientId: string; state: string } | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2 || parts.some((p) => !p)) return null;
  return { clientId: parts[0], state: parts[1] };
}

/** Constant-time string compare. */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Same parameters, order and encoding as the SDK's getImplicitRedirectURL (spaces as %20, not +). */
export function snapAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const q: [string, string][] = [
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["response_type", "token"],
    ["scope", BITMOJI_SCOPE],
    ["state", state],
  ];
  return `${SNAP_AUTH_URL}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
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

/** Snap's access token -> the avatar's image URL (the SDK's /v1/me query). Throws a short reason on any failure. */
export async function fetchBitmojiAvatar(accessToken: string, doFetch: Fetch = fetch): Promise<string> {
  const meRes = await doFetch(SNAP_ME_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
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
