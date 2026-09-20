# Account structure migration: Routing category (x Mode) -> Account Type -> Group -> Account

Status: PLAN, nothing built. Written 2026-09-18 from the audit in the same session (schema, prod data on
ep-flat-boat read-only, Avalonia backoffice 1.0.9, web manage UI).

REVISED 2026-09-21: the first draft's category enum conflated two independent things -- MODE (Live/Demo) and
ROUTING (how the order goes out and who holds the risk). They are separated throughout now; the corrected model
is §0.1 and the Stage 1 mapping (§1.2) is rewritten on both axes. Review, then build stage by stage.

## 0. Target and where we are

```
TARGET   ROUTING CATEGORY (A_BOOK | B_BOOK | DEALING | REVERSAL optional, + COVERAGE system)
            -> Account Type (belongs to ONE routing category; Standard / Pro / Zero each with their own spread)
               -> Group (implements a routing category: leverage, margin, dealing mode, symbol allowlist)
                  -> Account (client login; one group + one type, both in the same routing category)

         x MODE  Account.accountMode = LIVE | DEMO    (exists today, unchanged, NOT part of the category)
                 every real client account is LIVE; DEMO is the practice opposite. Orthogonal to routing:
                 a LIVE account can be A-booked, B-booked or dealer-managed, and so can a DEMO one.

TODAY    Group.groupType  = LP | DEALING | DEMO | COVERAGE      (book routing: LP/COVERAGE -> A, else B)
         Group.tier       = STANDARD | PRO | ECN | ZERO         (label only, redundant with AccountType)
         AccountType      = per broker, NO category, pricing exists but is NOT charged
         Account          = groupId + accountTypeId, two independent flat pickers, nothing validated
         Broker.pricingEngineEnabled = false for all 4 brokers -> fills price GroupSymbolConfig -> BrokerSymbol only
         18 / 33 prod accounts ungrouped -> book via BrokerSymbol.defaultBookType (per SYMBOL), price via BrokerSymbol
```

### 0.1 The two axes (corrected 2026-09-21)

The first draft put `DEMO` inside the category enum. That made "is this practice money?" and "where does the risk
go?" the same choice, which is wrong in both directions: a demo account could not be B-booked or dealer-managed
without lying about one of them, and a broker who wants demo fills to behave exactly like live fills had no way to
express it. The two axes are independent and multiply:

| Axis | Where it lives | Values | What it decides |
|------|----------------|--------|-----------------|
| MODE | `Account.accountMode` -- exists today, does not move | `LIVE` \| `DEMO` | Real money or practice money. Every real client account is LIVE. Drives reporting filters (`reports/*` already filter `accountMode: "LIVE"`), the transfer same-mode guard, the portal self-signup. Nothing about routing. |
| ROUTING | `Group.category` + `AccountType.category` -- new | `A_BOOK` \| `B_BOOK` \| `DEALING` \| `REVERSAL` (optional) \| `COVERAGE` (system) | How the order goes out and who holds the risk. Drives `Position.bookType`, the dealing queue, the mirror. Nothing about real vs practice money. |

- **LP group (`A_BOOK`)** -- bridged out to an LP. `Position.bookType = A_BOOK`.
- **B-book group (`B_BOOK`)** -- not bridged, auto-filled, the broker covers/holds the risk.
- **Dealing group (`DEALING`)** -- a dealer manages it (auto or manual accept, per `dealingMode`).
- **`REVERSAL` is OPTIONAL** -- some brokers run a reverse-copy book, most do not. The enum value always exists
  (it costs nothing), no broker is required to have a group in it, and the backoffice hides the choice for a
  broker with no `MirrorRule` rows. The core three are A_BOOK / B_BOOK / DEALING.
- **`COVERAGE` is system-owned** -- the broker's own hedge account, never offered in a picker.

**What routing may a DEMO account have?** Anything except `A_BOOK` and `COVERAGE`: you cannot bridge practice
money to a real LP, and the coverage account is the broker's own. `B_BOOK` and `DEALING` are both legitimate and
both useful -- `DEALING` is how a dealer practises against demo flow. `REVERSAL` is allowed but pointless.

**Account type x mode -- resolved.** The type carries the routing category and the spread; it does NOT get a mode.
A DEMO account uses **the same type as the live product it is practising for, in demo mode**.

1. The point of a demo is that the numbers match the live product. A parallel "Demo Standard" type guarantees the
   two drift apart the first time someone edits one of them.
2. `AccountType` has no mode column today, and every broker's Standard/Pro/Zero is already shared by the 9 DEMO
   and 24 LIVE prod accounts. A mode dimension would double every broker's type list for no pricing gain.
3. A broker who genuinely wants different demo pricing already has two ways to get it without a new dimension:
   a demo GROUP carrying its own `GroupSymbolConfig`, or just another ordinary type they point demo accounts at.
   Neither needs the schema to know what "demo" means.

So `AccountType.category` is routing only, and the account rule is `accountType.category === group.category` with
mode never consulted.

**Keeping the group called "Demo" meaningful.** Dropping `DEMO` from the enum removes the only thing that stopped
a LIVE account being dropped into it. That guard comes back as a restriction on the group, not as a category:

```prisma
enum GroupModeRestriction { ANY  LIVE_ONLY  DEMO_ONLY }

model Group {
  modeRestriction GroupModeRestriction @default(ANY)
}
```

`A_BOOK` and `COVERAGE` groups behave as `LIVE_ONLY` whatever the column says (enforced in
`assertAccountStructure`, §1.4, not written into data). Futurix's `Demo` group becomes
`category = B_BOOK, modeRestriction = DEMO_ONLY`, which is what its name always meant.

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
- Prod accounts: 9 DEMO / 24 LIVE (`Account.accountMode`); 3 DEMO accounts sit in groups whose `groupType` is
  not DEMO (legal under the corrected model, §0.1); 0 LIVE in a `groupType='DEMO'` group; 18 ungrouped;
  1 with no account type. AccountTypes: every broker has Standard(default)/Pro/Zero, all with markup 0 / comm 0,
  0 `AccountTypeSymbolConfig` rows, 0 `AccountSymbolConfig` rows.
- Backoffice 1.0.9 in the field reads `groupType` and renders unknown values verbatim (`var t => t`); its Groups form
  WRITES `LP | DEALING | DEMO`. The API must keep accepting those during the transition (§1.6).

## 1. Stage 1 - Schema + data migration (web repo, money path)

### 1.1 New enum and column, old column kept as a shadow for one release

Do NOT mutate `GroupType` in place. Postgres can add enum values but cannot drop them without recreating the type,
and an in-place rename gives no rollback. Instead:

```prisma
enum RoutingCategory {           // named for what it is (§0.1): routing, never mode
  A_BOOK     // bridged to an LP (any route: A account / cTrader / MT / FIX). Position.bookType = A_BOOK
  B_BOOK     // not bridged, auto-filled, broker holds the risk.             Position.bookType = B_BOOK
  DEALING    // dealer manages the queue (auto/manual). Dealer-off ~ B_BOOK. Position.bookType = B_BOOK
  REVERSAL   // OPTIONAL, not core: reverse-copy source book. Auto-fill.     Position.bookType = B_BOOK
  COVERAGE   // system: the broker's own hedge account. Never in a picker.   Position.bookType = A_BOOK
}
// There is deliberately NO DEMO value. Mode is Account.accountMode (LIVE|DEMO), which already exists,
// is already correct, and is not touched by this migration.

enum GroupModeRestriction {      // which modes may sit in this group -- a guard, not a category
  ANY                            // default: LIVE and DEMO accounts both allowed
  LIVE_ONLY
  DEMO_ONLY                      // what a group named "Demo" actually meant
}

model Group {
  category        RoutingCategory      // NOT NULL after backfill (added nullable, backfilled, then SET NOT NULL)
  modeRestriction GroupModeRestriction @default(ANY)
  groupType       GroupType            // KEPT this release, read by nothing after 1.4, dropped in Stage 5
  tier            GroupTier            // KEPT this release, dropped in Stage 5 (see 1.5)
}

model AccountType {
  category   RoutingCategory   // NOT NULL after backfill. No mode dimension -- see §0.1 "Account type x mode".
  @@unique([brokerId, category, name])   // replaces @@unique([brokerId, name])
}
```

`Account` is untouched by this migration: `accountMode` already carries the mode and keeps carrying it.

`Position.bookType` (A_BOOK/B_BOOK) stays exactly as it is: it is the per-position historical record of where the
risk went, and every exposure screen reads it. `resolveBookType` becomes:

```ts
export function resolveBookType(category: RoutingCategory): BookType {
  return category === "A_BOOK" || category === "COVERAGE" ? "A_BOOK" : "B_BOOK";
}
```

Same output as today for every existing row (LP -> A_BOOK, COVERAGE -> A_BOOK, everything else B -- including the
old DEMO groups, which now carry B_BOOK and booked B before too). Book routing does not change behaviour in
Stage 1; it changes its INPUT.

### 1.2 Data migration mapping - groups

Two columns are backfilled per group, one per axis. Run inside the migration as SQL, first match wins:

| # | Rule (existing row)                                                             | -> category | -> modeRestriction | Prod rows it hits (2026-09-18) |
|---|---------------------------------------------------------------------------------|-------------|--------------------|--------------------------------|
| 1 | `groupType = 'COVERAGE'`                                                        | COVERAGE    | LIVE_ONLY          | futurix `Dealer Coverage (system)` |
| 2 | `groupType = 'LP'`                                                              | A_BOOK      | LIVE_ONLY          | futurix `Seawolf`              |
| 3 | `groupType = 'DEMO'`                                                            | B_BOOK      | DEMO_ONLY          | none on prod                   |
| 4 | `groupType = 'DEALING'` AND id in `MirrorRule.sourceId WHERE sourceType='GROUP'` | REVERSAL    | ANY                | futurix `Reverse Trading`      |
| 5 | `groupType = 'DEALING'` AND `dealingMode = 'AUTO'`                              | B_BOOK      | ANY                | futurix `B-Book`, futurix `Demo` (see override) |
| 6 | `groupType = 'DEALING'` (INHERIT or MANUAL)                                     | DEALING     | ANY                | futurix `Dealing`, all acmefx, all zzzqa |

**Deleted from the first draft:** the rule "`groupType = 'DEALING'` AND every account in it is
`accountMode='DEMO'` -> DEMO". That rule read the MODE of the members to guess the group's ROUTING, which is the
exact conflation this revision removes. With the axes split there is nothing to infer: a group full of demo
accounts keeps whatever routing it has, and gets `DEMO_ONLY` only if a human says so (override table below).

Explicit override table, applied before the rules, for groups whose NAME says what the data does not
(`prisma/migrations/<ts>_routing_category/overrides.sql`, hand-reviewed, committed):

| brokerSubdomain | group name | -> category | -> modeRestriction | why                                             |
|-----------------|------------|-------------|--------------------|-------------------------------------------------|
| futurixglobal   | Demo       | B_BOOK      | DEMO_ONLY          | rule 5 gets the routing right (B-book) but not the restriction; "Demo" is a mode statement, so it becomes the restriction. 0 accounts today. |

Two prod facts the mapping must not break:

- futurix's **default** group is `B-Book`, and `POST /api/portal/accounts` (demo self-signup,
  `app/api/portal/accounts/route.ts:99-110`) puts every self-created DEMO account into the broker's `isDefault`
  group. So `B-Book` must stay `ANY`, not `LIVE_ONLY`, or demo signup starts 400-ing. This is the corrected model
  working as intended: demo accounts routing B-book alongside live ones.
- The **3 DEMO accounts sitting in non-DEMO groups** stop being an anomaly. Under the corrected model a DEMO
  account in a `B_BOOK` or `DEALING` group is legal and normal; they are only a violation if that group is
  `A_BOOK`/`COVERAGE`/`LIVE_ONLY` (none of them is). Stage 3 no longer has to move them.

The migration prints the full mapping (`broker, group, old groupType, old dealingMode, hasMirror, memberModes,
-> category, -> modeRestriction`) as NOTICEs, and the same list is produced beforehand by
`scripts/routing-category-preview.ts` (read-only) so it is reviewed against prod BEFORE `migrate deploy`. Any
group the rules map to something the reviewer disagrees with goes into the override table; the migration never
guesses from names except via that table.

### 1.3 Data migration mapping - account types

Existing rows have no category. Rule: an existing type is assigned the routing category of the accounts that use
it; where its accounts span several categories it is cloned per category and each account re-pointed to the clone
of its own category. Mode plays no part -- a type is never cloned per mode (§0.1).

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

A type shared by LIVE and DEMO accounts is NOT split -- that is the intended end state, not a problem to fix.
It only splits when its accounts sit in groups of different routing categories.

Then, per broker, guarantee the picker is never empty: for every routing category that has >=1 group but no
enabled type, clone the broker's default type into that category (name unchanged, e.g. a second "Standard" under
A_BOOK). `isDefault` becomes per-category: `@@unique([brokerId, category, isDefault]) where isDefault` is enforced
in app code (Prisma cannot express a partial unique index; add it as raw SQL in the migration:
`CREATE UNIQUE INDEX "AccountType_default_per_category" ON "AccountType"("brokerId","category") WHERE "isDefault"`).

Ungrouped accounts are NOT re-pointed here (their type keeps its category); Stage 3 groups them and re-validates.

### 1.4 Code switch (same PR as the migration, deployed together)

- `lib/group-pricing.ts::resolveBookType(category)`; the six call sites read `account.group.category`.
- `lib/account-structure.ts` (new): `assertAccountStructure({ accountMode, group, accountType })` throws a 400-shaped
  error when:
  - `accountType.category !== group.category`  (routing must agree -- mode is never consulted in this check)
  - `accountMode === 'DEMO'` and the group is `A_BOOK` or `COVERAGE` (practice money cannot be bridged to a real
    LP, and the coverage account is the broker's own), or the group is `modeRestriction = 'LIVE_ONLY'`
  - `accountMode === 'LIVE'` and the group is `modeRestriction = 'DEMO_ONLY'`
  - `group.category === 'COVERAGE'` for anything except the broker's own coverage account (`lib/coverage.ts` path)

  What is explicitly NOT an error any more: a DEMO account in a `B_BOOK` or `DEALING` group. That is the normal,
  intended shape (a demo routes like the live product it practises for), it is what the portal's demo self-signup
  already creates, and the 3 prod DEMO accounts in non-DEMO groups stop being violations.

  Called from: `POST /api/manage/accounts` (create), `PATCH /api/manage/accounts/[id]` (group change, type change),
  `POST /api/manage/live-account-requests/[id]/approve` (creates the account), the Client Portal open-account path,
  `lib/coverage.ts` provisioning, and the demo self-signup route. One helper, every writer.
- `POST/PATCH /api/manage/groups`: accept `category` and `modeRestriction`; ALSO accept legacy `groupType` from
  backoffice 1.0.9 and map `LP -> A_BOOK (LIVE_ONLY)`, `DEMO -> B_BOOK + modeRestriction DEMO_ONLY`,
  `DEALING -> (dealingMode === 'AUTO' ? B_BOOK : DEALING)` leaving `modeRestriction` untouched; never write
  REVERSAL or COVERAGE from the legacy field. `GET` returns `category`, `modeRestriction`, and a derived
  `groupType` for the old client: `modeRestriction === 'DEMO_ONLY' -> DEMO` (checked first, so 1.0.9 still shows
  the demo group as demo), else `A_BOOK -> LP`, `COVERAGE -> COVERAGE`, everything else `DEALING`. The shim goes
  when backoffice 1.0.10 is the only client in the field.
- `GET/POST/PATCH /api/manage/account-types`: `category` required on create; list supports `?category=`; a type's
  category is immutable after creation (change = disable + create) so existing accounts can never silently cross.
- `POST /api/manage/accounts` accepts `accountTypeId`; when omitted, picks the per-category default type of the
  chosen group's category (today it picks the broker-wide default regardless of group).
- `lib/mirror.ts`: unchanged behaviour, reads `category` for the book. REVERSAL is a category now, so a rule can
  additionally require `sourceGroup.category === 'REVERSAL'` for GROUP-sourced rules; today it is a soft warning
  (log), it becomes a hard rule in Stage 4 once Futurix's rule points at the right group (it already does).
- Web legacy UI (`app/manage/(shell)/groups/GroupsManager.tsx`, `AccountsManager.tsx`, `SettingsManager.tsx`): replace
  `uiTypeFor` (inference from dealingMode + MirrorRule) with the real `category`, and show `modeRestriction` as a
  separate field next to it -- never as a sixth category. The reason DEMO was hidden in these pickers was that it
  was a fake category; as a mode restriction it is an ordinary field and shows normally. These pages write the same
  tables, so they ship in the same PR.

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
2. `scripts/routing-category-preview.ts` against a prod SNAPSHOT
   (`pg_dump --schema-only` + `--data-only` of Broker/Group/AccountType/Account/MirrorRule/GroupSymbolConfig/
   AccountTypeSymbolConfig only; no ledger tables). Reviewer signs off the printed mapping. Expected prod result,
   routing then restriction: Seawolf `A_BOOK / LIVE_ONLY`; B-Book `B_BOOK / ANY`; Reverse Trading
   `REVERSAL / ANY`; Dealing `DEALING / ANY`; Demo `B_BOOK / DEMO_ONLY` (override); Dealer Coverage
   `COVERAGE / LIVE_ONLY`; every acmefx/zzzqa group `DEALING / ANY`; 0 groups with category NULL after backfill.
   No group anywhere gets a category derived from the mode of its members.
3. Run the migration on that snapshot, then the structural asserts (`scripts/account-structure-lint.ts`, read-only,
   exits non-zero on any row):
   - no Group / AccountType with NULL category
   - no Account whose type.category != group.category (ungrouped accounts skipped until Stage 3)
   - no DEMO account in an `A_BOOK` or `COVERAGE` group, and none in a `LIVE_ONLY` group
   - no LIVE account in a `DEMO_ONLY` group
   - a DEMO account in a `B_BOOK`/`DEALING` group is NOT reported -- it is the intended shape (the 3 prod rows)
   - exactly one isDefault type per (broker, category) that has groups
4. Existing suites on the scratch DB with `ALLOW_TEST_DB_WRITES=true`: `tests/pentest/*` (13 files), `lib/*.test.ts`,
   `app/api/manage/dealing-queue/[id]/queued-close.test.ts`, the group-type tests. All green (weekend flakiness
   noted in memory for close-by/bulk-close applies).
5. NEW adversarial tests, executed not read (`tests/pentest/account-structure.test.ts`):
   - open a market order from an account in each routing category -> `Position.bookType` is A for A_BOOK/COVERAGE,
     B for the other three (asserted on the Position row, not the response)
   - the same order from a DEMO account in a B_BOOK group and from a LIVE account in the same group -> identical
     `bookType`, identical fill price, identical commission (mode must not touch routing or money)
   - `PATCH accounts/[id] { groupId: <A_BOOK group> }` for an account with a B_BOOK type -> 400, row unchanged
   - `PATCH accounts/[id] { groupId: <A_BOOK group> }` for a DEMO account -> 400, row unchanged
   - `POST accounts { accountMode: 'LIVE', groupId: <DEMO_ONLY group> }` -> 400
   - `POST accounts { accountMode: 'DEMO', groupId: <B_BOOK ANY group> }` -> 201 (legal, and it is what the portal
     demo self-signup does today -- this test exists to stop a future "tighten demo" patch breaking signup)
   - `POST /api/portal/accounts { accountMode: 'DEMO' }` end-to-end still provisions into the broker's default
     group with the broker's default type
   - backoffice-1.0.9 compatibility: `PATCH groups/[id] { groupType: 'LP' }` -> category A_BOOK; `{ groupType:
     'DEALING' }` on an AUTO group -> B_BOOK, on an INHERIT group -> DEALING; `{ groupType: 'DEMO' }` -> B_BOOK +
     DEMO_ONLY; `GET groups` returns category, modeRestriction AND the derived groupType (DEMO_ONLY renders as
     `DEMO` for the old client)
   - money: fill price and commission for an account in every routing category, in each mode, equal the
     pre-migration values for the same (account, symbol) - captured before the migration on the snapshot, compared
     after (the flag is still off, so they must be byte-identical)
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
   - DEMO ungrouped -> the same default group as LIVE unless the broker has a `DEMO_ONLY` group, in which case
     that one. Demo accounts already in a `B_BOOK`/`DEALING` group are LEFT WHERE THEY ARE -- under the corrected
     model (§0.1) that is legal and is what the portal signup creates; the first draft moved them because DEMO was
     a category, and that move is now deleted. A `Demo` group (category B_BOOK, modeRestriction DEMO_ONLY,
     dealingMode AUTO, leverage/margin copied from the default group) is created only where a broker actually
     wants a separate demo group, not automatically.
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
    `B-BOOK`, `DEALING`, `REVERSAL`, `COVERAGE (system)` with the existing chip colours, plus a separate MODE
    column showing `modeRestriction` (`ANY` renders blank, `LIVE ONLY` / `DEMO ONLY` as a small chip) -- two
    columns because they are two axes. Form: "Book" -> "Category" with the client choices (COVERAGE never offered;
    REVERSAL only offered when the broker has >=1 MirrorRule, per §0.1) and a separate "Accepts" choice for the
    mode restriction, forced to LIVE ONLY and read-only when the category is A_BOOK. Remove the "Tier" field; the
    "Dealer" field stays but is only meaningful for DEALING (grey it out otherwise, keep the value). Group pricing
    grid unchanged.
4.2 Account Types (`Screens/AccountTypesScreen.cs`): CATEGORY column + a category filter chip row; create form gets a
    Category choice (immutable on edit); duplicate names across categories render as `Standard · DEMO`. Header stat
    while `pricingEngineEnabled` is false for this broker: an amber "PRICING ENGINE OFF · spreads set here are not
    applied to fills" - read from `GET /api/manage/settings` (expose the flag there; it is broker-scoped and read-only
    for managers). Disappears after Stage 2.
4.3 Account create (`Screens/ClientsScreen.cs:331`): Group choice -> filters the Account type choice to that
    group's routing category. Mode stays a real, independent choice (it is `Account.accountMode`, not something to
    derive from the group -- the first draft had it derived and read-only, which was the conflation in UI form);
    it is only constrained by the chosen group's `modeRestriction`: a LIVE_ONLY or A_BOOK group greys out DEMO, a
    DEMO_ONLY group greys out LIVE, `ANY` leaves both. `CreateAccountAsync` sends `accountTypeId` and
    `accountMode`. "Change group" dialog re-filters the type and refuses a cross-category or mode-restricted move
    client-side with the same message the server gives.
4.4 Client 360 (`Screens/ClientsScreen.cs:238`): card shows `Mode · Category · Group · Account type` as one line
    (mode first, it is the thing a support agent checks); new "PRICING" tab = the same grid as Groups/ATY
    against `GET/PATCH /api/manage/accounts/{id}/pricing` (route exists,
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
