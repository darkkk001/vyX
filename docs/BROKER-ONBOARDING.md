# Broker onboarding

Steps to bring a new broker live on the platform. Do them in order; each one names how to check it.

## 1. Broker host on Vercel (required, do it first)

Every broker is served at `<subdomain>.vyxtrader.com`. **Add that host to the Vercel project by name:**

```
vercel domains add <subdomain>.vyxtrader.com vy-x
```

Why: vyxtrader.com's nameservers are on Cloudflare, so Vercel cannot renew the `*.vyxtrader.com` wildcard certificate
(a wildcard needs Vercel's own nameservers). On 2026-11-09 the wildcard expired at 12:51 UTC and every broker host
failed TLS, so every installed terminal and backoffice showed "Can't reach the server". A host added by name gets its
own certificate, which Vercel issues and renews by itself through the existing DNS record (no DNS change, no
Cloudflare access needed). `vercel certs ls` must list the host with `renew yes`.

Check: `openssl s_client -connect <host>:443 -servername <host>` shows `CN=<host>` (not `*.vyxtrader.com`) with an
expiry about 90 days out.

The same applies to a broker's own custom domain (for example `my.<broker>.com`): add it to `vy-x` by name, and point
its DNS record at Vercel as `vercel domains inspect <domain>` says.

## 2. Certificate monitoring (automatic)

`/api/internal/cert-expiry` (daily Vercel cron, lib/cert-expiry.ts) checks every broker's subdomain and custom
domain, plus www / feed / admin, and e-mails OPS_ALERT_EMAIL once a day while any certificate is expired, does not
cover its host, cannot be read, or has fewer than 21 days left. A new broker is picked up from the Broker table with no
change. After step 1, the next run must not list the new host as a problem.

## 3. E-mail sender

The vy-x RESEND_API_KEY is a send-only key of the Resend account where the sender domains are verified. A new
broker's sender domain must be verified in that same account (or the key replaced), or sends fail with 403
"domain is not verified" (2026-10-05 outage).

## 4. Brand colours

brand.json has no colour fields yet, so the login, splash and refusal screens use the theme accent. Add accent colour
fields to the brand pack and the publish scripts before the next broker's builds, if the brand needs its own colour.
