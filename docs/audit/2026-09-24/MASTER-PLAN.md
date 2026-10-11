# VyX Master Plan: Backoffice + Terminal (after full audit, 25 Sep 2026)

Sources merged: full read-only audit (`docs/audit/2026-09-24/`, 502 issues: 65 money · 205 functional · 131 ux · 101 text), screenshot review of all backoffice tabs + terminal, design canvas https://claude.ai/artifact/6pPfZXXgGQcPyffcB5NPc9.
Rule for every phase: `issues.md` is the queue. Each fix closes its issue lines by commit hash. Re-run the audit's read-only DB checks after each money fix.

---

## PHASE 0: Decisions only the owner can make (blocks Phase 1)

| # | Decision | Why it matters (audit fact) |
|---|---|---|
| D1 | **Reverse trading: should it be live?** | 1 ENABLED REVERSE mirror rule (Reverse Trading group → 50005702) is live in the DB. MIR shows 0 because of a parsing bug. 50005702 was moved to Standard B-Book on 21 Sep while the rule stayed on. Last mirror fill was 15 Sep. |
| D2 | **Standard XAUUSD at raw spread: intended?** | Override was deleted 24 Sep 11:45 ("raw spread"). Standard group has 0 group overrides and BrokerSymbol markup 0, so Futurix Standard earns **0 spread markup** today. |
| D3 | **13 fills at 300-point markup** on 50005708 (24 Sep 04:23–04:32). | Test account or real client? If real, compensate. |
| D4 | **Account Types: keep the layer or drop it?** | The pricing engine (flag ON for all 4 brokers) ranks AccountType flat pricing **above** group overrides. Futurix ECN type has an explicit 0 markup, so ECN accounts ignore group markup. Removing the ATY screen alone does not remove the layer. Recommend: drop AccountType from the resolver (group = pricing tier), migrate, then delete the screen. |
| D5 | **Withdrawals need 2 admins; Futurix has 1.** | Futurix can never complete a withdrawal. Options: add a second admin, or a per-broker "single approver" setting with audit trail. |
| D6 | **DEALER role?** | No DEALER role exists; the desk is run by MANAGER. Add a DEALER role with dealing-only permissions? |
| D7 | **Exposure limit unit: lots or USD?** | `Broker.totalExposureLimit` is enforced in lots but shown/compared as USD notional. Pick one. |
| D8 | **Rust cutover pricing.** | The Rust engine reads only `BrokerSymbol.spreadMarkup`. All brokers are LEGACY today, so fills use the web resolver. At cutover, group pricing would be silently lost unless ported. Must be a cutover gate. |

**Owner answers (25 Sep):**
- D1: Mirror rule stays ON (only test accounts in Reverse Trading). Must be visible and controllable in MIR (done, 1.0.24). 50005702 never goes into the Reverse Trading group; when reverse goes live it gets its own system group.
- D2: Markup is the broker's own per-group setting. No platform action.
- D3: 50005708 is a test account. No compensation.
- D4: Group = pricing tier (MT5 model). Client picks Standard/Pro/ECN at signup = client-selectable groups with a client-facing label. AccountType layer to be dropped later.
- D5: Deposits/withdrawals by admin only. Per-broker withdrawalApproval SINGLE | DUAL. Limited MANAGER login without funds rights.
- D6: DEALER role not needed now.
- D7: Lots (already enforced); fix labels.
- D8: Yes, porting group pricing to Rust is a cutover gate.
- Coverage account is exempt from the margin check (by design).

**Done:** Phase 1 items 1–6 and 9 (web 4c22927, backoffice 1.0.23 / 1.0.24, MIR 5e83609, ECN reset audit row).

---

## PHASE 1: P0 money fixes (backend-led, small UI where needed)
Web deploy paired with any backoffice change that depends on it. No UI redesign here.

1. **MIR list parsing**: read `{rows}` (ApiClient.ManageG1.cs:272). Then apply D1.
2. **ATY zeros**: create/edit store null (inherit), never 0; null out existing 0s (Futurix ECN). Then D4.
3. **DEAL ⚙ save wipes max slippage**: send only changed fields.
4. **DEAL ACCEPT ALL**: send the "at market" fillMode it promises; requote presets respect close side.
5. **Margin check on every fill path**: dealer-queue accept, desk-off auto-flush, requote accept, coverage/BOOK orders → `checkAccountPreTradeMargin`.
6. **Desk-off flush skips auto-hedge**: call the coverage hook on flushed fills.
7. **Withdrawals / transfers / debits**: free-margin check; server refuses cross-client transfers; transfers + IB payouts behind maker-checker; debit floor. Then D5.
8. **APR approve race**: status-guarded update / row lock.
9. **CLI risk-limits form wipes values**: prefill, send only changed fields.
10. **CLI change group overwrites leverage** with lower permission than a leverage edit: align permissions.
11. **LIVE account `initialBalance`** allowed without maker-checker server-side: enforce on the server, not only in UI.
12. **EXP totals**: exclude coverage legs from client totals; fix exposure units (D7); "max exposure" compares the enforced measure.
13. **Reverse IN_PLACE** leaves the hedge leg on the old side: call coverage/mirror hooks.
14. **DASH money tiles**: withdrawal sign in NET DEPOSITS / FLOW / PENDING; exclude demo + coverage from B-book P/L; state the period.
15. **Pending LIMIT/STOP trigger server-side** (fills today only while a client is connected; rejected triggers re-POST every tick).
16. **Terminal FX conversion** of P/L, equity, margin (required before any non-USD symbol/account).
17. Remaining money lines in `issues.md` (IB ×4, PSP ×2, chart ×3, marketwatch ×2, SYM/GRP/ATY): same phase, in the order listed there.

**Exit check:** DB fact checks re-run; issues.md money section = 0 open or explicitly deferred with owner sign-off.

---

## PHASE 2: P1 functional breaks
1. **Dead actions**: EXP close-by-symbol (null accountId), DEAL per-row REJECT/WITHDRAW (empty reason), DEAL resting CANCEL, ATY enable/disable, DLS void.
2. **Terminal session**: sign-out/switch close the app (single-instance mutex); remember-me revoked on plain sign-out; 2FA step has no way back; real account switcher; offline/degraded launch.
3. **Terminal trading**: chart right-click orders at 0.01 lots; bid/ask side gating; closes ignore trader SLIPPAGE MAX; SL/TP modify validated against a client price; inline SL/TP editable on close-pending rows; F9 dialog slippage/market-closed state; order ticket disabled with message in margin call.
4. **Backoffice auth/roles**: server logout on sign-out; enforce admin 2FA; SUPPORT can't open backoffice but is default invite role; nav shows screens that 403; reject needs less permission than approve; D6.
5. **Groups save side effects**: resets tier, can unset the only default, created groups never client-selectable.
6. **Live refresh gaps**: BalanceChanged topic, margin topic, symbol config not reaching terminals, stale ORDERS/BALANCE/LOG tabs, journal fetched once.
7. **EMG TYPE column** reads legacy groupType; DEAL too. Switch to category.
8. **LP/ROUTE**: invalid "ACTIVE" status; ROUTE rules stored but never read.
9. **Alerts/sounds**: alert trigger is only a LOG line; sounds cannot be muted; server sound flags ignored.
10. Remaining functional lines in `issues.md` by screen (DEAL 12, ticket 10, CFG 9, CLI 9, GRP 8, EMG 7, SEC 7…).

---

## PHASE 3: UI foundation (backoffice first)
Build once, used everywhere (design canvas boards):
- **Four action places**: Toolbar · Selection bar · Row menu (`⋯` + right-click) · Inspector. No buttons inside rows except `⋯`.
- **Shared `EntityMenu`**: one menu per entity. `entities.md` (40 entities × every place) is the source of truth for today's inconsistencies; target menus from `backoffice-context-menus-batch1.md`.
- **Components**: SelectionBar, RowActionsButton, Inspector, ConfirmDialog (states exact impact), SegmentedControl, ToggleRow, EmptyState, pickers (account / group / symbol / country).
- **Rules**: empty state on every table; no "not available yet" rows; validate on submit/blur; one home per control (dealer mode only in DEAL); system accounts excluded from pickers/radar/bulk; one orange button per screen.
- **Duplicates**: 78 backoffice controls are DUPLICATE. Each gets one home; others become links.

## PHASE 4: Backoffice screens
Order: CLI + Client 360 → EXP → DEAL → DLS → GRP (+ new-group dialog) → SYM → EMG → RISK/MRG → MIR → DEP/APR/TRX/WAL → KYC/LAR/CRM/IB → LP (ROUTE merged, hidden until bridge) → FEED → NTF/AUD → USR/SEC/CFG → DASH last (it links into all the others).
Per screen: apply Phase 3, close that screen's ux/text lines in `issues.md`, use `ui-map.md` as the before-state. Detail per screen: `backoffice-layout-batch1.md` + `backoffice-batch2.md` (now appendices of this plan).
ATY screen: removed per D4.

## PHASE 5: Trader Terminal UI
1. On-chart positions grouped (one label per side/price cluster, hover to expand; toggle All / Grouped / Off).
2. Positions table: `⋯` + right-click menu; BE/PART/MOD/SHARE/REV move into the menu; table header overlap bug.
3. One ticket component for dock + F9; button prices = order prices; order-type guidance (above market → Buy Stop).
4. One set of bulk-close buttons (tab bar).
5. Right column: collapse disabled STM; break-even/partial close move to position menu; stale sessions clock.
6. Panel layout: no dead space under market watch; resizable panels.
7. Settings: tabbed (Trading / Chart / Notifications / Workspace), modal without maximize, no "coming soon" text.
8. Remaining terminal ux/text lines in `issues.md`.

## PHASE 6: Text & hygiene
101 text lines (verbose/AI-style labels, wrong confirms such as the dealer-mode texts, removed concepts), row caps → paging/date ranges, missing AuditLog rows (PSP, CFG, sessions, desk-flush actor), deep links.

---

## How work is sent to Claude Code
- One phase at a time. Within a phase: batches of 5–8 items, each with acceptance = the issue lines it closes + a re-check.
- Phases 1–2 touch the web/API: pair each with a web deploy and state it in the batch.
- Do not start Phase 3 until Phase 1 exit check passes. Phase 2 and Phase 3 may overlap only on different screens.
- Rust cutover: D8 added to the cutover gates before any broker moves off LEGACY.
