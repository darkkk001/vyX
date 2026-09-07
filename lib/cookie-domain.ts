import { headers } from "next/headers";

// A cookie's `domain` attribute can only be the current request's own host
// or a real parent of it -- a browser silently REJECTS (not errors, not
// warns) a Set-Cookie whose domain isn't that. lib/account-auth.ts and
// lib/auth.ts both used to hardcode `.${ROOT_DOMAIN}` (".vyxtrader.com")
// unconditionally, which is exactly right for a broker's *.vyxtrader.com
// subdomain (it's how the session cookie also reaches feed.<ROOT_DOMAIN>,
// the WS Gateway's own subdomain) but is an entirely unrelated domain to
// a broker's own custom domain -- confirmed the real cause of the
// 2026-09-07 Futurix login outage: the login POST on www.futurixglobal.com
// succeeded and returned a session cookie scoped to ".vyxtrader.com", the
// browser dropped it since that domain doesn't match/contain the current
// host, and the very next authenticated request had no cookie at all,
// bouncing straight back to the login page.
//
// Host-aware instead: on our own root domain (any *.vyxtrader.com,
// including the bare root), keep the site-wide scope so the WS Gateway
// still gets it. On a broker's own custom domain, there is no shared
// parent domain with feed.<ROOT_DOMAIN> to broaden to -- scope to just
// the current host (omitting `domain` does that) instead of breaking the
// cookie outright. This does mean a custom-domain broker's WS handshake
// still falls back to WebTrader.tsx's HTTP poll rather than reaching
// feed.<ROOT_DOMAIN> -- a real product gap, not silently "fixed" by this,
// just no longer breaking login to get there.
export async function cookieScopeDomain(): Promise<string | undefined> {
  const rootDomain = (process.env.ROOT_DOMAIN ?? "localhost:3000").split(":")[0];
  if (rootDomain === "localhost") return undefined;

  const host = (await headers()).get("host")?.split(":")[0] ?? "";
  const isOnRootDomain = host === rootDomain || host.endsWith(`.${rootDomain}`);
  return isOnRootDomain ? `.${rootDomain}` : undefined;
}
