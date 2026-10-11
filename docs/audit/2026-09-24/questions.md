# Audit questions: answers (2026-09-25)

DB evidence comes from the LIVE DB only. Before every run, the host was printed as `ep-morning-glade-b23tui1g-pooler.c-6.eu-central-1.aws.neon.tech`. Every query ran inside `prisma.$transaction` and started with `SET TRANSACTION READ ONLY`. Only SELECT was used. Web code is at D: main HEAD `74b3c02`. Native code is from E:\vyxtrader\src.

---

## 1. Is AccountType symbol pricing read by the pricing engine? Does Standard spreadMarkup=30 affect fills now?

**Answer: YES, the resolver reads it. NO, the 30 does not affect fills now, because the row was deleted at 2026-09-24 11:45:48 UTC. It did affect 13 LIVE fills on 50005708 between 04:23 and 04:32 UTC on 24 Sep.**

Code path:
- Every fill site calls `resolveFillPricing`. Examples: MARKET fill at `app/api/trade/orders/route.ts:543`, Smart-Dealer accept at `:369`, triggered pending order at `app/api/trade/orders/[id]/fill/route.ts:229`, dealer queue at `app/api/manage/dealing-queue/[id]/route.ts:302`, requote at `.../requote-response/route.ts:188`, mirror at `lib/mirror.ts:367`.
- `lib/pricing-engine.ts:314`: when `pricingEngineEnabled` is false, it uses the old group-only resolver `lib/group-pricing.ts:63`. That resolver reads only GroupSymbolConfig and falls back to BrokerSymbol (`:80-94`). It never reads AccountType.
- `lib/pricing-engine.ts:324`: when the flag is true, it calls `resolveSymbolPricingV2`. That function fetches AccountSymbolConfig, AccountTypeSymbolConfig, AccountType, Group and GroupSymbolConfig (`:242-257`). The precedence is set in `resolvePricingV2` (`:134-141`): AccountSymbolConfig > AccountTypeSymbolConfig > AccountType flat > GroupSymbolConfig > BrokerSymbol. `targetTotalSpreadPips` is turned into a markup by `resolveEffectiveSpreadMarkup` (`:199`).
- The fill price is `applySpreadMarkup(...pricing.spreadMarkup...)` at `app/api/trade/orders/route.ts:557`. The quote display uses the same resolver when the flag is on (`app/api/trade/prices/route.ts:117-150`).
- The Rust engine does not read AccountType pricing. Its only markup source is `COALESCE(bs."spreadMarkup",0)` from BrokerSymbol (`engine/order-management/src/db.rs:447`). This does not matter today because every broker has `executionEngine = LEGACY`, so fills go through the web routes above.

DB state now:
```
SELECT name,"pricingEngineEnabled" FROM "Broker"  -> Futurix Global: true (all 4 brokers true)
SELECT * FROM "AccountTypeSymbolConfig"            -> [] (0 rows, every broker)
SELECT * FROM "AccountSymbolConfig"                -> [] (0 rows)
AccountType Futurix Standard (caf6eafd…): spreadMarkup NULL, commissionPerLot NULL
GroupSymbolConfig for Futurix Standard group       -> [] (0 rows)
BrokerSymbol Futurix XAUUSD                        -> spreadMarkup 0, commissionPerLot 0
```
So Standard XAUUSD now resolves to BrokerSymbol markup 0, which is the raw feed spread.

Audit trail (`AuditLog`, entityId = Standard type caf6eafd…, symbolId cmsz4t3k5000gvcz4vgh48uuw = XAUUSD):
| UTC | action | effect |
|---|---|---|
| 24 Sep 03:07:49 | ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED (admin cmt3okaj…) | targetTotalSpreadPips 30 |
| 24 Sep 03:23:10 | ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED (admin cmt3okaj…) | target → null, **spreadMarkup 30 (pips = 300 points)** |
| 24 Sep 05:04:46 | ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED (actor null, script) | spreadMarkup null, targetTotalSpreadPips 3 |
| 24 Sep 11:45:48 | ACCOUNT_TYPE_SYMBOL_PRICING_RESET (actor null, script) | row deleted ("remove the Standard XAUUSD override entirely (raw spread)") |

Fills that the override affected. Query: Standard-type XAUUSD positions bucketed by `openedAt`:
```
before 03:23: 167 | 03:23-05:04 (markup 30 pips): 13 | 05:04-11:45 (target 3 pips): 0 | after reset: 15
```
All 13 fills in the markup window are on **50005708 (LIVE)**, 0.01 lot each. There were 8 BUYs at 04:23:54-04:24:04 (open 4288.33-4288.47) and 5 SELLs at 04:32:02-03 (open 4286.90). All 13 are CLOSED.

---

## 2. Is there an active MirrorRule for Reverse Trading / Reverse Master 50005702? Why does MIR show 0 rules?

**Answer: YES, there is 1 ENABLED rule in the DB. MIR shows 0 because of a client-side parsing bug.**

```
SELECT … FROM "MirrorRule" JOIN "Account" target …
-> id cmti5p021000die04mc1ovjwe, broker Futurix Global, sourceType GROUP,
   sourceId cmti5dibe0001jy04m4zhlbsj (= "Reverse Trading" group, category REVERSAL),
   target 50005702, direction REVERSE, enabled true, killedAt null, failureCount 0, created 2026-09-01 04:17
```
- Accounts in the Reverse Trading group: 50005698, 50005699, 50005700, 50005701, 50005703, 50005706 (all ACTIVE). Any new fill on these accounts is still mirrored. The rule lookup matches on source account id or source group id (`lib/mirror.ts:225-227`). The last MIRROR_FILLED audit row is dated 2026-09-15 20:53.
- The target 50005702 is no longer in a REVERSAL group. An `ACCOUNT_GROUP_CHANGED` audit row dated 2026-09-21 03:36 ("Stage 3a") moved it to Futurix **Standard** (category B_BOOK).
- Why MIR is empty:
  - `GET /api/manage/mirror-rules` returns an object `{ rows, groups, accounts }` (`app/api/manage/mirror-rules/route.ts:93-101`).
  - The backoffice calls `FetchMirrorRulesAsync` → `ListAsync` (`Vyx.Shared/Api/ApiClient.ManageG6.cs:159`).
  - `ListAsync` adds items only when the response root is a JSON **array** (`Vyx.Shared/Api/ApiClient.ManageG1.cs:272-279`). An object root produces an empty list with Ok = true.
  - `MirrorScreen.RefreshAsync` → `Render([])` → "no mirror rules" and "0 ACTIVE OF 0" (`Vyx.Backoffice.App/Screens/ApprovalsMirrorScreens.cs:124-137`).
  - The same file already handles `rows` for other calls (`:229`, `:240`), but the rules list does not.
- Side effect: the MIR screen cannot show, disable or kill this live rule. The toggle at `:140-144` needs a row to act on.
- The GRP screen does show "· MIRROR" on the Reverse Trading row, because `hasMirrorRule` comes from `app/api/manage/groups/route.ts:87`.

---

## 3. Maker-checker: how many distinct admins are required? Can a single-admin broker ever approve?

**Answer: 2 distinct admins are required, but only for 3 flows. A broker with one BROKER_ADMIN can never complete a withdrawal. Futurix is in exactly that position.**

| Flow | When two admins are needed | Self-approval block | Who can be the checker |
|---|---|---|---|
| Withdrawal | Always, for any role. The first APPROVE only marks the request, and a different admin must complete it. | `lib/funds-approval.ts:29-35` | BROKER_ADMIN, or MANAGER with FUNDS_APPROVAL (`app/api/manage/funds-requests/[id]/route.ts:27`, `lib/permissions.ts:15-21`) |
| Deposit | Never. One approval completes it. | `lib/funds-approval.ts:26-28` | same |
| Balance adjustment | Only when a MANAGER makes the request (`lib/balance-adjustment.ts:40-42`). BROKER_ADMIN applies it directly (`app/api/manage/accounts/[id]/adjust-balance/route.ts:63-75`). | `lib/balance-adjustment.ts:129` | BROKER_ADMIN, or MANAGER with ACCOUNT_FINANCE (`app/api/manage/balance-adjustment-requests/[id]/approve/route.ts:17-25`) |
| Position void / reverse / delete | Only when a MANAGER makes the request (`lib/position-actions.ts:22-24`). BROKER_ADMIN runs it directly. | `lib/position-actions.ts:539` | BROKER_ADMIN, or MANAGER with ACCOUNT_FINANCE (`app/api/manage/position-action-requests/[id]/approve/route.ts:20-28`) |

- SUPPORT can never hold FUNDS_APPROVAL, because `hasPermission` returns false for any role that is not MANAGER (`lib/permissions.ts:18`).
- SUPER_ADMIN has no brokerId, so every manage route rejects it (`lib/permissions.ts:27`).
- Futurix admins (live DB): 1 BROKER_ADMIN (ACTIVE, no extra permissions) and 1 SUPPORT (ACTIVE, `extraPermissions` []). So only one admin can act on withdrawals, and the second APPROVE always fails with "a different staff member must confirm this withdrawal". The Futurix withdrawal count in the live DB is 0 today, so nothing is stuck yet.
- Balance adjustments and position actions still work for a single-admin broker, because the BROKER_ADMIN path skips maker-checker entirely.
- AcmeFX has 1 BROKER_ADMIN and 1 MANAGER. Nova Markets has 2 BROKER_ADMIN, which is the only broker able to run withdrawal maker-checker as it stands.

---

## 4. EMG groups table: which field feeds the TYPE column?

**Answer: `groupType`, the legacy pre-Stage-1 shadow column, not `category`.**
- `Vyx.Backoffice.App/Screens/SecurityEmergencyScreens.cs:93` defines the column `("type","TYPE")`. `:145` fills it with `.Set("type", g.GroupType, …)`.
- `GroupType` is parsed from JSON `groupType` (`Vyx.Shared/Api/ApiClient.ManageG2.cs:22`). The record comment at `:15-16` says "GroupType and Tier are the pre-Stage-1 shadow columns … nothing here reads them". EMG and DEAL do read GroupType (`DealingScreen.cs:603`, `:1380`), so the comment is wrong.
- The server derives `groupType` from category on each write through `legacyGroupTypeFor`: COVERAGE→COVERAGE, DEMO_ONLY→DEMO, A_BOOK→LP, everything else→DEALING (`lib/group-routing.ts:104-107`).
- Live effect (Futurix): EMG shows **DEALING** for "Reverse Trading" (category REVERSAL), "Standard" and "Demo" (B_BOOK). It shows **LP** for "Seawolf" (A_BOOK). GRP shows ROUTING from `Category` (`GroupsScreen.cs:68`), so the two screens label the same group differently.

---

## 5. Price-alert engine on FEED: where is it read from, and why "NOT REACHABLE"?

**Answer: FEED reads `alertStats` from `GET /api/manage/feed-health`. The server fills it by calling `${TRADING_CORE_URL}/internal/alert-stats`. "NOT REACHABLE" means that server-side call returned no JSON object.**
- Client:
  - `FetchFeedHealthAsync` → `/api/manage/feed-health` (`Vyx.Shared/Api/ApiClient.ManageG5.cs:74-78`).
  - `AlertsUp => AlertStats is not null` (`:35`). `Sec("alertStats")` is null unless the value is a JSON object (`:38-41`).
  - Tile text is `up ? "CONNECTED" : "NOT REACHABLE"` (`Vyx.Backoffice.App/Screens/LiquidityScreens.cs:247-248`). The panel empty text is "alert-stats not answering" if the core is up and "core not reachable" if not (`:283`).
- Server (Vercel):
  - `fetchStats(`${TRADING_CORE_URL}/internal/alert-stats`)` has a 2 s timeout and sends header `x-internal-secret` (`app/api/manage/feed-health/route.ts:71-90`, `:103-106`).
  - Any non-2xx response, timeout or network error becomes `null`.
  - `TRADING_CORE_URL` defaults to `http://127.0.0.1:8081` (`:71`), which cannot be reached from Vercel.
- Engine:
  - `/internal/alert-stats` is registered in the same secret-guarded sub-router as `/internal/feed-stats` (`engine/server/src/main.rs:1601-1602`). The handler always returns JSON (`:1075-1077`).
  - The route has existed since 3101568 (2026-09-03).
  - So in the current engine code, alert-stats fails only when feed-stats also fails: same URL, same secret, same process.
- If TRADING CORE also shows NOT REACHABLE, the cause is that Vercel cannot reach `TRADING_CORE_URL`. That could be unset, a loopback default, not exposed, or a wrong secret. `docs/RUST-CUTOVER-PLAN.md:1337-1341` already records that "whether Vercel reaches TRADING_CORE_URL" is unverified.
- If TRADING CORE shows CONNECTED but alerts do not, the deployed engine binary does not match D: code.
- Live cause: **UNVERIFIED**. The Vercel env value is a secret, and live HTTP probes were out of scope for this read-only audit.

---

## 6. Which roles exist, and is there a DEALER role?

**Answer: 4 admin roles: SUPER_ADMIN, BROKER_ADMIN, SUPPORT, MANAGER. There is NO DEALER role.**
- Schema: `enum AdminRole` (`prisma/schema.prisma:57-66`). Live DB check: `SELECT unnest(enum_range(null::"AdminRole"))` returns exactly those 4.
- Dealing routes accept `MANAGER` or `BROKER_ADMIN` (for example `app/api/manage/dealing-queue/[id]/route.ts:35`), so the dealer desk is run by MANAGER.
- The Team screen offers `BROKER_ADMIN, MANAGER, SUPPORT` (`Vyx.Backoffice.App/Screens/TeamScreen.cs:31`).
- Delegation is through `extraPermissions` from a fixed list of 8 (`lib/permission-labels.ts:11-20`). None of them is a dealing permission.
- Live counts: SUPER_ADMIN 1. Futurix: BROKER_ADMIN 1, SUPPORT 1. AcmeFX: BROKER_ADMIN 1, MANAGER 1. Nova: BROKER_ADMIN 2, MANAGER 2 (DISABLED). QA: BROKER_ADMIN 1, MANAGER 1.
- Traders (Account, Client) are separate models, not roles.

---

## 7. Equity shows "—" for accounts without positions (CLI, WAL). Where is that decided?

**Answer: on the server, `computeAccountMarginSnapshots` only builds rows for accounts that have OPEN positions. Screens that look an account up in that list show "—" when it is missing.**
- `lib/margin.ts:32-34` iterates `position.findMany({ where: { brokerId, status: "OPEN" } })`. An account with no open position gets no snapshot. `/api/manage/margin` returns only those rows (`app/api/manage/margin/route.ts:16-42`).
- WAL:
  - `FetchMarginAsync` (`WalletsLeadsScreens.cs:39`).
  - Missing row gives `m is null ? "—"` for EQUITY and FREE MARGIN (`WalletsLeadsScreens.cs:70`).
  - The header total falls back to `Balance + Credit` for the same accounts (`:74`), so the header and the rows disagree.
- DSH does the same (`DashboardScreen.cs:249`).
- CLI: the CLI list columns (`ClientsScreen.cs:51-53`) and the client card (`:282-290`) have **no Equity field** in the code. The "—" the user reported on CLI is **UNVERIFIED**, because no CLI element renders equity.

---

## 8. Is a new order rejected server-side when free margin < 0 or the margin level is below the margin-call level?

**Answer: YES for margin-increasing orders on the auto-fill paths. NO for hedging orders, by design. NO margin check at all on the dealer-queue accept path.**
- `checkAccountPreTradeMargin` (`lib/margin.ts:238-330`):
  - Equity = balance + credit + floating P/L.
  - Used margin is hedged (from 2026-09-25).
  - If the order does not increase hedged used margin, it returns null and is allowed "whatever the level" (`:318-320`).
  - Otherwise `checkPreTradeMargin` rejects when the projected level ≤ `Group.marginCallLevel` (`:199-213`), returning INSUFFICIENT_MARGIN or INSUFFICIENT_BALANCE.
- It is called at MARKET auto-fill (`app/api/trade/orders/route.ts:579`, 400 at `:591`), Smart-Dealer accept (`:391`), triggered pending fill (`app/api/trade/orders/[id]/fill/route.ts:261`) and mirror target (`lib/mirror.ts:392`).
- It is **not called** in `app/api/manage/dealing-queue/[id]/route.ts` (no "margin" string in the file). A queued order is stored without a margin check (`orders/route.ts:300-349`, `:483-534`), and a dealer accept opens it unchecked. The same applies to `dealing-desk-toggle`'s auto-flush fill (`app/api/manage/dealing-desk-toggle/route.ts:227`).
- 50005708 (live DB):
  - Group Standard, marginCallLevel 100, stopOutLevel 20, leverage 1:1000, balance 499.30, credit 0.
  - 2 open XAUUSD BUY 0.5 (tickets 100002413/100002414, 03:37-03:38 UTC 25 Sep). `marginCallNotifiedAt` 2026-09-25 03:44:55.
  - At 95% any new BUY, or any order that adds margin, would be refused server-side with INSUFFICIENT_MARGIN.
  - A SELL XAUUSD up to the hedged size would be allowed, because it lowers used margin (`lib/margin.ts:318-320`).
  - The Standard group is `dealingMode AUTO`, so its orders never reach the unchecked queue path (`lib/dealing-routing.ts:42`).
- Terminal: the order ticket has no margin-based enable gate. `OrderTicketPanel.axaml` has no IsEnabled binding. The rejection is shown after the fact as "not enough free margin" (`Vyx.Trader.App/Services/MarketDataService.cs:896`).

---

## 9. Dealer mode: every place that can toggle it, and which field each writes

Backoffice (Avalonia):
| Where | Control | Endpoint | Field written |
|---|---|---|---|
| DEAL header (`DealingScreen.cs:513-514`) | SWITCH TO DEALER ON / SWITCH TO AUTO-FILL | PATCH `/api/manage/dealing-desk-toggle` `{dealerOn}` (`ApiClient.ManageG2.cs:243`) | `Broker.dealingDeskAutoFillAt` (null = dealer on) (`app/api/manage/dealing-desk-toggle/route.ts:80`). Turning it off auto-flushes the queue (audit DEALING_DESK_AUTO_FLUSHED, 24 Sep 02:31) |
| DEAL (`DealingScreen.cs:590`) | auto-hedge toggle | same route `{autoHedge}` (`ApiClient.ManageG2.cs:246`) | `Broker.autoHedgeAt` (a related switch, not queueing) |
| RSK settings (`RiskScreen.cs:80-82`) | Manual dealing TURN ON / TURN OFF | PATCH `/api/manage/risk` `{dealingMode}` | `Broker.dealingModeAt` (`app/api/manage/risk/route.ts:101`) |
| GRP edit form (`GroupsScreen.cs:184`, `:190`, `:197-198`) | "Dealer" choice INHERIT / AUTO / MANUAL, "Force dealer mode" toggle | PUT `/api/manage/groups/{id}` | `Group.dealingMode`, `Group.forceDealingMode` (`app/api/manage/groups/[id]/route.ts:78-79`, `:119`) |

- Trader terminal: none. There is no dealing endpoint in `Vyx.Trader.App`. The only "dealing" string is a requote comment at `ViewModels/DockViewModels.cs:244`.
- Web (still deployed): `components/admin/DealerDeskToggle.tsx`, `app/manage/(shell)/risk/RiskSettingsManager.tsx` and `app/manage/(shell)/groups/GroupsManager.tsx` write the same 3 fields.
- How the fields combine is decided by `resolveWantsDealingQueue` (`lib/dealing-routing.ts:41-44`):
  - MANUAL means always queue. AUTO means never queue, and ignores both broker switches.
  - For INHERIT: the DEALING type with the desk in auto-fill gives no queue. Otherwise the order queues when `dealingModeAt`, `forceDealingMode` or groupType DEALING is set.
- Live Futurix state:
  - `dealingModeAt` null, `dealingDeskAutoFillAt` 2026-09-24 02:31 (desk = AUTO-FILL), `autoHedgeAt` null.
  - Standard, Demo and Reverse Trading groups are AUTO, so neither RSK "Manual dealing ON" nor DEAL "DEALER ON" would queue their orders.
  - The RSK confirm text "Every market order will wait in the dealer queue." (`RiskScreen.cs:81`) and the DEAL confirm "Route every market order to the dealer queue" (`DealingScreen.cs:513`) are both inaccurate for AUTO groups.

---

## 10. Terminal sign-out and switch-account close the whole app. Why?

**Answer: both run `SignOutAsync`, which starts a new copy of the exe and then shuts down. The new copy loses the single-instance lock to the process that is still exiting, so it exits too.**
- Both menu items call `SignOutAsync`. "Switch account…" calls `SignOutAsync(false)` (`Vyx.Trader.App/MainWindow.axaml.cs:238`). "Sign out" and "Sign out and forget this computer" call it too (`:243-244`). The menu is built at `Views/TopBar.axaml.cs:34-36`.
- `SignOutAsync` (`MainWindow.axaml.cs:687-695`): server sign-out → `Process.Start(exe)` → `desktop.Shutdown()`.
- The new process runs `SingleInstance.TryAcquire("VyxTrader")` first (`Vyx.Trader.App/Program.cs:177`).
  - The old process still owns the named mutex, which is held for the whole process lifetime (`Vyx.Shared.Ui/SingleInstance.cs:17`, `:32-35`).
  - So `createdNew` is false. The new process signals the old one to "surface" and returns without opening a window (`Program.cs:177`).
  - The old process then finishes `Shutdown()`, and no process is left.
- There is no in-process path back to the sign-in window. `App.axaml.cs:66-76` builds the login window only once, at startup.

---

## Issues
[money] MIR · Enabled REVERSE MirrorRule cmti5p02… (Reverse Trading group → 50005702) is live in DB but the screen lists 0 rules. ListAsync drops the `{rows}` object response, so the rule cannot be seen, disabled or killed from the backoffice · Vyx.Shared/Api/ApiClient.ManageG1.cs:272-279, ApiClient.ManageG6.cs:159, app/api/manage/mirror-rules/route.ts:93
[money] MIR · Mirror target 50005702 was moved from a REVERSAL group to Standard (B_BOOK) on 2026-09-21 while the rule targeting it stayed enabled · AuditLog ACCOUNT_GROUP_CHANGED 2026-09-21 03:36, MirrorRule.enabled=true
[money] pricing · Standard XAUUSD spreadMarkup=30 (pips = 300 points) was applied to 13 LIVE fills on 50005708 (24 Sep 04:23-04:32 UTC) before the unit fix · AuditLog ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED 03:23:10 / 05:04:46, lib/pricing-engine.ts:137
[functional] pricing · AccountTypeSymbolConfig is empty for every broker; Standard XAUUSD now fills at raw spread (BrokerSymbol markup 0) · DB SELECT AccountTypeSymbolConfig = 0 rows, AuditLog RESET 2026-09-24 11:45:48
[money] DEAL · Dealer-queue accept and desk-off auto-flush open positions with no pre-trade margin check · app/api/manage/dealing-queue/[id]/route.ts (no checkAccountPreTradeMargin), app/api/manage/dealing-desk-toggle/route.ts:227
[functional] FUN · Withdrawal maker-checker needs 2 distinct BROKER_ADMIN/MANAGER+FUNDS_APPROVAL admins; Futurix has 1 BROKER_ADMIN + 1 SUPPORT, so it cannot complete any withdrawal · lib/funds-approval.ts:29-35, lib/permissions.ts:18
[functional] EMG · TYPE column shows legacy groupType (DEALING/LP) not category (REVERSAL/B_BOOK/A_BOOK); differs from GRP ROUTING · Vyx.Backoffice.App/Screens/SecurityEmergencyScreens.cs:145, GroupsScreen.cs:68
[text] shared · ManageGroup doc comment says GroupType is read by nothing, but EMG and DEAL read it · Vyx.Shared/Api/ApiClient.ManageG2.cs:15-16, DealingScreen.cs:603
[functional] FEED · PRICE ALERTS tile is only as reachable as Vercel→TRADING_CORE_URL; default is 127.0.0.1:8081; live cause UNVERIFIED · app/api/manage/feed-health/route.ts:71,106
[ux] WAL · EQUITY / FREE MARGIN show "—" for any account with no open position while header EQUITY total uses balance+credit for them · Vyx.Backoffice.App/Screens/WalletsLeadsScreens.cs:70,74, lib/margin.ts:33-34
[ux] DSH · EQUITY shows "—" for accounts with no open position · Vyx.Backoffice.App/Screens/DashboardScreen.cs:249
[ux] terminal · Order ticket has no margin-level gate; stays enabled at 95% level / negative free margin (server rejects afterwards) · Vyx.Trader.App/Views/OrderTicketPanel.axaml (no IsEnabled binding), Services/MarketDataService.cs:896
[text] RSK · "Every market order will wait in the dealer queue." is false for groups with dealingMode AUTO (all Futurix client groups) · Vyx.Backoffice.App/Screens/RiskScreen.cs:81, lib/dealing-routing.ts:42
[text] DEAL · "Route every market order to the dealer queue for manual review?" is false for AUTO / non-DEALING groups · Vyx.Backoffice.App/Screens/DealingScreen.cs:513, lib/dealing-routing.ts:41-44
[functional] terminal · Sign out / Switch account close the app: relaunched process loses the single-instance mutex to the exiting one and exits · Vyx.Trader.App/MainWindow.axaml.cs:692-694, Program.cs:177, Vyx.Shared.Ui/SingleInstance.cs:32-35
[functional] roles · No DEALER role; dealing desk requires MANAGER or BROKER_ADMIN, no dealing permission in the delegation list · prisma/schema.prisma:57-66, lib/permission-labels.ts:11-20
