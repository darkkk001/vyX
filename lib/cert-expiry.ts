import "server-only";
import tls from "node:tls";
import { getRedis } from "@/lib/redis";
import { sendPlatformEmail } from "@/lib/email/adapter";
import { recipients } from "@/lib/infra-health";

// Certificate-expiry monitor (owner 2026-11-09, after the *.vyxtrader.com wildcard expired at 12:51 UTC and every broker
// host failed TLS: the wildcard could not renew because vyxtrader.com's nameservers are Cloudflare, not Vercel). A daily
// Vercel cron (/api/internal/cert-expiry) opens a TLS connection to every broker host, every broker custom domain, and
// the platform hosts, reads the certificate actually served, and e-mails OPS_ALERT_EMAIL when any certificate has fewer
// than WARN_DAYS left, is expired, does not cover its host, or cannot be read. The e-mail repeats once a day until fixed.

/** Alert this many days before expiry. Vercel renews ~30 days before, so a healthy certificate never gets here. */
export const WARN_DAYS = 21;
export const PLATFORM_HOSTS = ["www.vyxtrader.com", "vyxtrader.com", "feed.vyxtrader.com", "admin.vyxtrader.com"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CertInfo = { host: string; validTo: string | null; daysLeft: number | null; subject: string; issuer: string; coversHost: boolean; error: string };
export type CertProblem = CertInfo & { problem: string };

/** Every host to check: <subdomain>.vyxtrader.com and the custom domain of every broker that is not DISABLED, plus the platform hosts. */
export function certHosts(brokers: { subdomain: string; customDomain: string | null }[]): string[] {
  const out = new Set<string>(PLATFORM_HOSTS);
  for (const b of brokers) {
    if (b.subdomain) out.add(`${b.subdomain.toLowerCase()}.vyxtrader.com`);
    if (b.customDomain) out.add(b.customDomain.trim().toLowerCase());
  }
  return [...out].sort();
}

/** The certificate a host serves right now (no trust check, so an expired one is still read). */
export function inspectCert(host: string, timeoutMs = 8000): Promise<CertInfo> {
  return new Promise((resolve) => {
    const done = (info: Partial<CertInfo>) => resolve({ host, validTo: null, daysLeft: null, subject: "", issuer: "", coversHost: false, error: "", ...info });
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      if (!c || !c.valid_to) return done({ error: "no certificate served" });
      const validTo = new Date(c.valid_to);
      done({
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / DAY_MS),
        subject: String(c.subject?.CN ?? ""),
        issuer: String(c.issuer?.O ?? c.issuer?.CN ?? ""),
        coversHost: tls.checkServerIdentity(host, c) === undefined,
      });
    });
    sock.on("timeout", () => { sock.destroy(); done({ error: `no TLS answer within ${timeoutMs} ms` }); });
    sock.on("error", (e) => done({ error: e.message }));
  });
}

/** What is wrong with one result, or null when it is fine. */
export function problemOf(c: CertInfo, warnDays = WARN_DAYS): string | null {
  if (c.error) return `cannot read the certificate: ${c.error}`;
  if (c.daysLeft === null) return "no expiry date";
  if (c.daysLeft < 0) return `EXPIRED on ${c.validTo}`;
  if (!c.coversHost) return `certificate (${c.subject}) does not cover this host`;
  if (c.daysLeft < warnDays) return `expires in ${c.daysLeft} day(s), on ${c.validTo}`;
  return null;
}

export function alertText(problems: CertProblem[], checked: number, now: Date) {
  const title = `${problems.length} TLS certificate problem(s): ${problems.map((p) => p.host).join(", ")}`;
  const lines = [
    title,
    "",
    `Checked at (UTC): ${now.toISOString()} (${checked} hosts)`,
    "",
    ...problems.map((p) => `  - ${p.host}: ${p.problem}${p.subject ? ` [served: ${p.subject}, ${p.issuer}]` : ""}`),
    "",
    "Fix: a host on *.vyxtrader.com must be added to the Vercel project by name (vercel domains add <host> vy-x);",
    "Vercel then issues and renews its own certificate. Runbook: docs/BROKER-ONBOARDING.md.",
    "This e-mail repeats once a day until every host is fine.",
  ];
  const text = lines.join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { subject: `[VyX ops] ${title}`, text, html: `<pre style="font-family:Consolas,monospace;font-size:13px">${esc(text)}</pre>` };
}

type Deps = {
  brokers: () => Promise<{ subdomain: string; customDomain: string | null }[]>;
  inspect?: (host: string) => Promise<CertInfo>;
  now?: Date;
};

/** One run: check every host, e-mail at most once per UTC day while anything is wrong. */
export async function runCertExpiryCheck(deps: Deps) {
  const now = deps.now ?? new Date();
  const hosts = certHosts(await deps.brokers());
  const results = await Promise.all(hosts.map((h) => (deps.inspect ?? inspectCert)(h)));
  const problems: CertProblem[] = [];
  for (const r of results) {
    const p = problemOf(r);
    if (p) problems.push({ ...r, problem: p });
  }
  let emailed = false;
  if (problems.length > 0) {
    const to = recipients();
    const key = `cert-expiry:alerted:${now.toISOString().slice(0, 10)}`;
    if (to.length === 0) console.warn("[cert-expiry] problems found but OPS_ALERT_EMAIL is not set", problems.map((p) => p.host));
    else if ((await getRedis().set(key, "1", "EX", 26 * 60 * 60, "NX")) === "OK") {
      try {
        const msg = alertText(problems, hosts.length, now);
        for (const addr of to) await sendPlatformEmail({ to: addr, ...msg });
        emailed = true;
      } catch (err) {
        await getRedis().del(key);   // let the next run retry the e-mail
        console.error("[cert-expiry] alert e-mail failed", err);
      }
    }
  }
  return { checkedAt: now.toISOString(), hosts: results, problems: problems.map((p) => ({ host: p.host, problem: p.problem })), emailed };
}
