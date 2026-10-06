import "server-only";
import fs from "node:fs";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { riskOwnerOf, type RiskOwner } from "@/lib/risk-authority";

// Rust cutover Stage 6: the DATABASE side of the risk-authority split (the pure rule is lib/risk-authority.ts).
//
// Two jobs, both reading the broker's `riskAuthority` / `riskAuthorityDemoOnly` and the account's `accountMode`:
//
// 1. loadRiskOwners / webOwnedAccountIds: a PREFILTER. Every web path that ACTS on risk (the margin-monitor route, the
//    price-feed tick path, the engine hook's ?symbols= calls, SL / TP, stop-out, margin-call notices, resting-order
//    triggers) drops the accounts the engine owns before it evaluates them. A read; it can be a moment stale.
//
// 2. assertRiskActorInTx: the HANDOFF. The acting transaction (a risk close, a margin-call set / clear, a resting-order
//    claim) reads the owner INSIDE itself, with the account row locked (FOR NO KEY UPDATE) and the broker row locked
//    FOR SHARE, and refuses with NotRiskOwnerError when it is not the owner. A flip is an UPDATE of "Broker": it waits
//    for every transaction holding the share lock, and every transaction that starts after it commits sees the new
//    value. So at any instant exactly one side can pass, whatever the prefilter said. The engine does the same
//    (engine/order-management/src/authority.rs lock_owner_in_tx). The lock order Position -> Account -> Broker is the
//    one every close already follows (no new deadlock cycle), and FOR SHARE does not conflict with the FK checks.
//
// Pre-migration safety: before the Stage 6 migration there are no riskAuthority columns, and every broker is WEB by
// definition. A missing column therefore answers "WEB" instead of failing the whole risk path (deploy order is
// migration -> web -> engine, but a web that lands first must not stop acting on risk). It is re-probed every 30 s
// while absent and never again once seen.

type Db = Pick<PrismaClient, "$queryRaw"> | Pick<Prisma.TransactionClient, "$queryRaw">;

export class NotRiskOwnerError extends Error {
  constructor(
    public accountId: string,
    public actor: RiskOwner,
    public owner: RiskOwner
  ) {
    super(`risk action refused: account ${accountId} is owned by ${owner}, the actor is ${actor}`);
    this.name = "NotRiskOwnerError";
  }
}

let columnsPresent = false;
let columnsProbedAt = 0;
async function riskColumnsPresent(): Promise<boolean> {
  if (columnsPresent) return true;
  if (Date.now() - columnsProbedAt < 30_000) return false;
  columnsProbedAt = Date.now();
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Broker' AND column_name IN ('riskAuthority', 'riskAuthorityDemoOnly')`;
  columnsPresent = Number(rows[0]?.n) === 2;
  if (!columnsPresent) console.error("risk-owner: Broker.riskAuthority is not there yet (Stage 6 migration not applied): every account is WEB-owned");
  return columnsPresent;
}

/** The owner of each account, by the rule. Accounts that do not exist are absent from the map. */
export async function loadRiskOwners(db: Db, accountIds: string[]): Promise<Map<string, RiskOwner>> {
  const out = new Map<string, RiskOwner>();
  if (accountIds.length === 0) return out;
  if (!(await riskColumnsPresent())) {
    for (const id of accountIds) out.set(id, "WEB");
    return out;
  }
  const rows = await db.$queryRaw<{ id: string; mode: string; authority: string; demoOnly: boolean }[]>`
    SELECT a.id, a."accountMode"::text AS mode, b."riskAuthority"::text AS authority, b."riskAuthorityDemoOnly" AS "demoOnly"
    FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE a.id = ANY(${accountIds}::text[])`;
  for (const r of rows) out.set(r.id, riskOwnerOf({ riskAuthority: r.authority, riskAuthorityDemoOnly: r.demoOnly }, r.mode));
  return out;
}

/** `accountIds` without the ones the engine owns (order kept). An account that does not exist stays (the evaluators already
 *  treat it as "nothing to do"). */
export async function webOwnedAccountIds(db: Db, accountIds: string[]): Promise<string[]> {
  const owners = await loadRiskOwners(db, accountIds);
  return accountIds.filter((id) => owners.get(id) !== "RUST");
}

/**
 * The handoff check, INSIDE the acting transaction (see the top comment). Throws NotRiskOwnerError when `actor` does not
 * own the account right now; the caller lets it roll the transaction back (nothing of the action is written) and stops
 * acting on that account. Takes the account row and the broker row locks it needs; call it after the account row is
 * locked (a close) or as the first statement (a notice, a claim).
 */
export async function assertRiskActorInTx(tx: Prisma.TransactionClient, accountId: string, actor: RiskOwner): Promise<void> {
  if (!(await riskColumnsPresent())) {
    if (actor === "WEB") return; // before the migration every broker is WEB
    throw new NotRiskOwnerError(accountId, actor, "WEB");
  }
  const rows = await tx.$queryRaw<{ mode: string; authority: string; demoOnly: boolean }[]>`
    SELECT a."accountMode"::text AS mode, b."riskAuthority"::text AS authority, b."riskAuthorityDemoOnly" AS "demoOnly"
    FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE a.id = ${accountId}
    FOR NO KEY UPDATE OF a FOR SHARE OF b`;
  if (rows.length === 0) throw new Error(`account ${accountId} not found`);
  const owner = riskOwnerOf({ riskAuthority: rows[0].authority, riskAuthorityDemoOnly: rows[0].demoOnly }, rows[0].mode);
  if (owner !== actor) throw new NotRiskOwnerError(accountId, actor, owner);
}

/** Runs a risk write; a NotRiskOwnerError (the account changed hands) is answered with `null` instead of thrown. */
export async function unlessNotOwner<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof NotRiskOwnerError) return null;
    throw err;
  }
}

/**
 * The risk action trace: one JSON line per risk action this process takes, appended to the file named by
 * VYX_RISK_ACTION_TRACE (nothing when unset: production). The split proofs (scripts/stage6, lib/risk-split.test.ts)
 * read it to attribute every action to the side that took it; the engine writes the same format
 * (authority.rs trace_action).
 */
export function traceRiskAction(actor: RiskOwner, kind: string, accountId: string, reference: string): void {
  const file = process.env.VYX_RISK_ACTION_TRACE;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ actor, kind, accountId, ref: reference, ts: Date.now() }) + "\n");
  } catch {
    // a trace that cannot be written never changes what the action does
  }
}
