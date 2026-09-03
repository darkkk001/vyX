# Deployment

## 1. Today

- **Web app**: Vercel, deployed from `darkkk001/vyX`. Two relevant refs:
  the working branch (`feat/vyxtrader-platform-setup`) and
  `main` (production, `vyxtrader.com`). Wildcard-subdomain multi-tenancy —
  `middleware.ts` resolves the broker from the Host header, so one
  deployment serves every broker's subdomain plus the root-domain
  launcher.
- **Database**: Neon PostgreSQL — pooled `DATABASE_URL` for app runtime,
  unpooled `DIRECT_URL` for migrations.
- **Build**: `prisma generate` runs as part of the Vercel build script
  (this was a real, already-fixed failure earlier in this engagement —
  Vercel's build didn't have a generated Prisma client without it).
- **Desktop app updates (Tauri, the only desktop app — the earlier
  Electron app and its `public/desktop-updates/` feed were removed
  2026-08-18, see `decisions.md` ADR-001)** — done (2026-08-17): static
  files under `public/desktop-tauri-updates/`, served by the existing
  Vercel deployment, no separate update-hosting infrastructure.
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

  **Per-broker feeds (fixed 2026-08-29)**: `rebrand.js` (desktop-tauri and
  manager-tauri both) now bakes a slug-scoped updater endpoint into every
  broker's rebranded build -- `.../desktop-tauri-updates/<slug>/latest.json`
  instead of the shared root path, where `<slug>` is the broker's
  subdomain's first label. `publish.js` (both apps) detects a
  broker-rebranded build via `broker.config.json` (`mode: "broker"`,
  written by `rebrand.js`, present until it's reverted post-build) and
  publishes to that same slug-scoped `public/` path instead of the shared
  one; the generic launcher-mode build (no `broker.config.json` in broker
  mode) keeps publishing to the original shared path unchanged, so the
  existing CI release workflow needs no changes. Before this, every
  broker's white-label installer polled the exact same shared feed the
  generic launcher build publishes to -- the next generic release would
  silently downgrade/debrand every installed broker app back to launcher
  mode (wrong product name, wrong icon, and `broker.config.json`'s `mode`
  flipping back to `"launcher"`, sending the app to the root-domain server
  picker instead of that broker's login screen). Workflow when cutting a
  broker release: rebrand -> build -> publish (uses that broker's slug
  automatically) -> revert, in that order -- publishing before reverting
  is what lets `publish.js` see the still broker-mode `broker.config.json`.

  **Signing key**: updates are Ed25519-signed (minisign format) —
  `tauri-plugin-updater` refuses to install anything not signed by the
  key whose public half is baked into `tauri.conf.json`
  (`plugins.updater.pubkey`, safe to commit). The **private** half lives
  only at `desktop-tauri/src-tauri/.updater-keys/vyxtrader.key` on
  whichever machine cuts a release — gitignored, generated once via
  `npx @tauri-apps/cli signer generate -w <path>` with no password. Its
  only other copy is (once set up, see below) a GitHub Actions
  repository secret for the automated release workflow — not itself a
  backup, just a second place the same one key lives, so losing the
  local file still doesn't strand the key if the secret was already
  set. **This key is not backed up anywhere durable outside these two
  places.** Losing it means every already-installed
  Tauri app can never trust a future signed update again — there is no
  recovery path short of shipping a fresh install with a new pubkey to
  every affected user. Back it up somewhere durable outside the repo
  before relying on this for real releases.

  **Cutting a release — automated (2026-08-18).**
  `.github/workflows/desktop-tauri-release.yml`, a manual
  `workflow_dispatch` button (GitHub → Actions tab → "Desktop Tauri
  Release" → "Run workflow"; deliberately not tag- or push-triggered,
  so a release only happens when someone clicks it on purpose) that
  runs the full sign → build → generate manifest → publish sequence on
  a `windows-latest` runner and commits `public/desktop-tauri-updates/`
  back to the branch automatically — the exact same steps
  `publish.js`'s own final printed line already told a human to do by
  hand, just no longer manual. An optional `notes` input becomes the
  release's `--notes` (see `publish.js`); leave it blank to fall back
  to `publish.js`'s own default. The version published is always
  whatever `tauri.conf.json`'s `version` field says at the time — bump
  that in a normal commit before running the workflow if cutting a new
  version, same as the old manual process.

  **One-time setup required before this can actually build a signed
  release** (a human action, not something achievable from this
  sandbox — the signing key is a secret this tooling deliberately never
  had a way to expose): add two repository secrets under **Settings →
  Secrets and variables → Actions → New repository secret**:
  - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of
    `desktop-tauri/src-tauri/.updater-keys/vyxtrader.key` (open that
    file locally and paste its entire contents as the secret value).
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — leave the value empty (the
    key genuinely has no password; this is expected, not a mistake).

  Until both secrets are set, the workflow fails immediately and
  clearly at an explicit early check (`TAURI_SIGNING_PRIVATE_KEY
  repository secret is not set...`) rather than deep inside a
  `tauri build` signing error — the same confusing "wrong password"
  class of failure hit once already while building this feature
  manually (see the gotchas noted below, still true for anyone running
  this locally instead of via the workflow).

  **Cutting a release manually (still works, e.g. for local testing)**:
  `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents, not the path —
  the CLI's bundler-level signing step only reads the content-form env
  var, confirmed by testing both) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  (empty string) must both be set when running `tauri build`, or it
  either fails outright or hangs waiting on an interactive password
  prompt with no TTY to answer it. Reading the key's content into the
  env var must happen in the same shell that runs the build (a value
  round-tripped through PowerShell's `$env:` assignment from a
  separately-read variable failed signature decoding in testing;
  reading and exporting it in one Bash step worked reliably) — the
  workflow above avoids this specific footgun entirely by setting both
  as step-scoped `env:` on the one step that needs them.
- **MT5 EA**: not "deployed" in the usual sense — it's a `.mq5` file a
  broker installs into their own MT5 terminal, calling back to
  `/api/internal/price-feed/[payload]` on the same Vercel deployment.

- **Manager and Admin desktop apps gained auto-update too (2026-08-27)** —
  `manager-tauri/` and `admin-tauri/` were "core-shell slice only" builds
  (per each app's own main.rs header comment and package.json
  description) with auto-update explicitly deferred, same as tray,
  notifications, window-state and navigation lockdown. Auto-update is no
  longer on that list; the rest still is. Exact same mechanism as
  desktop-tauri above, just two more independent feeds and keypairs — a
  broker's Manager staff and Super Admin should never trust an update
  signed by the trader terminal's key or vice versa, so each app has its
  own Ed25519 keypair, its own `.updater-keys/` (gitignored) directory,
  its own `public/<app>-updates/` feed, and its own `publish.js` /
  release workflow:
  - `manager-tauri/src-tauri/.updater-keys/vyxtrader-manager.key` →
    `public/manager-tauri-updates/`, `.github/workflows/manager-tauri-release.yml`
  - `admin-tauri/src-tauri/.updater-keys/vyxtrader-admin.key` →
    `public/admin-tauri-updates/`, `.github/workflows/admin-tauri-release.yml`

  No native-notification step (that plugin isn't wired into either app
  yet) — the update still silently downloads and installs on the app's
  next natural restart, same as desktop-tauri's own UX otherwise.

  **One-time setup required for each**, same reasoning as desktop-tauri's
  own secrets above (a human action, not achievable from a sandbox):
  - `MANAGER_TAURI_SIGNING_PRIVATE_KEY` / `MANAGER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
    (empty) for `manager-tauri-release.yml`.
  - `ADMIN_TAURI_SIGNING_PRIVATE_KEY` / `ADMIN_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
    (empty) for `admin-tauri-release.yml`.

  **A real bug found and fixed in the same pass**: the desktop-tauri
  installer already committed to `public/desktop-tauri-updates/` had a
  test broker's config baked in (`broker.config.json`: `mode: "broker"`,
  `subdomain: "acmefx.vyxtrader.com"`, left over from the commit that
  first fixed resource bundling) instead of the generic
  `mode: "launcher"` build the public download link is supposed to be —
  so anyone downloading "the app" landed straight on a demo broker's
  branding instead of the root-domain server picker (`/launch`). Fixed
  and republished as part of this pass; `manager-tauri`'s own bundled
  config was already correctly in launcher mode, and `admin-tauri` has no
  broker concept to get wrong (fixed `admin.<rootDomain>` subdomain).

## 2. Target: what gets added, what stays

| Component | Where it runs | Notes |
|---|---|---|
| Web (`apps/web`), Manager, Back Office | Vercel (unchanged pattern) | Same wildcard-subdomain multi-tenancy extends to Manager/Back Office subdomains |
| API Gateway | New — needs a long-running process, not Vercel serverless functions (WebSocket support) | Candidate: a small always-on host (Fly.io/Railway/a VPS) or Vercel's Edge/Node runtime if its WebSocket support is sufficient by the time this is built — not decided here, implementation detail for Phase 1 |
| Rust Trading Core (`/engine`) | New — long-running process, likely containerized | Needs to be network-adjacent to Postgres and NATS for latency; exact host not decided here |
| NATS | New — managed (e.g. Synadia) or self-hosted alongside the Trading Core | Implementation detail, Phase 1 |
| Redis | New — managed (e.g. Upstash, which is Vercel-native and fits the current stack well) | Cache/session only, never authoritative (see `authentication.md`, `security.md`) |
| Postgres | Neon (unchanged) | One instance, per ADR-002 |
| Desktop (Tauri, the only desktop app) | `public/desktop-tauri-updates/` feed, same Vercel deployment — done | Electron app removed 2026-08-18 per ADR-001, once Tauri reached full parity |
| Mobile (Flutter) | App Store / Play Store | New, standard mobile distribution — not further specified here |

## 3. Electron → Tauri cutover (ADR-001) — complete

Tauri was built and tested independently alongside the existing
Electron app, reached full feature parity (per-broker rebranding, tray,
notifications, auto-update, window-state, navigation lockdown,
splash/offline screens — see `decisions.md` ADR-001 for the full list
and how each was verified), and only then — with the Electron app
confirmed to have never had any real installed users — was the Electron
app (`desktop/`) removed outright (2026-08-18), rather than kept running
in parallel for an overlap period. Tauri (`desktop-tauri/`) is now the
only desktop app.

## 4. Open questions for Phase 1

- Exact hosting choice for the API Gateway and Rust Trading Core
  (specific provider) — deliberately left open here; a Phase 1
  implementation decision, not an architectural one that needs
  pre-approval like ADR-001 through ADR-003 did.
- ~~CI/CD pipeline for the Rust workspace~~ — done (2026-08-18):
  `.github/workflows/engine-ci.yml`, build+test as hard gates,
  clippy/fmt informational only. See `testing.md` §5 for full detail.
  The benchmark gates themselves (`testing.md` §2's concurrency/latency
  row) still aren't part of CI — `loadtest` needs a real Postgres+NATS,
  deliberately not spun up automatically; still a manual run.
