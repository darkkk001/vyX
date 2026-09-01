# VyX — Reverse Mirror v0 (Futurix demand, 2-day scope)

Branch: `feat/reverse-mirror-v0` from main. Purpose: trades from a designated group are
mirrored REVERSED into a master account, automatically, server-side. This is v0 on the
legacy order path (that's where fills happen today). Design so that Phase 3 only rewires
the execution hook to engine fill-events: schema, UI, audit, and risk logic must survive
unchanged.

## Data model (Prisma — this is the permanent shape, think before changing)
```prisma
model MirrorRule {
  id              String   @id @default(cuid())
  brokerId        String
  sourceType      MirrorSource   // GROUP | ACCOUNT
  sourceId        String         // Group.id or Account.id
  targetAccountId String         // the master account
  direction       MirrorDirection @default(REVERSE) // REVERSE | SAME
  multiplier      Decimal  @default(1)              // lot scale
  symbolFilter    String?                            // csv allowlist, null = all
  maxOpenLots     Decimal?                           // cap on target's total mirrored lots
  maxDailyLoss    Decimal?                           // kill switch threshold on target realized+floating
  enabled         Boolean  @default(true)
  killedAt        DateTime?                          // set when kill switch fires
  createdById     String
  ...timestamps
}
enum MirrorSource { GROUP ACCOUNT }
enum MirrorDirection { REVERSE SAME }
model MirrorLink {   // audit: source position ↔ mirrored position
  id String @id @default(cuid())
  ruleId String
  sourcePositionId String @unique
  targetPositionId String
  ...timestamps
}
```

## Execution hook (legacy, the only throwaway part — keep it thin)
One module `lib/mirror.ts` with `onFill(position)` and `onClose(position, closedLots)`:
- Called at the END of the existing order fill path and position close path (after commit).
- Matching: find enabled MirrorRules where source matches the account's group or account,
  same broker. Skip if symbolFilter excludes.
- REVERSE: BUY→SELL / SELL→BUY. lots = source lots × multiplier, rounded to target
  symbol's lot step, min/max respected. NO SL/TP on the mirrored position (master risk
  is the rule's caps, not per-trade).
- Execute through the SAME server-side fill function the API uses (server price, margin
  gate, audit) as the master account — do not duplicate fill logic.
- onClose: close the linked target position (partial close → proportional lots).
- Idempotent: MirrorLink.sourcePositionId unique; retry-safe.
- Failure policy: if the mirror order rejects (margin, market closed), log
  MIRROR_FAILED to AuditLog with reason, do NOT block or roll back the client's trade,
  and increment a visible failure counter on the rule.

## Risk (non-negotiable)
- Before each mirror fill: check maxOpenLots (sum of open mirrored lots on target under
  this rule) and maxDailyLoss (target account's realized P/L today + floating). Breach →
  set killedAt, disable rule, AuditLog KILL_SWITCH, notification row to all brokerAdmins.
- Manual kill switch in UI takes effect immediately (rule cache 10s max, or check DB
  per fill — volume is low, DB check is fine for v0).

## Backoffice UI (Dealing section → "Mirror" tab; institutional style)
- Rules table: source (group/account name), target, direction badge, multiplier,
  caps, enabled toggle, status (ACTIVE / KILLED / DISABLED), failures count, created by.
- Create/edit dialog: pick group or account, pick target account (must belong to same
  broker; warn if target is a client account — recommend a dedicated master), direction,
  multiplier, symbol filter, caps. RBAC: dealing.manage roles only. Maker-checker NOT
  required for v0; every change audited.
- Rule detail: open mirrored positions (source ↔ target, lots, P/L both sides), net
  strategy P/L (target account's P/L from mirrored positions), recent MIRROR_FAILED log.
- Client page: badge on accounts that are in a mirrored group ("Mirrored: Reverse ×1").

## Tests (Vitest, must-have)
fill in group → reversed fill on master at server price; multiplier + lot-step rounding;
partial close proportional; symbolFilter; maxOpenLots breach → kill + no order;
idempotency (double onFill → one mirror); mirror reject doesn't affect client fill.

## Explicitly out of scope for v0
LP destination (Phase 4), chains of rules (master → followers copier — the schema
already supports it via direction SAME, but don't wire the UI), per-trade SL/TP
mirroring, equity-proportional sizing.

## Delivery
Migration, module, hooks in the two call sites, UI tab, tests, docs/mirror.md (how
Phase 3 rewires the hook to engine events — one paragraph). Deploy: Vercel only
(legacy path lives there). No engine/gateway/EA changes.
