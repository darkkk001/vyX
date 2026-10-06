import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Rust cutover Stage 6 (docs/STAGE6-PLAN.md): who acts on an account's risk -- SL / TP, stop-out, margin call.
//
// An account is RUST-owned when its broker's riskAuthority is RUST AND (the broker is not demo-only, or the account is a
// DEMO account). Otherwise the web owns it, exactly as before Stage 6. The engine uses the SAME rule
// (engine/order-management/src/authority.rs RUST_ACCOUNT_SQL); a parity test pins the two.
//
// Two layers, so exactly one side writes:
// 1. selection: a web risk pass leaves RUST-owned accounts out (cheap, the common case);
// 2. the write: every risk write of the web (an automatic close, the margin-call flag) re-checks ownership INSIDE its
//    own transaction with the broker row locked FOR SHARE. A flip (UPDATE "Broker") therefore waits for every risk
//    write already in flight, and every risk write that starts after the flip sees the new owner. The engine does the
//    same in its close / edge transactions. A pass that read WEB before a flip simply finds its writes refused after it.

export type RiskOwner = "WEB" | "RUST";

type AuthorityFields = { riskAuthority: "WEB" | "RUST"; riskAuthorityDemoOnly: boolean };

/** The rule, on already-loaded fields. */
export function riskOwnerOf(broker: AuthorityFields, accountMode: "DEMO" | "LIVE"): RiskOwner {
  if (broker.riskAuthority !== "RUST") return "WEB";
  return !broker.riskAuthorityDemoOnly || accountMode === "DEMO" ? "RUST" : "WEB";
}

/** Prisma filter: accounts the WEB owns (a risk pass's account list). */
export const WEB_OWNED_ACCOUNT: Prisma.AccountWhereInput = {
  NOT: {
    broker: { riskAuthority: "RUST" },
    OR: [{ broker: { riskAuthorityDemoOnly: false } }, { accountMode: "DEMO" }],
  },
};

/** Inside a risk write's transaction: does the web own this account right now? Locks the broker row FOR SHARE until
 *  the transaction ends, so a concurrent flip waits for this write (and this write waits for a flip in flight). */
export async function webOwnsRiskInTx(tx: Prisma.TransactionClient, accountId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ rust: boolean }[]>`
    SELECT (b."riskAuthority" = 'RUST' AND (NOT b."riskAuthorityDemoOnly" OR a."accountMode" = 'DEMO')) AS rust
    FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId"
    WHERE a.id = ${accountId}
    FOR SHARE OF b`;
  // no account: nothing to protect, and nothing the engine could own either
  return rows.length === 0 ? true : !rows[0].rust;
}

/** Thrown inside a risk write's transaction when the account turned out to be RUST-owned: rolls the write back. */
export class RiskAuthorityMoved extends Error {
  constructor(accountId: string) {
    super(`risk authority of account ${accountId} is RUST: the web does not act`);
  }
}

// ---- Mixed clusters (demo-only scope): a WEB account touched by an ENGINE close's follow-up ----
// The engine queues a close's follow-ups (mirror target close, auto-hedged coverage leg close, client release) in the
// PostCloseEffect outbox and a dispatcher runs them shortly after; the web runs its own inline. When a RUST-owned
// client's close has a follow-up on a WEB-owned account (a live master, the coverage account), the web must not stop
// out a position that follow-up is about to close -- the engine's own rule (book.rs pending_follow_up_state, Stage 4.5),
// ported. Only POSITION_CLOSED rows the engine queued exist in that table, so with every broker WEB this never fires.

/** The same window as engine FOLLOW_UP_DEFER_SECS: past it, a stuck outbox no longer holds the account back. */
export const ENGINE_FOLLOW_UP_DEFER_SECS = 30;

/** One index probe: is any engine follow-up pending at all? (The common case: no, and nothing else runs.) */
export async function anyEngineFollowUpPending(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ any: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "PostCloseEffect" WHERE status = 'PENDING' AND kind = 'POSITION_CLOSED') AS any`;
  return rows[0]?.any === true;
}

/** True when a fresh (under ENGINE_FOLLOW_UP_DEFER_SECS) pending engine follow-up will still touch one of this
 *  account's OPEN positions: the account waits for it (the next pass evaluates it). */
export async function engineFollowUpOwed(accountId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ fresh: boolean }[]>`
    WITH owed AS (
      SELECT e."createdAt" FROM "PostCloseEffect" e
      JOIN "MirrorLink" ml ON ml."sourcePositionId" = e."positionId"
      JOIN "Position" t ON t.id = ml."targetPositionId"
      WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('mirror' = ANY(e."doneSteps"))
        AND t."accountId" = ${accountId} AND t.status = 'OPEN'
      UNION ALL
      SELECT e."createdAt" FROM "PostCloseEffect" e
      JOIN "Position" s ON s.id = e."positionId"
      JOIN "Position" leg ON leg.id = s."coveragePositionId"
      WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
        AND leg."accountId" = ${accountId} AND leg.status = 'OPEN' AND leg."autoHedged"
      UNION ALL
      SELECT e."createdAt" FROM "PostCloseEffect" e
      JOIN "Position" client ON client."coveragePositionId" = e."positionId"
      WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
        AND client."accountId" = ${accountId} AND client.status = 'OPEN'
    )
    SELECT coalesce(bool_or("createdAt" > now() - (${ENGINE_FOLLOW_UP_DEFER_SECS}::int * interval '1 second')), false) AS fresh FROM owed`;
  return rows[0]?.fresh === true;
}
