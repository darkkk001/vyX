import type { Prisma, PrismaClient } from "@prisma/client";
import type { RiskRadarPayload } from "@/lib/risk-radar-cache";
import type { RiskRadarRow } from "@/lib/risk-radar";

type Db = PrismaClient | Prisma.TransactionClient;

// Step 3b item 6 (owner 2026-10-07): Risk radar flag / whitelist / note. Marks are applied when the radar is READ (the radar itself
// stays in its 5-minute cache), so a change shows at once.
export type RiskMark = { flagged: boolean; whitelisted: boolean; note: string };
export const NO_MARK: RiskMark = { flagged: false, whitelisted: false, note: "" };
export const MAX_NOTE_LENGTH = 500;

export async function loadRiskMarks(db: Db, brokerId: string): Promise<Map<string, RiskMark>> {
  const rows = await db.riskAccountMark.findMany({ where: { brokerId }, select: { accountId: true, flagged: true, whitelisted: true, note: true } });
  return new Map(rows.map((r) => [r.accountId, { flagged: r.flagged, whitelisted: r.whitelisted, note: r.note }]));
}

export function patternFlagCount(r: RiskRadarRow): number {
  return (r.scalpFlag ? 1 : 0) + (r.martingaleFlag ? 1 : 0) + (r.latencyArbFlag ? 1 : 0) + (r.newsTraderFlag ? 1 : 0);
}

/** Flagged in the radar's sense: a whitelist wins (never flagged), a manual flag counts, else any behaviour pattern. */
export function effectivelyFlagged(r: RiskRadarRow, mark: RiskMark | undefined): boolean {
  if (mark?.whitelisted) return false;
  if (mark?.flagged) return true;
  return patternFlagCount(r) > 0;
}

export type MarkedRow = RiskRadarRow & { flagged: boolean; whitelisted: boolean; note: string };

export function applyRiskMarks(payload: RiskRadarPayload, marks: ReadonlyMap<string, RiskMark>): Omit<RiskRadarPayload, "rows"> & { rows: MarkedRow[] } {
  return { ...payload, rows: payload.rows.map((r) => { const m = marks.get(r.accountId) ?? NO_MARK; return { ...r, flagged: m.flagged, whitelisted: m.whitelisted, note: m.note }; }) };
}

/** The RDR badge: flagged accounts (marks applied) + same-IP clusters. */
export function riskRadarBadgeCountWithMarks(payload: RiskRadarPayload, marks: ReadonlyMap<string, RiskMark>): number {
  return payload.rows.filter((r) => effectivelyFlagged(r, marks.get(r.accountId))).length + payload.sameIpClusters.length;
}

export type MarkInput = { flagged?: unknown; whitelisted?: unknown; note?: unknown };
export type MarkResult = { ok: true; mark: RiskMark } | { ok: false; error: string };

/** The mark after a change: only the keys sent change; a flag and a whitelist never hold together. */
export function nextMark(current: RiskMark, input: MarkInput): MarkResult {
  const next = { ...current };
  if (input.flagged !== undefined) { if (typeof input.flagged !== "boolean") return { ok: false, error: "flagged must be true or false" }; next.flagged = input.flagged; }
  if (input.whitelisted !== undefined) { if (typeof input.whitelisted !== "boolean") return { ok: false, error: "whitelisted must be true or false" }; next.whitelisted = input.whitelisted; }
  if (input.note !== undefined) {
    if (typeof input.note !== "string") return { ok: false, error: "note must be text" };
    const n = input.note.trim();
    if (n.length > MAX_NOTE_LENGTH) return { ok: false, error: `the note is at most ${MAX_NOTE_LENGTH} characters` };
    next.note = n;
  }
  if (next.flagged && next.whitelisted) return { ok: false, error: "an account is flagged or whitelisted, not both: remove one first" };
  return { ok: true, mark: next };
}

export const markIsEmpty = (m: RiskMark) => !m.flagged && !m.whitelisted && m.note.length === 0;
