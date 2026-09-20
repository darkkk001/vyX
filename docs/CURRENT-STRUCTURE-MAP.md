# Current-state map: order routing, groups, pricing, signup, liquidity

Written 2026-09-21 from the code on `main` (c0406db) and **read-only SELECTs
against production** (`ep-flat-boat`). Every number below is real prod data as
of that date, not an estimate. Nothing in this document describes intent or a
plan -- for where this is going, see `ACCOUNT-STRUCTURE-MIGRATION.md`.

Written because the routing model had been reasoned about from the schema
alone for months, and the schema turned out to describe something noticeably
different from what production actually does.

## The one-paragraph summary

Routing is one overloaded enum (`Group.groupType`) that conflates four
unrelated things -- the book (LP), dealer behaviour (DEALING), account mode
(DEMO) and a system role (COVERAGE) -- while the real dealer decision lives in
a *second*, independent field (`dealingMode`), and the web UI already fakes a
fifth concept ("Reverse") out of a MirrorRule lookup. Underneath all of it,
**100 % of client flow is internal B-book, auto-filled**, priced by exactly
seven `GroupSymbolConfig` rows, of which one is on an account that trades.
No liquidity provider is connected to anything.

---

## 1. Groups

`model Group` fields: `name, leverage, marginCallLevel, stopOutLevel,
isDefault, maxLotSize, tradingRestriction, tradingHaltedAt, swapFree,
restrictSymbols, forceDealingMode, groupType, dealingMode, tier`.

Only three carry routing or dealing meaning:

- `groupType` -- `LP | DEALING | DEMO | COVERAGE`
- `dealingMode` -- `INHERIT | AUTO | MANUAL`
- `forceDealingMode` -- boolean

`tier` (`STANDARD/PRO/ECN/ZERO`) is **dead**: written by both UIs and the API,
read by no logic anywhere (`grep '\.tier\b'` finds only `Broker.tier`, the
unrelated billing plan).

### The two group forms do not agree with each other

| Where | Routing options offered |
|---|---|
| Web, `app/manage/(shell)/groups/GroupsManager.tsx:64-70` | Four UI-only choices -- `B-Book (Auto)`, `A-Book (LP)`, `Dealing`, `Reverse (Mirror)` -- collapsed onto `groupType` + `dealingMode` + "does a MirrorRule source from me". Demo is deliberately NOT offered; the code comment already states "Demo is an ACCOUNT MODE, not a routing choice". |
| Backoffice 1.0.9, `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\GroupsScreen.cs:134` | Three raw choices: `("LP","A-BOOK · LP")`, `("DEALING","B-BOOK · DESK")`, `("DEMO","DEMO")`, plus the dead Tier field. |

The web UI invented a four-value routing concept the schema cannot store; the
desktop UI still writes `DEMO` as if it were a routing value.

### Real prod groups (14)

| Broker | Group | groupType | dealingMode | default | lev | accounts | mirror source | symbol overrides |
|---|---|---|---|---|---|---|---|---|
| futurixglobal | Dealing | DEALING | INHERIT | | 1000 | 4 (0 demo) | | 0 |
| futurixglobal | Reverse Trading | DEALING | AUTO | | 100 | 6 (0 demo) | yes | 1 |
| futurixglobal | Dealer Coverage (system) | COVERAGE | INHERIT | | 500 | 1 | | 0 |
| futurixglobal | B-Book | DEALING | AUTO | **yes** | 100 | **0** | | 1 |
| futurixglobal | Seawolf | LP | INHERIT | | 500 | **0** | | 3 |
| futurixglobal | Demo | DEALING | AUTO | | 100 | **0** | | 0 |
| acmefx | Standard | DEALING | INHERIT | yes | 100 | 1 | | 0 |
| acmefx | PlaywrightPricingTest-1787917614906 | DEALING | INHERIT | | 100 | 3 (3 demo) | | 1 |
| acmefx | ECN-Swap Free, Swap Free, RequestTraceTest, RobustNameTest | DEALING | INHERIT | | 100 | 0 | | 0 |
| zzzqa | Standard-USD | DEALING | INHERIT | no default set | 100 | 0 | | 1 |
| zzzqa | Second | DEALING | MANUAL | | 100 | 0 | | 0 |
| novamarkets | *(no groups at all)* | | | | | | | |

Two facts worth keeping in view: the broker's **default group (B-Book) holds
zero accounts**, and the **only LP group (Seawolf) holds zero accounts and has
never produced a position**. Three acmefx groups are test leftovers.

---

## 2. Routing: how the book is actually decided

Two separate decisions, routinely confused with each other.

**(a) A-book vs B-book** -- `resolveBookType()`, `lib/group-pricing.ts:11`:

```ts
return groupType === "LP" || groupType === "COVERAGE" ? "A_BOOK" : "B_BOOK";
```

Seven call sites, each falling back to `brokerSymbol.defaultBookType` when the
account is ungrouped: `app/api/trade/orders/route.ts:377,580`,
`app/api/trade/orders/[id]/fill/route.ts:269`,
`app/api/trade/orders/[id]/requote-response/route.ts:199`,
`app/api/manage/dealing-queue/[id]/route.ts:321`,
`app/api/manage/dealing-desk-toggle/route.ts:226`,
`app/api/manage/positions/route.ts:365`, `lib/mirror.ts:403`.

**(b) Whether a dealer sees it** -- `resolveWantsDealingQueue()`,
`lib/dealing-routing.ts`:

```ts
if (groupDealingMode === "MANUAL") return true;
if (groupDealingMode === "AUTO")   return false;
if (groupTypeIsDealing && dealingDeskAutoFillOn) return false;
return brokerDealingModeOn || groupForceDealingMode || groupTypeIsDealing;
```

Independent of the book: a `groupType=DEALING, dealingMode=AUTO` group is
B-booked *and* never dealt.

### Is any real LP bridge connected? No.

- `BrokerSymbol.defaultBookType = B_BOOK` for **all 43 enabled symbols across
  all four brokers**.
- Positions ever written: **1,556 B_BOOK, 11 A_BOOK** -- and all 11 A_BOOK rows
  belong to account `50005707`, the internal Dealer Coverage account. **No
  client order has ever been A-booked.**
- The web group form says so itself (`GroupsManager.tsx:559-562`): *"LP routing
  config isn't built yet (Phase 5). Orders in this group are marked A-Book but
  still execute against the simulated/blended price feed."*
- All four brokers: `pricingEngineEnabled = false`, `dealingModeAt = null`
  (dealer switch OFF), and zero orders have ever been in a dealer or requote
  state.

Today, everything is internal B-book, auto-filled. "A-book" is a label on a
`Position` row and nothing more.

---

## 3. Account types / tiers

Thirteen types in prod: every broker has `Standard` (default) / `Pro` / `Zero`,
plus one zzzqa test leftover. **Every one has `spreadMarkup = 0` and
`commissionPerLot = 0`.** Zero `AccountTypeSymbolConfig` rows, zero
`AccountSymbolConfig` rows.

Their pricing does not reach a fill. `resolveFillPricing()`
(`lib/pricing-engine.ts`) short-circuits on its first line:

```ts
if (!params.pricingEngineEnabled) { return resolveSymbolPricing(...) }  // Group path only
```

and `pricingEngineEnabled` is false for all four brokers. The entire
Account-Type pricing chain is storage-only.

**In other words: the GROUP is the tier today.** The spread a client actually
pays comes from `GroupSymbolConfig`, per group and per symbol. Account types
are a client-facing label with no pricing effect -- which is exactly how the
target model keeps them (client-facing tier, no routing attached).

### Commission is charged but not recorded

`chargeCommission` (`lib/group-pricing.ts`) debits the balance and writes a
`COMMISSION` Transaction, but never writes `Position.commission`. Prod proof:
**1,556 positions, zero with a non-zero `commission`**, and exactly **one
COMMISSION transaction ever** (acmefx, -$0.02). Every commission report and the
IB PERCENTAGE payout read that column, so they all read zero. Tracked as §2.1
of `WRONG-FIELD-AUDIT-2026-09-18.md`; still open.

---

## 4. Spread / pricing: the real fill-price trace

```
POST /api/trade/orders:532
  -> resolveFillPricing(pricingEngineEnabled = false, ...)        lib/pricing-engine.ts
       -> resolveSymbolPricing(groupId, symbolId, ...)            lib/group-pricing.ts
            groupId == null               -> BrokerSymbol.spreadMarkup / commissionPerLot
            GroupSymbolConfig row exists  -> its values, per field (null falls through)
            no row                        -> BrokerSymbol.spreadMarkup / commissionPerLot
  -> applySpreadMarkup({ side, price: serverRef, spreadMarkup, digits })   :546
  -> chargeCommission(...)                                                 :614
```

**What wins today: `GroupSymbolConfig`, else `BrokerSymbol`.** `AccountType`,
`AccountTypeSymbolConfig` and `AccountSymbolConfig` are all bypassed while the
flag is off.

Every enabled `BrokerSymbol` has `spreadMarkup = 0, commissionPerLot = 0`, so
the only non-zero pricing in the entire production system is these seven rows:

| Broker | Group | Symbol | spread | commission |
|---|---|---|---|---|
| futurixglobal | Seawolf | XAUUSD | 20 | 30 |
| futurixglobal | Seawolf | XPTUSD | 0 | 30 |
| futurixglobal | Seawolf | XRPUSD | 0 | 30 |
| futurixglobal | Reverse Trading | BTCUSD | **700** | 0 |
| futurixglobal | B-Book | BTCUSD | 0 | 0 |
| acmefx | PlaywrightPricingTest-1787917614906 | EURUSD | 5 | 2 |
| zzzqa | Standard-USD | EURUSD | 2 | 5 |

Seawolf's markup has never priced a fill (zero accounts). The only real-money
markup in use is Reverse Trading's BTCUSD 700.

`applySpreadMarkup` is ask-side only, so a SELL round trip pays no markup
(§3.7 of the wrong-field audit, flagged DESIGN?).

---

## 5. Signup / create: who picks what

| Path | Mode | Group | Account type |
|---|---|---|---|
| Client self-registration, `app/api/portal/register/route.ts` | -- | -- | -- (creates a `Client` row only; **no trading account at all**) |
| Client creates a demo, `app/api/portal/accounts/route.ts:75-110` | forced `DEMO` (anything else 400s) | **not offered** -- broker's `isDefault` group | optional `accountTypeId`, else broker default |
| Client requests live, `app/api/portal/live-account-requests/route.ts:60-73` | implied LIVE | **not offered** | optional `accountTypeId`, else default |
| Admin approves, `app/api/manage/live-account-requests/[id]/route.ts:88` | `LIVE` | broker's `isDefault` group | whatever the request carried |
| Backoffice Add Account, `app/api/manage/accounts/route.ts:133-220` | explicit, required | explicit `groupId`, else `isDefault` | explicit `accountTypeId`, else default |

All four funnel through `provisionAccount()` in `lib/account-provisioning.ts`.

**The client never sees or picks a group**, so routing is already broker-side
and invisible to them -- the target model matches what the code does.

**There is no validation at all** on the (mode, group, type) combination.
Nothing today stops a LIVE account in the Demo group, a demo account in the LP
group, or a client account in the system Coverage group.

Prod accounts: 24 LIVE / 9 DEMO; **18 of 33 ungrouped** (routing by
`BrokerSymbol.defaultBookType`, per symbol); one futurix LIVE account with no
type at all. The **mirror target account `50005702` (97 positions) is
ungrouped**, so the reverse book's target leg books by symbol default rather
than by any group.

---

## 6. Liquidity tab

The tables exist, are wired to a UI, and are empty and inert.

- `LiquidityProvider` -- name, contactName/Email/Phone, **`protocol` is a plain
  nullable `text` column**, status (`LpStatus`, default PROSPECTIVE), notes.
  **0 rows in prod.**
- `LpRoutingRule` -- liquidityProviderId, symbolId, priority, notes. **0 rows in
  prod.** No group reference and no connection fields of any kind.
- `GET /api/manage/liquidity` returns real open-position A/B volume aggregates
  computed from `Position.bookType`.
- `app/api/manage/lp-routing/route.ts` carries the comment *"Intended routing,
  not live routing... No execution path reads this yet."*
- `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs:18-23`:
  *"these as INTENDED routing -- no execution path reads them yet -- and every
  host says so"*; `:50-51`: *"Read-only by decision: the server also has
  POST/PATCH liquidity-providers and POST/DELETE lp-routing, unwired."*
- Confirmed by grep: no `LpRoutingRule` reference anywhere under
  `app/api/trade/`, `lib/`, or `engine/`.

The Liquidity tab today is a contact list plus a book-exposure readout. There
is no bridge, no protocol configuration, no per-group LP binding and no
execution path.

---

## The three gaps this map exposed

1. **Nothing validates (mode, group, type)** on any creation or move path.
   Closed by Stage 1 of `ACCOUNT-STRUCTURE-MIGRATION.md`
   (`lib/account-structure.ts`).
2. **`Position.commission` is never written** -- 0 of 1,556 rows -- so
   commission reporting and IB payouts read zero. Real money, already
   happening. Open; §2.1 of the wrong-field audit.
3. **The A-book label exists with no bridge behind it**, and the Liquidity tab
   has no group binding or protocol fields. Only A_BOOK groups should appear
   there, each with an MT4 / MT5 / cTrader / FIX connection; that is its own
   stage and is not built.
