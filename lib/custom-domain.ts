import "server-only";
import { promises as dns } from "node:dns";

// White-label custom domains (2026-11-04). Any broker may serve its client pages on its own domain
// (Broker.customDomain, e.g. portal.brokername.com). Setup is two DNS records at the broker's DNS host, then the domain
// is attached to the platform's Vercel project; once it answers here over HTTPS the Super Admin check marks it live
// (Broker.customDomainVerifiedAt) and the broker's <slug>.vyxtrader.com pages redirect to it. Until then nothing moves.

/** The CNAME a broker's domain points at; the Vercel project's own target (env), else Vercel's generic one. */
export function customDomainCnameTarget(): string {
  return (process.env.CUSTOM_DOMAIN_CNAME_TARGET ?? "cname.vercel-dns.com").replace(/\.$/, "");
}

const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A clean host name a broker may use, or the reason it cannot. */
export function normalizeCustomDomain(raw: unknown): { ok: true; host: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "customDomain must be a host name such as portal.brokername.com" };
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!HOST.test(host)) return { ok: false, error: "customDomain must be a host name such as portal.brokername.com" };
  const root = (process.env.ROOT_DOMAIN ?? "vyxtrader.com").split(":")[0].toLowerCase();
  if (host === root || host.endsWith(`.${root}`)) return { ok: false, error: `use the broker's own domain, not ${root}` };
  return { ok: true, host };
}

export type DomainCheck = { live: boolean; dns: string; https: string };

/**
 * Is the domain live on this platform? DNS: a CNAME to Vercel (or Vercel's A records). HTTPS: a request to it reaches
 * Vercel with a valid certificate. Both must hold. Read-only; never throws.
 */
export async function checkCustomDomain(host: string): Promise<DomainCheck> {
  let dnsLine = "no CNAME or A record";
  let dnsOk = false;
  try {
    const cn = await dns.resolveCname(host).catch(() => [] as string[]);
    if (cn.length) {
      dnsOk = cn.some((c) => /vercel-dns(-\d+)?\.com\.?$/i.test(c));
      dnsLine = `CNAME ${cn.join(", ")}${dnsOk ? "" : " (not Vercel)"}`;
    } else {
      const a = await dns.resolve4(host).catch(() => [] as string[]);
      if (a.length) {
        dnsOk = a.some((ip) => ip === "76.76.21.21" || ip.startsWith("216.150.") || ip.startsWith("216.198."));
        dnsLine = `A ${a.join(", ")}${dnsOk ? "" : " (not Vercel)"}`;
      }
    }
  } catch {
    dnsLine = "DNS lookup failed";
  }
  let httpsLine = "not reached";
  let httpsOk = false;
  if (dnsOk) {
    try {
      const res = await fetch(`https://${host}/robots.txt`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000), cache: "no-store" });
      const vercel = (res.headers.get("server") ?? "").toLowerCase().includes("vercel") || res.headers.has("x-vercel-id");
      httpsOk = vercel;
      httpsLine = vercel ? `HTTPS ${res.status} from the platform` : `HTTPS ${res.status}, not the platform`;
    } catch (e) {
      httpsLine = `HTTPS failed (${e instanceof Error ? e.message.slice(0, 80) : "error"})`;
    }
  }
  return { live: dnsOk && httpsOk, dns: dnsLine, https: httpsLine };
}
