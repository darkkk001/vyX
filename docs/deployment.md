# Deployment

## 1. Today

- **Web app**: Vercel, deployed from `darkkk001/vyX`. Two relevant refs:
  the working branch (`claude/vyxtrader-platform-setup-0odm99`) and
  `main` (production, `vyxtrader.com`). Wildcard-subdomain multi-tenancy —
  `middleware.ts` resolves the broker from the Host header, so one
  deployment serves every broker's subdomain plus the root-domain
  launcher.
- **Database**: Neon PostgreSQL — pooled `DATABASE_URL` for app runtime,
  unpooled `DIRECT_URL` for migrations.
- **Build**: `prisma generate` runs as part of the Vercel build script
  (this was a real, already-fixed failure earlier in this engagement —
  Vercel's build didn't have a generated Prisma client without it).
- **Desktop app updates (Electron)**: `desktop/publish.js` copies release
  artifacts (`.exe`, `.blockmap`, `latest.yml`) into `public/desktop-updates/`,
  which Vercel serves as static files — `electron-updater`'s "generic"
  provider points at that URL. No separate update-hosting infrastructure.
- **Desktop app updates (Tauri)** — done (2026-08-17): same "static files
  under `public/`, served by the existing Vercel deployment" pattern, at
  a **separate** path (`public/desktop-tauri-updates/`) so the two apps'
  update channels don't collide during the ADR-001 cutover window.
  `desktop-tauri/publish.js` hand-builds the manifest `tauri-plugin-updater`
  expects (Tauri v2 doesn't auto-generate one the way electron-builder
  does) — `{version, notes, pub_date, platforms: {"windows-x86_64":
  {signature, url}}}` — from the signed installer + `.sig` file `tauri
  build` produces under `src-tauri/target/release/bundle/nsis/`. The app
  checks this feed once at startup (release builds only, matching
  Electron's `if (app.isPackaged)` gate) and silently downloads+installs
  if a newer version is found, notifying via the native-notification
  bridge on success — same minimal, non-intrusive UX as
  `checkForUpdatesAndNotify()`, no forced restart.

  **Signing key**: updates are Ed25519-signed (minisign format) —
  `tauri-plugin-updater` refuses to install anything not signed by the
  key whose public half is baked into `tauri.conf.json`
  (`plugins.updater.pubkey`, safe to commit). The **private** half lives
  only at `desktop-tauri/src-tauri/.updater-keys/vyxtrader.key` on
  whichever machine cuts a release — gitignored, generated once via
  `npx @tauri-apps/cli signer generate -w <path>` with no password (no CI
  secret store exists for this project yet, see §4). **This key is not
  backed up anywhere else.** Losing it means every already-installed
  Tauri app can never trust a future signed update again — there is no
  recovery path short of shipping a fresh install with a new pubkey to
  every affected user. Back it up somewhere durable outside the repo
  before relying on this for real releases.

  **Cutting a release**: `TAURI_SIGNING_PRIVATE_KEY` (the key file's
  contents, not the path — the CLI's bundler-level signing step only
  reads the content-form env var, confirmed by testing both) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty string) must both be set
  when running `tauri build`, or it either fails outright or hangs
  waiting on an interactive password prompt with no TTY to answer it —
  hit exactly this while verifying this feature. Reading the key's
  content into the env var must happen in the same shell that runs the
  build (a value round-tripped through PowerShell's `$env:` assignment
  from a separately-read variable failed signature decoding in testing;
  reading and exporting it in one Bash step worked reliably).
- **MT5 EA**: not "deployed" in the usual sense — it's a `.mq5` file a
  broker installs into their own MT5 terminal, calling back to
  `/api/internal/price-feed/[payload]` on the same Vercel deployment.

## 2. Target: what gets added, what stays

| Component | Where it runs | Notes |
|---|---|---|
| Web (`apps/web`), Manager, Back Office | Vercel (unchanged pattern) | Same wildcard-subdomain multi-tenancy extends to Manager/Back Office subdomains |
| API Gateway | New — needs a long-running process, not Vercel serverless functions (WebSocket support) | Candidate: a small always-on host (Fly.io/Railway/a VPS) or Vercel's Edge/Node runtime if its WebSocket support is sufficient by the time this is built — not decided here, implementation detail for Phase 1 |
| Rust Trading Core (`/engine`) | New — long-running process, likely containerized | Needs to be network-adjacent to Postgres and NATS for latency; exact host not decided here |
| NATS | New — managed (e.g. Synadia) or self-hosted alongside the Trading Core | Implementation detail, Phase 1 |
| Redis | New — managed (e.g. Upstash, which is Vercel-native and fits the current stack well) | Cache/session only, never authoritative (see `authentication.md`, `security.md`) |
| Postgres | Neon (unchanged) | One instance, per ADR-002 |
| Desktop (Electron, current) | Same `public/desktop-updates/` feed | Stays live until Phase 4 cutover per ADR-001 |
| Desktop (Tauri, new) | `public/desktop-tauri-updates/` feed, same Vercel deployment — done | Two update channels coexist during the cutover window |
| Mobile (Flutter) | App Store / Play Store | New, standard mobile distribution — not further specified here |

## 3. Electron → Tauri cutover (ADR-001)

1. Tauri app built and tested independently — does not touch the live
   Electron app or its update feed.
2. Both apps available side by side for some overlap period (exact
   duration not decided here — a business/support call, not an
   architecture one).
3. New installs default to the Tauri app once it's verified stable;
   existing Electron installs keep receiving updates from their existing
   feed until a decision is made to sunset it — no forced migration that
   could strand a broker's traders mid-session.
4. `desktop/rebrand.js`'s per-broker rebranding tooling gets a Tauri
   equivalent before any broker relies on the new app for white-labeling
   — without it, Tauri isn't yet at feature parity for this project's
   actual use case (white-label resale), and cutover shouldn't happen
   before parity.

## 4. Open questions for Phase 1

- Exact hosting choice for the API Gateway and Rust Trading Core
  (specific provider) — deliberately left open here; a Phase 1
  implementation decision, not an architectural one that needs
  pre-approval like ADR-001 through ADR-003 did.
- CI/CD pipeline for the Rust workspace (test/benchmark gates referenced
  in `testing.md` and ADR-003) — needs its own setup once the Rust
  workspace exists in Phase 1.
