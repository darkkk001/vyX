# Security

## 1. Today

- **Secrets**: environment variables (Vercel project env vars) —
  `DATABASE_URL`, `DIRECT_URL`, JWT signing keys, `PRICE_FEED_SECRET`,
  `FINNHUB_API_KEY`. No secrets manager/vault in front of these; standard
  for the project's current scale.
- **Transport**: HTTPS everywhere via Vercel's TLS termination; the MT5
  EA's price-feed calls go over HTTPS to the same domain.
- **Passwords**: bcrypt, both trader and admin accounts. Never logged,
  never returned in any API response.
- **Auth tokens**: httpOnly cookies only — never exposed to JS, never put
  in a URL. The one place a password-adjacent flow could have leaked into
  a URL (the cross-site launcher login) was deliberately built as a real
  form POST specifically to avoid that (see `authentication.md` §1).
- **Input validation**: per-route, ad hoc (each handler checks its own
  body shape) — no shared schema-validation layer (e.g. zod) applied
  uniformly today. A real gap worth closing but not yet flagged as
  blocking for Phase 0.
- **Audit logging**: `AuditLog` model already exists and is used for
  sensitive admin actions (balance adjustments, leverage changes, KYC
  approval, admin permission changes, manual position closes) —
  documented in the schema's own header comment. Carries forward
  unchanged as the audit trail for both today's admin actions and, later,
  the Risk module's accept/reject/margin-call decisions (see
  `risk-engine.md` §3).
- **Desktop app integrity**: the Tauri desktop app's `tauri-plugin-updater`
  checks a manifest (`latest.json`) served from
  `public/desktop-tauri-updates/` on the same Vercel deployment, and
  refuses to install anything not Ed25519-signed by this project's own
  signing key (see `deployment.md` for where that key lives and how a
  release is cut). That's real cryptographic trust for the update
  *payload* — separate from, and not a substitute for, OS-level code
  signing (Windows Authenticode / macOS notarization) on the installer
  `.exe` itself, which still isn't done — acceptable for the current
  pre-production/demo stage, called out explicitly here as something a
  real production launch needs before general distribution. (The earlier
  Electron app used `electron-updater` against an unsigned
  `latest.yml`/artifact feed; it has since been removed, see
  `decisions.md` ADR-001.)

## 2. Target additions

- **Rate limiting**: Redis-backed, per `authentication.md` §2 — login
  attempts first, extendable to order-placement rate limits if abuse
  patterns ever require it (not needed today, not built preemptively).
- **Input validation**: a shared schema-validation layer (e.g. zod) at
  the API Gateway boundary, applied uniformly to every incoming request
  before it reaches OMS/Risk — closes the ad hoc gap above without
  requiring every route handler to reinvent validation.
- **Trading Core boundary**: the Rust core (OMS/Risk/Execution) is itself
  a second internal trust boundary — the Gateway is the only thing that
  talks to it, and only over an internal network path (not
  internet-reachable), matching spec's general "defense in depth" framing
  without inventing new requirements beyond what's already implied by the
  Gateway/Core split in `architecture.md` §2.
- **Code signing**: the Tauri desktop app's installer `.exe` should be
  OS-code-signed (Windows Authenticode) before any real production
  rollout to end users outside this engagement's testing — flagged as a
  pre-launch checklist item, not built now since no certificate
  currently exists for this project. Separate from, and in addition to,
  the Ed25519 update-payload signing already in place (see §1 above).

## 3. Implementation status

**§2's input-validation gap — closed for the order routes.**
`services/api-gateway/src/validation.ts` adds zod schemas for both
`POST /v1/orders/market` and `/pending`, applied as Express middleware
before the handler runs. Replaces the old per-route `if (!body.x)`
checks, which never validated `volume`/`sl_price`/`tp_price`/
`requested_price` as real decimal strings — malformed input there either
threw uncaught out of `new Decimal(...)` (Express's default HTML 500,
not a clean API error) or got forwarded to the Rust core for a wasted
round trip before rejection. Decimal validity is checked via decimal.js
itself (the same parser everything else in this service already trusts),
not a hand-rolled regex. All validation issues are reported in one
response, not just the first. Found and fixed a real latent bug along
the way: decimal.js's own `isPositive()` treats zero as positive (sign
>= 0), so the original `!new Decimal(volume).isPositive()` check would
have let a zero-volume order through — replaced with `gt(0)`. Verified
directly against the schemas (valid/invalid volume, side, symbol,
order_type, sl_price/tp_price/requested_price, multi-issue reporting) —
this needs no live DB/NATS since it's pure request-shape validation, so
it was checked standalone rather than through the full stack.

## 4. Explicitly out of scope for Phase 0

Penetration testing, formal threat modeling, and compliance
certification (SOC 2, PCI, etc.) are real needs for a live financial
product but are business/process work, not architecture — not addressed
in this document set. Flagged here only so their absence isn't mistaken
for an oversight.
