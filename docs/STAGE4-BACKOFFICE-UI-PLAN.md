# Stage 4: backoffice UI, broker onboarding, and plugins

Status: PLAN, nothing built. Written 2026-09-21, after Stages 1, 2 and 3a went
live on production and verified at 0 diffs.

Where the platform actually is now, since the UI still describes the old model:

- `Group.category` is the ROUTING axis (`A_BOOK | B_BOOK | DEALING | REVERSAL |
  COVERAGE`), `Group.modeRestriction` is the MODE guard, and
  `Account.accountMode` is unchanged. `Group.groupType` and `Group.tier` are
  shadow columns, read by nothing that matters, dropped in Stage 5.
- The pricing engine is ON for all four brokers. `resolvePricingV2` is what
  prices every fill.
- Every account has a group. `BrokerSymbol.defaultBookType` is still read as a
  fallback, but nothing reaches it; Stage 3b removes it.
- The dealer model is settled: a DEALING-routing group stays on `INHERIT` and
  the per-broker desk switch (`Broker.dealingDeskAutoFillAt`, written by the
  dealing screen's own toggle) decides whether flow queues. `AUTO` is a
  permanent opt-out and must not be used to mean "default".

Everything below is scoped against that. Sizes are rough: S = under a day,
M = a few days, L = a week or more.

---

## Build order at a glance

| # | Piece | Where | Size | Depends on |
|---|-------|-------|------|------------|
| 1 | Groups screen | backoffice (E:) + small API | M | nothing |
| 2 | Account Types screen | backoffice (E:) | S | 1 (shared vocabulary) |
| 5 | Symbols: drop DEFAULT BOOK | backoffice (E:) | S | Stage 3b ideally |
| 4 | Dashboard fixes | backoffice (E:) + small API | S/M | 1 |
| 6 | Broker onboarding + starter groups | web (D:) backend | M | 1, 2 |
| 3 | Liquidity tab (UI shell) | backoffice (E:) + new API | M | 1, 6; bridge = foundation |
| 7 | Plugins | web (D:) backend + backoffice (E:) | L | 1, 3, 6 |

Rationale for that order: 1 sets the vocabulary every other screen reuses, so
it goes first. 2 and 5 are small and independent. 4 needs 1's category field.
6 is backend-only and unblocks realistic testing of everything else (today you
cannot create a usable broker without hand-building it). 3 is the shell the
bridge will later plug into. 7 is the architectural piece and should not start
until the rest is stable.

---

## 1. GROUPS screen

**Where:** `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\GroupsScreen.cs`, plus
`app/api/manage/groups/route.ts` (already returns `category` and
`modeRestriction` since Stage 1, so the API is mostly done).

**Today** (`GroupsScreen.cs:134-137`) the form offers:

```csharp
BookChoices   = { ("LP","A-BOOK · LP"), ("DEALING","B-BOOK · DESK"), ("DEMO","DEMO") };
DealerChoices = { ("INHERIT","BROKER DEFAULT"), ("AUTO","AUTO-FILL"), ("MANUAL","MANUAL") };
TierChoices   = { STANDARD, PRO, ECN, ZERO };
```

Three things wrong with that: `DEMO` is offered as a routing choice when it is
a mode; there is no way to express `REVERSAL` or to see `COVERAGE`; and `Tier`
is dead (it is written by both UIs and read by nothing).

**Changes:**

- **ROUTING column and field.** Replace `Book` with `Category`, bound to
  `Group.category`. Client-selectable values: `A_BOOK`, `B_BOOK`, `DEALING`,
  and `REVERSAL` only when the broker has the Reversal plugin (piece 7) or an
  existing `MirrorRule`. `COVERAGE` is system-owned: render it, never offer it.
  Default for a new group is `B_BOOK`.
- **MODE column and field.** New, bound to `Group.modeRestriction`
  (`ANY | LIVE_ONLY | DEMO_ONLY`). Render `ANY` as blank so the grid stays
  quiet. Force `LIVE_ONLY` and make it read-only when category is `A_BOOK`,
  mirroring what `lib/group-routing.ts` already enforces server-side.
- **Remove the `DEMO` routing choice** entirely. A demo group is
  `B_BOOK` + `DEMO_ONLY`, which is exactly what the Stage 1 migration did to
  futurix's "Demo".
- **Remove the `Tier` field** and its column.
- **Per-group spread/commission stays where it is** (the existing group pricing
  grid, `GroupSymbolConfig`). This is the tier in the MT5 sense: the group
  carries the pricing. Worth a one-line caption saying so, because the
  screen currently implies the tier is the dead `Group.tier` field.
- **Dealing behaviour, surfaced honestly.** The `Dealer` field keeps its three
  values but needs its meaning on screen, because the current labels invite the
  mistake we already made once:
  - `INHERIT` -> "Dealer-controlled: queues only while the desk is ON"
  - `AUTO` -> "Never queues, even with the desk ON"
  - `MANUAL` -> "Always queues"
  Grey the field out for non-DEALING categories (keep the value). Show the
  broker's current desk state next to it, read from
  `Broker.dealingDeskAutoFillAt`, with a link to the Dealing screen's toggle.

**UI-only?** Almost. The API already returns both fields. One small backend
addition: expose the broker's desk state on the groups payload (or read it from
the existing dealing-desk endpoint) so the screen can show it without a second
round trip.

**Size:** M.

---

## 2. ACCOUNT TYPES (ATY)

**Where:** `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\AccountTypesScreen.cs`.

**Answering the question directly: does ATY fold into groups?** No, and the
two must not be merged, but the screen has to stop implying they are the same
thing.

- The **group carries the routing and, today, the pricing that actually
  applies** (`GroupSymbolConfig` -> `BrokerSymbol`). That is the MT5-style
  "group is the tier" shape, and it is what production runs on.
- The **account type is the client-facing label** the client picks at signup:
  Standard / Pro / Zero. It carries no routing at all, deliberately, so a
  client cannot infer from their tier whether the broker A-books them.
- Its pricing columns are now **NULL on every row** (Stage 2 set them so the
  chain inherits from the group). They are a real override level in
  `resolvePricingV2` that simply nobody uses yet.

So: keep the screen, change what it claims.

**Changes:**

- **Remove any "pricing engine is off" caveat.** The engine is on; a value set
  here now genuinely applies to fills. There is no such banner in the current
  `AccountTypesScreen.cs`, so this is mostly making sure the planned one from
  the Stage 1 doc never gets built.
- **Make "inherits" visible.** `MARKUP`, `COMM /LOT`, `SWAP L/S` are NULL for
  every type. Render NULL as `inherits` (not `0.00`, which reads as a
  deliberate zero spread and is exactly the ambiguity that caused the Stage 2
  incident). An explicit 0 must render as `0.00`.
- **Say where the number comes from.** A caption: "Blank inherits the group's
  pricing. A value here overrides it for every account on this type."
- **A warning on first non-null save**, because it silently overrides every
  group for accounts on that type: "This will override the group spread for N
  accounts."

**UI-only?** Yes, if the API returns null rather than coercing to `"0"`. It
currently does `t.spreadMarkup?.toString() ?? "0"`, which erases the
distinction. That coercion must be removed: small backend change, but
essential, otherwise the screen cannot tell inherit from zero.

**Size:** S.

---

## 3. LIQUIDITY tab

**Where:** `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs`,
plus new API under `app/api/manage/liquidity-*`.

**Today:** `LiquidityProvider` and `LpRoutingRule` exist, are wired to a UI, and
are **empty and inert**. `app/api/manage/lp-routing/route.ts` says so in a
comment: "Intended routing, not live routing. No execution path reads this
yet." The `RoutingRules` table in the Avalonia screen is fixture-fed.

**Changes:**

- **Only `A_BOOK` groups appear.** The tab lists groups where
  `category = 'A_BOOK'`; nothing else is bridged, so nothing else belongs here.
  Empty state: "No A-book groups. Set a group's routing to A-BOOK to bridge it."
- **Per group: enable routing -> pick LP type -> protocol fields -> TEST.**
  - LP type: `MT4 | MT5 | cTrader | FIX_API`
  - MT5/MT4: host/IP, port, login, password, optional server name
  - cTrader: host, port, client id, client secret, account id
  - FIX: host, port, SenderCompID, TargetCompID, username, password, optional
    SenderSubID/TargetSubID, heartbeat interval
  - `TEST CONNECTION` -> a backend probe returning reachable / authenticated /
    failed with a reason.
- **Remove the fixture routing-rules table** from the live screen. Keep it in
  `Fixture.cs` for `--fixture-view` only, as the current code comment already
  intends.
- **Schema.** `LiquidityProvider.protocol` is a bare nullable `text` today and
  `LpRoutingRule` has no group reference. This needs a real shape: a
  `protocol` enum, a credentials blob (encrypted at rest, never returned to the
  client), and a per-group binding. That is a migration, not a UI change.

**UI-only?** No. The screen is UI, but everything behind it is backend:
schema, credential encryption, the TEST probe, and the bridge itself.

**Flag clearly: the actual order bridging is foundation-chat work.** This piece
delivers configuration and a connectivity test. Until the bridge exists, an
A_BOOK group still books `A_BOOK` on the position row and executes internally,
exactly as the web UI already admits ("LP routing config isn't built yet ...
orders are marked A-Book but still execute against the simulated/blended price
feed"). The UI must keep saying that until it is untrue, or we will have built
a control panel for something that does not happen.

**Size:** M for the shell, L including the bridge (foundation).

---

## 4. DASHBOARD fixes

**Where:** `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DashboardScreen.cs`.

| Item | Today | Change |
|---|---|---|
| Clients table `BOOK` column (line 43) | 44px, empty | Rename to `CATEGORY`, fill from the account's group category. Needs `groupCategory` on `GET /api/manage/accounts` (small backend) |
| **New** `GROUP` column | absent | The group's name next to the category |
| `VIEW FUNDS` / `VIEW BLOCKED` (line 238) | status-dependent verb in an action column | Make it one stable action label (`FUNDS`) and show status as its own chip. The current text reads as two different actions |
| `ALL STAFF` (line 73) | static header text | Either make it a real filter (by actor) or drop it. Static text implying a filter is worse than no filter |
| `no pending withdrawals` (line 56) | empty text on a panel holding deposits too | `no pending deposits or withdrawals` |
| `A / B BOOK` stat (line 161) | per-position aggregate | Correct as is. It is per-position, which is the honest measure. Leave it |
| LP fill quality | absent | Keep as a real pending feature, rendered as an explicit "requires a bridge" empty state, tied to piece 3 |

**UI-only?** Mostly. `groupCategory` and `groupName` on the accounts endpoint
are the one backend addition.

**Size:** S, or M with the accounts-endpoint change.

---

## 5. SYMBOLS: remove DEFAULT BOOK

**Where:** `SymbolsScreen.cs:42` (the `DEFAULT BOOK` column and its
click-to-toggle).

`BrokerSymbol.defaultBookType` is the per-symbol fallback for ungrouped
accounts. After Stage 3a there are none, and Stage 3b deletes the fallback from
all seven routing call sites.

**Change:** remove the column and the toggle. The web Symbols PATCH route
should ignore the field rather than error, so a backoffice 1.0.9 still in the
field degrades to a no-op instead of failing.

**Ordering:** ideally ship after Stage 3b, so the UI stops offering a control
at the same time the value stops being read. Shipping it earlier is safe but
leaves a live column nobody can see.

**UI-only?** Yes, plus the one-line tolerant-ignore in the web route.

**Size:** S.

---

## 6. BROKER ONBOARDING AND STARTER GROUPS

**Where:** `app/api/admin/brokers/route.ts` (POST), web side.

**Current state, verified:** creating a broker writes **a `Broker` row, one
optional first `AdminUser`, and audit rows. Nothing else.** No groups, no
account types, no broker symbols. The only place an `AccountType` is ever
created outside tests is the manual Settings CRUD
(`app/api/manage/account-types/route.ts`).

So onboarding is **entirely manual today**, and the evidence is in production:
novamarkets has zero groups, zzzqa had no default group until Stage 3a, and
every broker's Standard/Pro/Zero was hand-made.

**Changes:**

- **Auto-create three starter groups** in the same transaction as the broker:
  - `Standard` - `B_BOOK`, `ANY`, `isDefault`, `INHERIT`, leverage 100, 100/50
  - `Demo` - `B_BOOK`, `DEMO_ONLY`, `INHERIT`
  - `Dealing` - `DEALING`, `ANY`, `INHERIT`
  All `INHERIT`, per the settled dealer model, with the desk switch off
  (`dealingDeskAutoFillAt = now()`) so a new broker auto-fills from day one.
- **Auto-create the three account types**: Standard (default), Pro, Zero, all
  with NULL pricing so they inherit the group.
- **Make the type picker appear in both places.** Backoffice account-create
  already sends `accountTypeId`. The website/CRM signup path
  (`app/api/portal/accounts` for demo, `app/api/portal/live-account-requests`
  for live) accepts `accountTypeId` but the client UI must actually offer the
  choice, sourced from `GET /api/portal/account-types` (which already exists
  and returns enabled types). Routing stays hidden from the client, which the
  data model now guarantees rather than merely intends.
- **Backfill** novamarkets' missing pieces (Stage 3a already gives it a
  `Standard` group; account types still need adding).

**UI-only?** No, this is backend, plus a small client-side picker on the
signup page.

**Size:** M.

---

## 7. PLUGINS

**Where:** new. Backend in `D:` (schema + API + apply logic), UI in `E:`.

This is the architectural piece and should be designed before it is built. The
goal: Reversal and Smart Dealer stop being core behaviour that every broker
carries and become opt-in modules a broker enables for a specific group.

**What exists to build on:** Reversal is already `MirrorRule` (source group ->
target account, direction, multiplier, fill price mode) plus
`Group.category = REVERSAL`. Smart Dealer is already the dealing queue plus
`lib/coverage.ts`'s system coverage account. Both are working features. Plugins
should wrap them, not reimplement them.

**Proposed shape:**

```prisma
enum PluginKey { REVERSAL  SMART_DEALER }

model BrokerPlugin {            // is this plugin available to this broker
  brokerId  String
  key       PluginKey
  enabled   Boolean  @default(false)
  @@unique([brokerId, key])
}

model GroupPlugin {             // this plugin, applied to this group
  groupId         String
  key             PluginKey
  enabled         Boolean @default(true)
  targetAccountId String?       // Reversal: mirror master. Dealer: coverage account
  config          Json          // per-plugin, validated per key
  @@unique([groupId, key])
}
```

**Flow:** pick plugin -> pick the group it applies to -> set the target account
-> optionally bridge that target to an LP (piece 3).

**Design decisions to settle before building:**

1. **Is `GroupPlugin` the source of truth, or a view over `MirrorRule`?** Two
   tables describing one behaviour will drift. I would make `GroupPlugin` the
   configuration surface and have enabling the Reversal plugin
   create/update/disable the underlying `MirrorRule` transactionally, with
   `MirrorRule` remaining what `lib/mirror.ts` reads. One writer, one reader.
2. **What does the routing category mean once plugins exist?** `REVERSAL` as a
   category and a Reversal plugin on a group are the same statement made twice.
   Cleanest: the plugin owns it - enabling Reversal on a group sets
   `category = REVERSAL`, disabling returns it to `B_BOOK`. The category stays
   the thing the fill path reads.
3. **Guard the loop we already avoided by hand.** Stage 3a deliberately kept
   the mirror target out of its own source group. The plugin must refuse that
   combination outright rather than rely on whoever configures it knowing.
4. **Coverage stays system-owned.** The Smart Dealer plugin points at the
   broker's coverage account; it must not let anyone nominate an arbitrary
   client account, and `lib/account-structure.ts` already refuses client
   accounts in a `COVERAGE` group.
5. **What happens on disable with open positions?** Reversal off while mirrored
   positions are open: stop mirroring new fills, leave existing ones. Needs
   stating in the UI, not just the code.

**UI-only?** No. Schema, API, apply logic, and validation are all backend; the
tab itself is UI.

**Size:** L. Worth splitting: 7a schema + API + Reversal only, 7b Smart Dealer,
7c the UI tab.

---

## Dependencies and sequencing

```
1 Groups ──┬── 2 ATY
           ├── 4 Dashboard
           ├── 3 Liquidity (also needs 6) ──┐
           └── 7 Plugins (also needs 3, 6) ─┴── bridge execution = FOUNDATION
6 Onboarding ── unblocks realistic testing of 1-3, 7
5 Symbols ── independent, best after Stage 3b
```

**Split by where the work lives:**

- **This chat (UI + the small APIs that feed it):** 1, 2, 4, 5, and the shells
  of 3 and 7.
- **Foundation chat (backend/infra):** the LP bridge execution behind 3, and
  arguably the plugin apply-logic in 7 if it grows into order routing.
- **Either (web backend, small):** `groupCategory`/`groupName` on the accounts
  endpoint (4), null-preserving ATY pricing (2), starter-group provisioning (6).

## Two things to decide before we start

1. **Stage 3b first?** Piece 5 and part of piece 4 are tidier once
   `defaultBookType` is gone and `groupId` is `NOT NULL`. 3b is small and the
   data is already correct, so doing it before Stage 4 would remove a caveat
   from two pieces.
2. **Does `REVERSAL` stay a routing category if it becomes a plugin?** My
   recommendation is yes (decision 2 above), because the fill path must read
   one field, not consult a plugin table. But it is worth agreeing before the
   Groups screen renders the choice.
