import type { AccountMode, RoutingCategory, GroupModeRestriction } from "@prisma/client";
import { isLpConnected } from "@/lib/liquidity";

// One helper, every writer. Stage 1 of docs/ACCOUNT-STRUCTURE-MIGRATION.md
// (§1.4): the single place that decides whether a (mode, group) pair is a
// legal account, so no route can invent its own version of the rule and no
// client can assemble an illegal one by mass-assignment.
//
// Three independent concepts (§0.1), of which this arbitrates two:
//
//   MODE          Account.accountMode -- real money or practice money
//                 (LIVE | DEMO), guarded per group by Group.modeRestriction.
//   ROUTING       Group.category -- where the order goes and who holds the
//                 risk (A_BOOK | B_BOOK | DEALING | REVERSAL | COVERAGE).
//                 Broker-side, invisible to the client.
//   ACCOUNT TYPE  AccountType -- the client-facing tier (Standard/Pro/Zero),
//                 each with its own spread. It carries NO routing, so any
//                 type is valid with any group: there is nothing to check
//                 between them, and a "Pro" client learns nothing about how
//                 the broker books them.
//
// What is deliberately NOT an error: a DEMO account in a B_BOOK or DEALING
// group. That is the normal, intended shape -- a demo is only useful if it
// routes like the live product it is practising for -- and it is exactly
// what POST /api/portal/accounts (demo self-signup) already creates by
// dropping every self-made demo account into the broker's default group.
// The three prod DEMO accounts that sit in non-demo groups are legal for
// the same reason.

export type StructureGroup = {
  id?: string;
  category: RoutingCategory;
  modeRestriction: GroupModeRestriction;
};

export type StructureInput = {
  accountMode: AccountMode;
  group: StructureGroup | null;
  // Set by lib/coverage.ts (and only by it) when provisioning the broker's
  // own hedge account, which is the one account allowed into a COVERAGE
  // group. Everything else is refused there.
  allowCoverage?: boolean;
};

export type StructureViolation = { code: string; message: string };

// A_BOOK bridges to a real liquidity provider and COVERAGE is the broker's
// own market-facing hedge -- practice money cannot go to either, whatever
// Group.modeRestriction happens to say. Keeping this in code rather than
// relying on the column means a hand-edited row cannot open the hole.
const LIVE_MONEY_ONLY: RoutingCategory[] = ["A_BOOK", "COVERAGE"];

export function checkAccountStructure(input: StructureInput): StructureViolation | null {
  const { accountMode, group } = input;

  // Ungrouped accounts (18 on prod today) have nothing to validate against
  // until Stage 3 gives every account a group -- while groupId is null,
  // every routing call site falls back to BrokerSymbol.defaultBookType.
  if (!group) return null;

  if (group.category === "COVERAGE" && !input.allowCoverage) {
    return {
      code: "COVERAGE_GROUP_RESERVED",
      message: "the dealer coverage group is system-owned and cannot be assigned to a client account",
    };
  }

  if (accountMode === "DEMO" && LIVE_MONEY_ONLY.includes(group.category)) {
    return {
      code: "DEMO_IN_LIVE_MONEY_GROUP",
      message: `a demo account cannot be placed in a ${group.category} group: practice money is never bridged to a liquidity provider`,
    };
  }

  // Owner decision (2026-09-26, Phase 2 batch 2): an A_BOOK group takes no accounts until a liquidity provider is
  // connected (lib/liquidity.ts) -- every creation path (lib/account-provisioning.ts) and every group move
  // (app/api/manage/accounts/[id], a group switched to A_BOOK with accounts in it) runs this check.
  if (group.category === "A_BOOK" && !isLpConnected(group)) {
    return {
      code: "LP_NOT_CONNECTED",
      message: "no liquidity provider is connected to this A-book group yet, so accounts can't be added to it",
    };
  }

  if (accountMode === "DEMO" && group.modeRestriction === "LIVE_ONLY") {
    return { code: "GROUP_IS_LIVE_ONLY", message: "this group accepts live accounts only" };
  }

  if (accountMode === "LIVE" && group.modeRestriction === "DEMO_ONLY") {
    return { code: "GROUP_IS_DEMO_ONLY", message: "this group accepts demo accounts only" };
  }

  return null;
}

// Throwing wrapper for call sites that would rather not branch. Routes use
// `checkAccountStructure` directly so they can return the 400 themselves
// with the route's own error shape.
export class AccountStructureError extends Error {
  readonly code: string;
  constructor(v: StructureViolation) {
    super(v.message);
    this.name = "AccountStructureError";
    this.code = v.code;
  }
}

export function assertAccountStructure(input: StructureInput): void {
  const violation = checkAccountStructure(input);
  if (violation) throw new AccountStructureError(violation);
}

// Which modes a group will accept, for a picker that wants to grey out the
// impossible choice rather than let the server reject it (backoffice 4.3,
// web Add-account form). Same rules as above, in the positive direction.
export function allowedModesFor(group: StructureGroup): AccountMode[] {
  if (LIVE_MONEY_ONLY.includes(group.category)) return ["LIVE"];
  if (group.modeRestriction === "LIVE_ONLY") return ["LIVE"];
  if (group.modeRestriction === "DEMO_ONLY") return ["DEMO"];
  return ["LIVE", "DEMO"];
}
