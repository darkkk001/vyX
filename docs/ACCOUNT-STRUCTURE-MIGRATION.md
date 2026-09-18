# Account structure migration: Category -> Account Type -> Group -> Account

Status: PLAN, nothing built. Written 2026-09-18 from the audit in the same session (schema, prod data on
ep-flat-boat read-only, Avalonia backoffice 1.0.9, web manage UI). Review, then build stage by stage.

## 0. Target and where we are

```
TARGET   Category (A_BOOK | B_BOOK | DEALING | REVERSAL | DEMO, + COVERAGE system)
            -> Account Type (belongs to ONE category; Standard / Pro / Zero each with their own spread)
               -> Group (implements a category: leverage, margin, dealing mode, symbol allowlist)
                  -> Account (client login; one group + one type, both in the same category)

TODAY    Group.groupType  = LP | DEALING | DEMO | COVERAGE      (book routing: LP/COVERAGE -> A, else B)
         Group.tier       = STANDARD | PRO | ECN | ZERO         (label only, redundant with AccountType)
         AccountType      = per broker, NO category, pricing exists but is NOT charged
         Account          = groupId + accountTypeId, two independent flat pickers, nothing validated
         Broker.pricingEngineEnabled = false for all 4 brokers -> fills price GroupSymbolConfig -> BrokerSymbol only
         18 / 33 prod accounts ungrouped -> book via BrokerSymbol.defaultBookType (per SYMBOL), price via BrokerSymbol
```

Facts the plan depends on (verified 2026-09-18):

- Every live client fill goes through the Next.js trade routes. The Rust `engine/order-management` path prices off
  `BrokerSymbol` alone, knows nothing about groups/types/books, and has 0 rows in its own `positions` table on prod.
  It is out of scope for the money path here; it gets a follow-up note in §7.
- Book routing call sites (`resolveBookType(account.group.groupType)` else `brokerSymbol.defaultBookType`):
  `app/api/trade/orders/route.ts` (x2), `app/api/trade/orders/[id]/fill/route.ts`, `app/api/manage/dealing-queue/[id]/route.ts`,
  `app/api/manage/positions/route.ts`, `lib/mirror.ts`. Six places, one helper.
- Pricing: `lib/pricing-engine.ts::resolveFillPricing` already implements
  `AccountSymbolConfig > AccountTypeSymbolConfig > AccountType(flat) > GroupSymbolConfig > BrokerSymbol`, gated per
  broker by `pricingEngineEnabled`. `lib/pricing-shadow-compare.ts` (+ `scripts/pricing-shadow-compare.ts`,
  `GET /api/manage/pricing-shadow-compare`) computes OLD vs NEW for every (account, symbol) pair, read-only.
- Prod groups: futurixglobal `Seawolf`=LP, `B-Book`=DEALING/AUTO (default), `Reverse Trading`=DEALING/ZERO/AUTO
  (mirror source), `Dealing`=DEALING/INHERIT, `Demo`=DEALING/AUTO (0 accounts), `Dealer Coverage (system)`=COVERAGE.
  acmefx: 6 DEALING groups (default `Standard`). zzzqa: 2 DEALING. novamarkets: NO groups at all.
- Prod accounts: 9 DEMO / 24 LIVE; 3 DEMO accounts sit in non-DEMO groups; 0 LIVE in DEMO groups; 18 ungrouped;
  1 with no account type. AccountTypes: every broker has Standard(default)/Pro/Zero, all with markup 0 / comm 0,
  0 `AccountTypeSymbolConfig` rows, 0 `AccountSymbolConfig` rows.
- Backoffice 1.0.9 in the field reads `groupType` and renders unknown values verbatim (`var t => t`); its Groups form
  WRITES `LP | DEALING | DEMO`. The API must keep accepting those during the transition (§1.6).

## 1. Stage 1 - Schema + data migration (web repo, money path)

### 1.1 New enum and column, old column kept as a shadow for one release

Do NOT mutate `GroupType` in place. Postgres can add enum values but cannot drop them without recreating the type,
and an in-place rename gives no rollback. Instead:

```prisma
enum AccountCategory {
  A_BOOK     // bridged to an LP (any route: A account / cTrader / MT / FIX). Position.bookType = A_BOOK
  B_BOOK     // not bridged, auto-filled, broker holds the risk.            Position.bookType = B_BOOK
  DEALING    // dealer manually manages (queue). Dealer-mode-off ~ B_BOOK.  Position.bookType = B_BOOK
  REVERSAL   // reverse-copy source book (futures). Auto-fill.               Position.bookType = B_BOOK
  DEMO       // practice, no real money.                                     Position.bookType = B_BOOK
  COVERAGE   // system: the broker's own hedge account. Never in a picker.  Position.bookType = A_BOOK
}

model Group {
  category   AccountCategory   // NOT NULL after backfill (migration adds it nullable, backfills, sets NOT NULL)
  groupType  GroupType         // KEPT this release, read by nothing after 1.4, dropped in Stage 5
  tier       GroupTier         // KEPT this release, dropped in Stage 5 (see 1.5)
}

model AccountType {
  category   AccountCategory   // NOT NULL after backfill
  @@unique([brokerId, category, name])   // replaces @@unique([brokerId, name])
}
```

`Position.bookType` (A_BOOK/B_BOOK) stays exactly as it is: it is the per-position historical record of where the
risk went, and every exposure screen reads it. `resolveBookType` becomes:

```ts
export function resolveBookType(category: AccountCategory): BookType {
  return category === "A_BOOK" || category === "COVERAGE" ? "A_BOOK" : "B_BOOK";
}
```

Same output as today for every existing row (LP -> A_BOOK, COVERAGE -> A_BOOK, everything else B). Book routing
does not change behaviour in Stage 1; it changes its INPUT.

### 1.2 Data migration mapping - groups

Run inside the migration as SQL, in this order, first match wins:

| # | Rule (existing row)                                                            | -> category | Prod rows it hits (2026-09-18)                          |
|---|--------------------------------------------------------------------------------|-------------|---------------------------------------------------------|
| 1 | `groupType = 'COVERAGE'`                                                       | COVERAGE    | futurix `Dealer Coverage (system)`                      |
| 2 | `groupType = 'LP'`                                                             | A_BOOK      | futurix `Seawolf`                                       |
| 3 | `groupType = 'DEMO'`                                                           | DEMO        | none                                                    |
| 4 | `groupType = 'DEALING'` AND id in `MirrorRule.sourceId WHERE sourceType='GROUP'` | REVERSAL  | futurix `Reverse Trading`                               |
| 5 | `groupType = 'DEALING'` AND group has >=1 account AND every account is `accountMode='DEMO'` | DEMO | check at run time (likely none; the 3 stray demo accounts share groups with LIVE) |
| 6 | `groupType = 'DEALING'` AND `dealingMode = 'AUTO'`                             | B_BOOK      | futurix `B-Book`, futurix `Demo` (see override below)   |
| 7 | `groupType = 'DEALING'` (INHERIT or MANUAL)                                    | DEALING     | futurix `Dealing`, all acmefx, all zzzqa                |

Explicit override table, applied before the rules, for groups whose NAME says what the data does not
(`prisma/migrations/<ts>_account_category/overrides.sql`, hand-reviewed, committed):

| brokerSubdomain | group name | -> category | why                                                   |
|-----------------|------------|-------------|-------------------------------------------------------|
| futurixglobal   | Demo       | DEMO        | rule 6 would call it B_BOOK; it is the demo group, 0 accounts today |

The migration prints the full mapping (`broker, group, old groupType, old dealingMode, hasMirror, -> category`) as
NOTICEs and the same list is produced beforehand by `scripts/account-category-preview.ts` (read-only) so the
mapping is reviewed against prod BEFORE `migrate deploy`. Any group the rules map to something the preview reviewer
disagrees with goes into the override table; the migration never guesses from names except via that table.

### 1.3 Data migration mapping - account types

Existing rows have no category. Rule: an existing type is assigned the category of the accounts that use it; where
its accounts span several categories it is cloned per category and each account re-pointed to the clone of its
own category.

```
for each AccountType t:
  cats = distinct category of (account.group) over accounts where accountTypeId = t.id and groupId is not null
  if cats is empty:            t.category = category of the broker's isDefault group (else B_BOOK)   -- unused type, keep one row
  if cats has one value c:     t.category = c
  if cats has several:         t.category = the most common c; for every other c':
                                 insert clone (same name/description/hint/flat pricing/enabled, category c', isDefault=false)
                                 copy AccountTypeSymbolConfig rows (there are 0 today, but the migration must not assume that)
                                 update Account set accountTypeId = clone where group.category = c'
```

Then, per broker, guarantee the picker is never empty: for every category that has >=1 group but no enabled
type, clone the broker's default type into that category (name unchanged, e.g. a second "Standard" under DEMO).
`isDefault` becomes per-category: `@@unique([brokerId, category, isDefault]) where isDefault` is enforced in app
code (Prisma cannot express a partial unique index; add it as raw SQL in the migration:
`CREATE UNIQUE INDEX "AccountType_default_per_category" ON "AccountType"("brokerId","category") WHERE "isDefault"`).

Ungrouped accounts are NOT re-pointed here (their type keeps its category); Stage 3 groups them and re-validates.

### 1.4 Code switch (same PR as the migration, deployed together)

- `lib/group-pricing.ts::resolveBookType(category)`; the six call sites read `account.group.category`.
- `lib/account-structure.ts` (new): `assertAccountStructure({ accountMode, group, accountType })` throws a 400-shaped
  error when:
  - `accountType.category !== group.category`
  - `group.category === 'DEMO'` XOR `accountMode === 'DEMO'`
  - `group.category === 'COVERAGE'` for anything except the broker's own coverage account (`lib/coverage.ts` path)
  Called from: `POST /api/manage/accounts` (create), `PATCH /api/manage/accounts/[id]` (group change, type change),
  `POST /api/manage/live-account-requests/[id]/approve` (creates the account), the Client Portal open-account path,
  `lib/coverage.ts` provisioning, and the demo self-signup route. One helper, every writer.
- `POST/PATCH /api/manage/groups`: accept `category`; ALSO accept legacy `groupType` from backoffice 1.0.9 and map
  `LP -> A_BOOK`, `DEMO -> DEMO`, `DEALING -> (dealingMode === 'AUTO' ? B_BOOK : DEALING)`; never write REVERSAL or
  COVERAGE from the legacy field. `GET` returns BOTH `category` and a derived `groupType` (A_BOOK->LP,
  COVERAGE->COVERAGE, DEMO->DEMO, else DEALING) until backoffice 1.0.10 is the only client in the field.
- `GET/POST/PATCH /api/manage/account-types`: `category` required on create; list supports `?category=`; a type's
  category is immutable after creation (change = disable + create) so existing accounts can never silently cross.
- `POST /api/manage/accounts` accepts `accountTypeId`; when omitted, picks the per-category default type of the
  chosen group's category (today it picks the broker-wide default regardless of group).
- `lib/mirror.ts`: unchanged behaviour, reads `category` for the book. REVERSAL is a category now, so a rule can
  additionally require `sourceGroup.category === 'REVERSAL'` for GROUP-sourced rules; today it is a soft warning
  (log), it becomes a hard rule in Stage 4 once Futurix's rule points at the right group (it already does).
- Web legacy UI (`app/manage/(shell)/groups/GroupsManager.tsx`, `AccountsManager.tsx`, `SettingsManager.tsx`): replace
  `uiTypeFor` (inference from dealingMode + MirrorRule) with the real `category`; show DEMO (it is currently hidden on
  purpose, that reasoning is obsolete). These pages write the same tables, so they ship in the same PR.

### 1.5 `Group.tier`

Drop it. Evidence: `GroupTier` is passed through by `groups/route.ts`, `GroupsManager.tsx` and the Avalonia Groups
form and read by nothing else (`grep '\.tier\b'` hits only `Broker.tier`, the billing plan, which is unrelated and
stays). The account type IS the tier. Stage 1 stops writing it (the API ignores the field); Stage 5 drops the column.

### 1.6 Verification gate (before ep-flat-boat)

Local DB only. `.env` points at PROD; never run tests against it (the db-guard refuses prod hosts, keep it that way).
Scratch Postgres: the portable PG16 in the session scratchpad on :55432 (`vyx_test`) or D:\pg-scratch:5499 -
D: is the disk that failed on 2026-09-18, so recreate the scratch DB on C: first
(`initdb -U postgres -A trust`, `prisma migrate deploy`, `prisma db seed`, insert LivePrice rows).

1. `prisma migrate diff` shows exactly: new enum, two new nullable columns, two backfills, two NOT NULL, one unique
   index swap, one partial unique index. No table rewrite of `Position`/`Order`/`Transaction`.
2. `scripts/account-category-preview.ts` against a prod SNAPSHOT restored into the scratch DB
   (`pg_dump --schema-only` + `--data-only` of Broker/Group/AccountType/Account/MirrorRule/GroupSymbolConfig/
   AccountTypeSymbolConfig only; no ledger tables). Reviewer signs off the printed mapping. Expected prod result:
   Seawolf A_BOOK; B-Book B_BOOK; Reverse Trading REVERSAL; Dealing DEALING; Demo DEMO (override); Dealer Coverage
   COVERAGE; every acmefx/zzzqa group DEALING; 0 groups with category NULL after backfill.
3. Run the migration on that snapshot, then the structural asserts (`scripts/account-structure-lint.ts`, read-only,
   exits non-zero on any row):
   - no Group / AccountType with NULL category
   - no Account whose type.category != group.category (ungrouped accounts skipped until Stage 3)
   - no LIVE account in a DEMO group; the 3 DEMO accounts in non-DEMO groups are REPORTED (fixed in Stage 3)
   - exactly one isDefault type per (broker, category) that has groups
4. Existing suites on the scratch DB with `ALLOW_TEST_DB_WRITES=true`: `tests/pentest/*` (13 files), `lib/*.test.ts`,
   `app/api/manage/dealing-queue/[id]/queued-close.test.ts`, the group-type tests. All green (weekend flakiness
   noted in memory for close-by/bulk-close applies).
5. NEW adversarial tests, executed not read (`tests/pentest/account-structure.test.ts`):
   - open a market order from an account in each category -> `Position.bookType` is A for A_BOOK/COVERAGE, B for
     the other four (asserted on the Position row, not the response)
   - `PATCH accounts/[id] { groupId: <A_BOOK group> }` for an account with a B_BOOK type -> 400, row unchanged
   - `PATCH accounts/[id] { accountTypeId: <DEMO type> }` for a LIVE account -> 400
   - `POST accounts { accountMode: 'LIVE', groupId: <DEMO group> }` -> 400
   - mass-assignment: `POST accounts { groupId: <COVERAGE group> }` -> 400
   - backoffice-1.0.9 compatibility: `PATCH groups/[id] { groupType: 'LP' }` -> category A_BOOK; `{ groupType:
     'DEALING' }` on an AUTO group -> B_BOOK, on an INHERIT group -> DEALING; `GET groups` returns both fields
   - money: fill price and commission for an account in every category equal the pre-migration values for the
     same (account, symbol) - captured before the migration on the snapshot, compared after (the flag is still
     off, so they must be byte-identical)
6. Then, and only then: `grep -q ep-flat-boat-b1wjz20p .env && npx prisma migrate deploy` (never `migrate dev`),
   deploy the web build, run `scripts/account-structure-lint.ts` read-only against prod, and open one position on
   zzzqa in each category and check `Position.bookType`.

Rollback: the old `groupType` column is untouched and still populated; reverting the web deploy to the previous
build restores the old readers with zero data loss. The new columns/enum stay (additive) until Stage 5. If the
migration itself fails half-way it runs in one transaction and rolls back on its own; re-run after fixing the
override table.

## 2. Stage 2 - Turn the pricing engine on (web repo, money path)

Until this stage ships, NOTHING a broker sets on an Account Type or a per-account override changes a single fill.
The Account Types screen and the Client 360 pricing grid are storage only. This must be visible in the UI (§4.2).

1. Run the shadow compare per broker, read-only: `npx tsx scripts/pricing-shadow-compare.ts <brokerId>` (or
   `GET /api/manage/pricing-shadow-compare` as a manager). Expected today: 0 diff rows for every broker (every type
   has 0/0 pricing and there are no override rows). Any diff row must be explained by a deliberate type/override
   setting; an unexplained diff is a bug in `resolvePricingV2` and blocks the flip.
2. Unit tests: `lib/pricing-engine.test.ts` extended with the category shape - two types both named "Standard" in
   two categories with different `AccountTypeSymbolConfig` for XAUUSD; an account in each resolves its own.
3. Flip order: zzzqa (QA) -> observe 3 trading days of fills, comparing `Position.openPrice`/commission
   Transactions to the shadow prediction (a second read-only script `scripts/pricing-flip-audit.ts`: for each fill
   since the flip, recompute NEW and assert equality) -> acmefx/novamarkets (no live money) -> futurixglobal.
   The flip is `PATCH /api/admin/brokers/[id] { pricingEngineEnabled: true }` (super-admin), one broker at a time,
   audit-logged.
4. After the flip, set the FIRST real per-type spread on zzzqa (e.g. Pro XAUUSD markup 1.0) and open one position:
   the fill price must move by exactly `markup * pipSize`. That is the test that the whole structure exists for.
5. Retire the flag one release after every broker is on: delete `resolveSymbolPricing` (old path) from
   `lib/group-pricing.ts`, delete the `if (!pricingEngineEnabled)` branch, keep the column as always-true until
   Stage 5 drops it.

Rollback: flip the flag back; it is read per fill, effect is immediate, no data changes. Positions filled under the
new resolver keep their prices (they were the correct prices).

## 3. Stage 3 - Every account in a group; kill the per-symbol book fallback (web repo)

1. Backfill script `scripts/group-ungrouped-accounts.ts` (writes, guarded by an explicit `--apply` flag and the
   prod-host check), per broker:
   - LIVE ungrouped -> the broker's `isDefault` group (futurix `B-Book`, acmefx `Standard`, zzzqa `Standard-USD` after
     marking one default). novamarkets has no groups: create `Standard` (B_BOOK, default) first.
   - DEMO ungrouped, and the 3 DEMO accounts currently in non-DEMO groups -> the broker's DEMO group; create `Demo`
     (category DEMO, dealingMode AUTO, leverage/margin copied from the default group) where missing.
   - Re-point each moved account's `accountTypeId` to the per-category type of the same name (falls back to the
     category default) so `assertAccountStructure` passes for every row.
   - Prints before/after per account; dry-run by default.
2. Schema: `Account.groupId String` NOT NULL (migration fails loudly if any NULL remains - run the lint first).
   `assertAccountStructure` no longer has an "ungrouped" branch.
3. Delete the fallback at the six routing sites: `account.group.category` is always present; `brokerSymbol.defaultBookType`
   is no longer read anywhere. Drop `BrokerSymbol.defaultBookType` in Stage 5 (Stage 3 stops writing it; the
   Symbols PATCH route ignores the field so backoffice 1.0.9's toggle becomes a no-op rather than an error).
4. Pricing: `resolveFillPricing`'s `groupId: null` path disappears too.

Verification: lint script shows 0 ungrouped and 0 structure violations on the snapshot, then on prod after
`migrate deploy`; pentest `client-trade-open-pricing.test.ts` + the Stage 1 book tests green; one real open per
broker. Rollback: the column drop is Stage 5, so rolling back the web build restores the fallback readers; the
account moves are logged (AuditLog rows `ACCOUNT_GROUP_CHANGED` per account) and reversible by the same script with
`--revert <runId>`.

## 4. Stage 4 - Backoffice UI (E:\vyxtrader, ships as terminal-agnostic backoffice 1.0.10)

Requires Stage 1's API in production (the backoffice reads `category`). Nothing here touches money.

4.1 Groups (`Screens/GroupsScreen.cs`): column BOOK -> CATEGORY, value = `category` rendered as `A-BOOK · LP`,
    `B-BOOK`, `DEALING`, `REVERSAL`, `DEMO`, `COVERAGE (system)` with the existing chip colours; form field "Book" ->
    "Category" with the five client choices (COVERAGE never offered); remove the "Tier" field; the "Dealer" field stays
    but is only meaningful for DEALING (grey it out otherwise, keep the value). Group pricing grid unchanged.
4.2 Account Types (`Screens/AccountTypesScreen.cs`): CATEGORY column + a category filter chip row; create form gets a
    Category choice (immutable on edit); duplicate names across categories render as `Standard · DEMO`. Header stat
    while `pricingEngineEnabled` is false for this broker: an amber "PRICING ENGINE OFF · spreads set here are not
    applied to fills" - read from `GET /api/manage/settings` (expose the flag there; it is broker-scoped and read-only
    for managers). Disappears after Stage 2.
4.3 Account create (`Screens/ClientsScreen.cs:331`): Group choice -> filters the Account type choice to that group's
    category; Mode is derived (DEMO group -> DEMO, else LIVE) and shown read-only instead of being a free choice;
    `CreateAccountAsync` sends `accountTypeId`. "Change group" dialog re-filters the type and refuses a cross-category
    move client-side with the same message the server gives.
4.4 Client 360 (`Screens/ClientsScreen.cs:238`): card shows `Category · Group · Account type` as one line; new
    "PRICING" tab = the same grid as Groups/ATY against `GET/PATCH /api/manage/accounts/{id}/pricing` (route exists,
    `ApiClient` gets `FetchAccountPricingAsync` / `UpdateAccountPricingAsync`, same `GroupPricingRow` shape, the API
    already returns `inheritedX` per row so the grid shows the effective number, not "inherits").
4.5 Dashboard (`Screens/DashboardScreen.cs:43`): the empty BOOK column becomes CATEGORY from the account's group
    (the accounts endpoint already returns `groupId`; add `groupCategory` to `GET /api/manage/accounts` in Stage 1 so
    the table needs no second call). Position-level A/B stats stay as they are.
4.6 Symbols (`Screens/SymbolsScreen.cs:42,126`): remove the DEFAULT BOOK column and its click-to-toggle.
4.7 Liquidity (`Screens/LiquidityScreens.cs:42`): remove the hard-coded routing-rules table from the live screen
    (keep it in `Fixture.cs` for `--fixture-view` only) until a real routing-rules endpoint exists; the BOOK EXPOSURE
    panel (position aggregates) stays.
4.8 Live Exposure / Clients position tags / Dealing BOOK NOW: no change (they are correctly per-position or a verb).

Verification: `dotnet build` both apps; fixture harness captures for Groups, ATY, Clients create form, Client 360,
Dashboard, Symbols, Liquidity compared to the base (same settings, see the `--dev-dock-demo` gotcha in memory);
`--live-screens` against zzzqa after Stage 1 is on prod. Rollback: it is a client release; Velopack feed pins back to
1.0.9, and 1.0.9 keeps working against the Stage 1 API because of §1.4's dual `groupType`/`category` response.

## 5. Stage 5 - Cleanup (web repo, one release after Stage 4 is the only client)

Drop `Group.groupType` + enum `GroupType`, `Group.tier` + enum `GroupTier`, `BrokerSymbol.defaultBookType`,
`Broker.pricingEngineEnabled` (after §2.5). Remove the legacy `groupType` accept/derive shim in the groups API.
Delete `uiTypeFor` and friends from the web manage UI. Migration is destructive (column drops): run only after the
lint script has been clean on prod for a week and no 1.0.9 backoffice has authenticated in 7 days (the build
registry knows). Rollback: none needed for readers (nothing reads them by then); data is recoverable from the
pre-migration Neon branch snapshot taken immediately before `migrate deploy`.

## 6. Ownership and safe ship order

| Stage | Where            | Kind                    | Touches money | Ships as                                  |
|-------|------------------|-------------------------|---------------|-------------------------------------------|
| 1     | D: web repo      | schema + routing + API  | YES (book input, validation) | 1 migration + 1 web deploy    |
| 2     | D: web repo      | pricing flag flip       | YES (fill price) | 0 code (flip) then 1 deploy (flag retire) |
| 3     | D: web repo      | backfill + NOT NULL     | YES (removes fallback) | 1 script run + 1 migration + 1 deploy |
| 4     | E: backoffice    | UI                      | no            | backoffice 1.0.10 pack + feed             |
| 5     | D: web repo      | drops                   | no            | 1 migration + 1 deploy                    |

Order: 1 -> 2 -> 3 -> 4 -> 5. Stage 4 can be BUILT in parallel with 2/3 (it only needs Stage 1's API), but it is
not PACKED until Stage 1 is on prod, and its "pricing engine off" banner must exist if it packs before Stage 2.
Stages 1 and 3 each need a Neon branch snapshot of ep-flat-boat right before `migrate deploy` (Neon branching is
the rollback for data, the previous Vercel build is the rollback for code). Every migration is `migrate deploy`
with the `grep -q ep-flat-boat-b1wjz20p .env` guard; `migrate dev` is never run against this DB.

Parking: the Market Watch share (`wip/market-watch-shared-2026-09-18`) is unrelated and stays parked; if it lands
first it becomes 1.0.10 and this becomes 1.0.11.

## 7. Out of scope, noted

- Rust `engine/order-management` prices off `BrokerSymbol` and has no group/type/category. It is not on the live
  fill path (0 prod rows). Before it ever is, it needs the same `category` read and a port of `resolvePricingV2`
  (`prices.rs` from the WIP snapshot is the natural home). Tracked separately.
- Routing rules for A-book (which LP, by which condition) are a real feature, not a table rename; the fake table
  comes out in 4.7 and the feature gets its own plan.
- `GroupSymbolConfig` keeps existing as the group-level override under the type; the target structure says the TYPE
  carries the spread, but the group level is harmless as a fallback and removing it would change fills today.
