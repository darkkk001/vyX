# Vercel Firewall for the CRM (owner 2026-11-13)

Project `vy-x` (every broker domain: my.futurixglobal.com, my.qoretrader.com, *.vyxtrader.com). The rules live in
`firewall/crm-rules.json` and are applied with `scripts/firewall-apply.mjs` (the `vercel firewall` CLI). Firewall rules
take effect when published; they need no deployment.

## The rules

| Rule | Matches | Action (enforce) |
|---|---|---|
| CRM pages challenge | path `/login`, `/register`, `/portal`, `/portal/*` | Browser challenge (Vercel's JS check, once per browser) |
| Login API per-IP limit | `POST /api/portal/login` | 30 per minute per IP, then 429 |
| Register API per-IP limit | `POST /api/portal/register` | 10 per minute per IP, then 429 |

Never challenged (no rule matches them): `/api/*` (terminal, backoffice, mobile app, WebTrader, Room, Snap and Google
callbacks), `/trade/*` (WebTrader), `/native-*-updates/*`, `/_next/*`, `/brand-logo/*`, `/favicon.ico`,
`/apple-touch-icon.png`, every other path. The rate limits answer 429 (never a challenge), so a non-browser caller gets
a plain error it can show. The app's own per-IP and per-account limits stay behind both.

Note: the office IP (137.59.227.2) carries every terminal, backoffice and Room session; the login limit (30/min) is per
IP, so a crowd of staff signing in to the Room from the office within one minute could meet it. Raise `limit` in the
JSON and re-apply if that ever happens.

## Changing the rules

```
cd C:\vyx\web                                           # the directory linked to the Vercel project
node C:\vyx\wt-portal\scripts\firewall-apply.mjs log      # every rule as Log (rate limits count but do not block)
node C:\vyx\wt-portal\scripts\firewall-apply.mjs enforce  # the real actions
npx vercel firewall publish --project vy-x --confirm-name vy-x   # shows the effects + digest
npx vercel firewall publish --project vy-x --confirm-name vy-x --effects-digest <digest>
```

Watch: `npx vercel firewall overview` (rule hit counts) and
`npx vercel firewall traffic inspect ip <ip>` (one client's requests by action and path).
Dashboard: project vy-x > Firewall (rules under Configure).

## Attack Mode (Attack Challenge Mode) during an attack

Keep it OFF normally. Vercel's automatic DDoS mitigation is always on.

Turn on (person at the keyboard; the CLI refuses agents):
- Dashboard: project **vy-x** > **Firewall** > **⋯** (top right) > **Enable Attack Mode** > **Enable for 1 Hour**
  (menu beside it: 6 or 24 hours). It turns itself off when the time ends.
- CLI: `cd C:\vyx\web` then `npx vercel firewall attack-mode enable` (asks to confirm).

Turn off: Firewall > **⋯** > **Disable Attack Mode**, or `npx vercel firewall attack-mode disable`.

What keeps working while it is on (Vercel docs, 2026-11): browsers pass after the checkpoint, including the page's own
API calls; "standalone APIs ... and non-recognized automated services may not be able to pass challenges and could be
blocked"; there is no path exclusion for Attack Mode. The terminal, backoffice (.NET HttpClient) and mobile app
(dart:io HttpClient) are exactly such clients. The real test runs on the throwaway project `vyx-fw-attack-test`
(page /login/ + POST /api/trade/login, never vy-x) with clients built like the apps: see "Attack Mode test" below.

## Attack Mode test

Status: waiting for the owner to switch Attack Mode on for the throwaway project (the Vercel CLI does not let an agent
do it): `cd C:\vyx\web` then `npx vercel firewall attack-mode enable --project vyx-fw-attack-test --scope bigfishs-projects-020b7a21`.

## Live checks after Challenge was published (2026-11-13 07:14 UTC)

| Request | QoreTrader | Futurix |
|---|---|---|
| Browser (Chrome) GET /login, /register | checkpoint (429), then the page opens | same |
| curl GET /login, /register, /portal/forgot-password | 429 (checkpoint, cannot solve) | same |
| GET /trade/login, /favicon.ico, /native-terminal-updates/.../releases.win.json | 200 | 200 |
| POST /api/trade/login from curl / .NET HttpClient / dart:io | 401 / 426 (app's build check) / 401: reached the app | same |

Headless Chrome with the default "HeadlessChrome" user agent stays on the checkpoint; normal Chrome passes.
