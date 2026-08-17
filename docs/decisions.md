# Architecture Decision Record

Format: one entry per decision. Status is one of `Proposed`, `Accepted`,
`Rejected`, `Superseded`. Proposed entries are open questions — see
`architecture.md` §6 for full context on ADR-001 through ADR-003.

---

## ADR-001 — Desktop shell: Electron vs Tauri

**Status:** Accepted — **Tauri**, per explicit direction.

**Context:** A working Electron desktop app exists from earlier in this
engagement (frameless title bar, tray, notifications, auto-update,
per-broker rebrand tooling). It stays in place and keeps working as-is —
nothing about it breaks today — but the target desktop app for the
Trading Core ecosystem (Phase 4) is built in Tauri, not evolved from the
Electron shell.

**Decision:** Tauri for the new desktop workstation (Phase 4). The
existing Electron app (`desktop/`) is not deleted; it continues to serve
the current Next.js-only web app until Phase 4 replaces it. Migration
notes captured in `deployment.md`.

**Update (2026-08-17) — core shell built.** `desktop-tauri/` is a
frameless window pointed at a broker's deployed WebTrader, matching the
exact `window.vyxDesktop` contract the web app already consumes from the
Electron app (confirmed by reading `WebTrader.tsx`/`DesktopTitleBar.tsx`
directly — every desktop-only behavior there gates on that one global's
shape, not on anything Electron-specific), via a Tauri
`initialization_script` that wraps three custom commands
(`win_minimize`/`win_toggle_maximize`/`win_close`) plus a diffed
`maximized-changed` event. Zero web-app changes were needed. Live-
verified: real window process launches (confirmed via the OS process
list, correct title from `broker.config.json`), correctly resolves a
real broker subdomain and loads through to WebTrader's login page (
confirmed via the dev server's own request log showing the exact
navigation sequence a browser would produce). Not visually/pixel
confirmed (no screenshot capability in this sandbox) — same category of
disclosed limitation as this engagement's MT5 EA `.mq5` compile step.

**Per-broker rebrand tooling — done (2026-08-17).** `deployment.md`
§3.4 named this as a hard blocker before any broker can rely on Tauri
instead of Electron. `desktop-tauri/rebrand.js` is a direct port of
`desktop/rebrand.js` — identical CLI (`--name`/`--subdomain`/`--icon`/
`--root`), identical `broker.config.json` shape, identical validation
(`.ico`-only, both required args present) — only the icon's destination
differs (`src-tauri/icons/icon.ico` instead of `build/icon.ico`).
Live-verified all three paths: missing required args exits 1 with the
usage string; a non-`.ico` icon is rejected (after `broker.config.json`
is already written, matching the original script's exact ordering); a
full rebrand with a real `.ico` writes the correct config and copies a
byte-identical icon file (confirmed via checksum).

**System tray + minimize-to-tray — done (2026-08-17).** Direct port of
`desktop/main.js`'s `createTray()`/`refreshTrayMenu()`/`win.on("close",
...)`: closing the window hides it instead of quitting (a module-level
`is_quitting` flag, set only by the tray's own `Quit` item, mirrors
`isQuitting` exactly — background price alerts/SL-TP notifications keep
working, same reasoning as the original), a tray icon/menu in the same
order (`Show <broker>`, separator, `Launch at startup` checkbox via
`tauri-plugin-autostart`, separator, `Quit`), left-clicking the tray
icon shows the window. Live-verified the close-to-tray path for real:
sent the running window a genuine `WM_CLOSE` (the same signal an OS
close-button click sends, via `PostMessage` from PowerShell) and
confirmed the process survived — proof the interception is real, not
just code that compiles. **Disclosed limitation**: the tray menu's
`Quit` item itself is code-reviewed (correct order — flag set, then
`app_handle.exit(0)` — matching Electron's `isQuitting = true;
app.quit();`) but not click-tested; no tray-icon-click automation is
available in this sandbox, same category as this ADR's own earlier
"not visually/pixel confirmed" note.

**Native OS notifications — done (2026-08-17).** WebTrader's `pushToast`
(`components/webtrader/WebTrader.tsx`) fires a real `new Notification
("VyXTrader", { body })` for "important" events (margin call, price
alert, SL/TP hit, pending order trigger) whenever `window.vyxDesktop?.
isDesktop && "Notification" in window`. The first implementation
attempt replaced `window.Notification` with a wrapper routing through
`tauri-plugin-notification`'s JS API — reading the plugin's actual
shipped bundle (`tauri-plugin-notification` 2.3.3's `api-iife.js`)
before shipping showed that was wrong: the plugin's own
`isPermissionGranted`/`requestPermission`/`sendNotification` all read or
call the browser's native `window.Notification` directly, so
overwriting it created direct infinite recursion the moment a
notification actually fired (plugin → `window.Notification` → the
wrapper → plugin → ...). Caught by reading the dependency's source, not
by a runtime crash. **Corrected design: no polyfill of
`window.Notification` at all** — WebView2 already implements the
standard browser API natively, so WebTrader's existing call site needs
zero changes, same "zero web-app changes" property as every other piece
of this bridge. The only real gap versus a normal browser is that this
frameless kiosk-style window has no address-bar UI for a permission
prompt, so `desktop-tauri/src-tauri/src/main.rs`'s init script now just
calls `tauri-plugin-notification`'s `isPermissionGranted`/
`requestPermission` once at startup to request it proactively. Live-
verified: real `cargo build` against the actual installed plugin crate;
the corrected init script's method names (`isPermissionGranted`/
`requestPermission`/`sendNotification`) cross-checked directly against
the plugin's shipped JS source rather than assumed; the app process
launched pointed at a real seeded broker through the real dev server,
navigated correctly through to the login page, and stayed alive and
`Responding: True` several seconds after the init script (including the
startup permission request) ran — no hang, no crash. **Disclosed
limitation**: an actual "important" toast requires a logged-in trading
session hitting a real margin-call/alert/SL-TP/pending-trigger event,
which needs GUI interaction (login, place an order) this sandbox has no
automation for — the end-to-end "toast → visible Windows notification"
path itself was not manually click-triggered/visually confirmed, same
disclosed category as this ADR's own "not visually/pixel confirmed" and
"Quit item not click-tested" notes.

**Auto-update — done (2026-08-17).** Direct functional port of Electron's
entire auto-update surface (`desktop/main.js`'s single
`autoUpdater.checkForUpdatesAndNotify()` call, gated to
`app.isPackaged`, silently swallowing "no feed reachable"): a
`#[cfg(not(debug_assertions))]`-gated startup check via
`tauri-plugin-updater`, which downloads and installs silently and fires
one native notification (via the bridge from the previous slice) on
success — no "Check for Updates" UI, no forced relaunch, same minimal
UX. Uses a real Ed25519 (minisign) signing keypair generated for this
project; the private half is gitignored and lives only on the machine
that cuts a release, never committed — see `deployment.md`'s new
"Desktop app updates (Tauri)" section for the full operational detail
(where the key lives, what losing it means, and two real build-time
gotchas hit while verifying this: the bundler's signing step only reads
`TAURI_SIGNING_PRIVATE_KEY` as literal key content, not a path env var,
despite the CLI's own `signer generate` output suggesting the path
variant also works; and reading that content into the env var must
happen in the same shell as the build — round-tripping it through
PowerShell's `$env:` assignment from a separately-read variable produced
a key the signer rejected as an invalid password, while reading and
exporting it in one Bash `export VAR="$(cat ...)"` step worked
reliably). `desktop-tauri/publish.js` (new) hand-builds the update
manifest `tauri-plugin-updater` expects, since Tauri v2 doesn't
auto-generate one — verified against the plugin's actual
`RemoteRelease`/`ReleaseManifestPlatform` struct definitions in its
source, not assumed. **Live-verified for real**, more thoroughly than
most earlier slices: ran an actual signed release build (`tauri build`
with `bundle.createUpdaterArtifacts: true`), served the resulting
manifest + installer from the real local dev server standing in for
`vyxtrader.com`, and ran the built release binary with the update
endpoint temporarily pointed at it — it fetched the manifest, correctly
detected a newer version, downloaded the real installer bytes over
HTTP, and **successfully verified the Ed25519 signature** against the
generated keypair (all bytes accounted for: downloaded size matched the
installer exactly). Deliberately stopped short of calling `install()`
itself during verification — that runs the NSIS installer against this
real machine, which isn't something to trigger from an unattended
verification pass with no way to supervise or cancel an installer UI;
proving `download()` (fetch + full cryptographic verification, the same
code path `download_and_install()` calls internally before installing)
was judged sufficient real evidence without that risk, and is disclosed
as the one deliberately-untested step rather than silently assumed to
work.

**Still not at Electron parity** — `deployment.md` §3's own cutover
precondition list is the tracking spec for what else is needed before
any broker could actually rely on this instead of Electron:
`rememberBroker`/`forgetBroker` real persistence + launcher/root-domain
mode (currently no-op stubs so the web app's calls don't throw, but they
don't do anything yet), navigation lockdown, splash/offline screens,
window-state persistence across restarts.

---

## ADR-002 — Trading Core data ownership boundary

**Status:** Accepted (2026-08-17 — formalizing what the code already does)

**Context:** The Rust Trading Core needs authoritative tables for orders,
positions, and ledger entries. Today those are Prisma-owned
(`Order`, `Position`, `Transaction`) in the same Neon Postgres instance
that also holds `Broker`/`AdminUser`/`Account`/`KycRecord`/`Symbol`/etc.

**Options:**
- (a) Same Postgres instance, new Rust-owned tables for trading data;
  Prisma keeps owning config/CRM-shaped data only
- (b) Fully separate Postgres instance for the Trading Core, synced to
  the web app's database via events

**Recommendation:** (a) — one authoritative Postgres instance, clear
per-table ownership, no cross-database consistency problem to solve.

**Decision:** (a). Found sitting as "pending" during the cancel/modify
order-support work despite `engine/migrations/20260813000000_trading_core_tables.sql`
already implementing exactly this — snake_case `orders`/`positions`/
`ledger_entries` tables in the same Postgres instance, deliberately not
foreign-keyed to Prisma's tables. A real doc/reality gap, closed the same
way other stale-doc findings were fixed this session, not a new decision.

---

## ADR-003 — Cutover strategy while the Rust core is being built

**Status:** Accepted (2026-08-17 — formalizing what the code already does)

**Context:** Spec Phase 1-2 implies a build-out period where the Rust core
exists but isn't finished. The current Next.js/Prisma order-placement path
(`app/api/trade/orders`, `lib/trading.ts`) is live today.

**Options:**
- Keep the current Next.js trading path running unmodified during Rust
  core development, cut over broker-by-broker once the Rust core passes
  its test/benchmark gates
- Freeze/disable live trading now until the Rust core is ready

**Recommendation:** Keep the current path running — matches the project
rule against destroying working functionality mid-rewrite.

**Decision:** Keep the current path running. Same as ADR-002, found
still "pending" while every relevant piece of code (the Next.js path
untouched, `services/api-gateway` a new parallel surface nothing routes
through yet) already acts on this recommendation. Formalized here rather
than left inconsistent. Accepting the *strategy* here doesn't mean
cutover is ready — see `trading-engine.md`'s implementation-status note
for what's actually done so far (cancel/modify order support) versus
what cutover itself still needs.

**Update (2026-08-17):** the broker-selection mechanism this note
originally flagged as missing now exists — `Broker.executionEngine`
(`LEGACY`/`RUST`), settable only by `SUPER_ADMIN` via
`PATCH /api/admin/brokers/[id]` (`app/(super-admin)/brokers`'s new
"Engine" column). **Deliberately inert**: no `app/api/trade/*` route
reads this field yet, on purpose — setting a broker to `RUST` today
changes nothing about how its trades are processed, live-verified by
placing a real order for a `RUST`-flagged broker through the normal
Next.js path and confirming it still landed only in Prisma's `Order`/
`Position` tables, zero rows in the Rust-owned `orders` table. **Still
not satisfied**: the parallel-run comparison infrastructure `testing.md`
§4 calls for, and the test/benchmark gates (`testing.md` §2) themselves
— the switch existing doesn't mean cutover is ready, only that the
mechanism to eventually flip it is in place ahead of those gates
clearing, same ordering ADR-002/ADR-003's original scaffolding-ahead-of-
implementation pattern already used elsewhere (e.g. the `position`/
`ledger` crates).

---

## ADR-004 — Money representation

**Status:** Accepted (no conflict — already the existing practice)

**Context:** Spec §3 requires fixed-point/decimal money, never floating
point.

**Decision:** Continue using `Decimal` (Prisma) / fixed-point equivalents
in Rust (e.g. `rust_decimal`) for every price, quantity, commission, swap,
and balance field. This is already how the current schema works — no
change needed, just carries forward as a hard constraint into the Rust
core.

---

## ADR-005 — Messaging: NATS over Kafka

**Status:** Accepted (spec default, no current system to conflict with)

**Context:** Spec §1 prefers NATS "unless a documented requirement
justifies Kafka." No internal event bus exists today.

**Decision:** NATS. Nothing in the current system's scale or delivery
guarantees needs Kafka's log-retention/replay model; NATS's simplicity
and lower operational overhead fit a system this size better. Revisit
only if a specific requirement (e.g. long-term event replay for
compliance) surfaces that NATS JetStream can't satisfy either.

---

## ADR-006 — Order state machine superset

**Status:** Accepted

**Context:** Current `OrderStatus` enum is
`PENDING → ACCEPTED → FILLED/REJECTED/CANCELLED`. Spec's target state
machine adds `NEW`, `VALIDATING`, `ROUTING`, `PARTIALLY_FILLED`.

**Decision:** Adopt the spec's fuller state machine in the Rust core (see
`architecture.md` §5). The current simplified enum was an explicit,
documented stopgap ("MARKET orders trust the client-supplied execution
price until Phase 5's real matching engine exists") — this is exactly
that Phase 5 arriving.
