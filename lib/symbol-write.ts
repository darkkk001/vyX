// Symbols tab (backoffice 1.0.101): the shared write path for BrokerSymbol settings + sessions. Every route that
// changes a symbol (PATCH /symbols/[id], bulk, add, clone, import, order) writes through here, so each changed symbol
// gets exactly one AuditLog row, written in the same transaction as the change.
import type { BrokerSymbol, Prisma } from "@prisma/client";
import { changedKeys, fieldsView, type FieldKey, type FieldsView } from "@/lib/symbol-config";
import type { SessionInput } from "@/lib/symbol-sessions";

type Tx = Prisma.TransactionClient;
export type WriteCtx = { brokerId: string; adminId: string; symbolName: string; source: string };

/** One window as the audit rows write it: "2 08:00-17:00" (a QUOTE window is prefixed "QUOTE "). */
export const sessionWindow = (s: SessionInput) => `${s.kind === "QUOTE" ? "QUOTE " : ""}${s.dayOfWeek} ${s.openTime}-${s.closeTime}`;
const win = sessionWindow;
const sortKey = (s: SessionInput) => `${s.kind}${s.dayOfWeek}${s.openTime}${s.closeTime}`;

export async function readSessions(tx: Tx, brokerSymbolId: string): Promise<SessionInput[]> {
  const rows = await tx.tradingSession.findMany({ where: { brokerSymbolId }, orderBy: [{ dayOfWeek: "asc" }, { openTime: "asc" }] });
  return rows.map((r) => ({ kind: r.kind, dayOfWeek: r.dayOfWeek, openTime: r.openTime, closeTime: r.closeTime }));
}

async function replaceSessions(tx: Tx, brokerSymbolId: string, rows: SessionInput[]) {
  await tx.tradingSession.deleteMany({ where: { brokerSymbolId } });
  if (rows.length > 0) await tx.tradingSession.createMany({ data: rows.map((r) => ({ ...r, brokerSymbolId })) });
}

function sameSessions(a: SessionInput[], b: SessionInput[]) {
  return a.length === b.length && [...a].map(sortKey).sort().join("|") === [...b].map(sortKey).sort().join("|");
}

/**
 * Applies `data` (and, when given, a full session replacement) to an existing row. No change = no write and no audit
 * row. Returns the row and whether anything changed.
 */
export async function updateBrokerSymbol(
  tx: Tx,
  ctx: WriteCtx,
  existing: BrokerSymbol,
  data: Record<string, unknown>,
  sessions: SessionInput[] | null,
): Promise<{ row: BrokerSymbol; changed: boolean; changedKeys: (FieldKey | "sessions")[] }> {
  const before = fieldsView(existing);
  const row = Object.keys(data).length > 0 ? await tx.brokerSymbol.update({ where: { id: existing.id }, data: data as Prisma.BrokerSymbolUncheckedUpdateInput }) : existing;
  const after = fieldsView(row);
  const keys: (FieldKey | "sessions")[] = changedKeys(before, after);
  let sessionsBefore: SessionInput[] | null = null;
  if (sessions) {
    sessionsBefore = await readSessions(tx, existing.id);
    if (!sameSessions(sessionsBefore, sessions)) {
      await replaceSessions(tx, existing.id, sessions);
      keys.push("sessions");
    }
  }
  if (keys.length === 0) return { row, changed: false, changedKeys: keys };
  const pick = (v: FieldsView) => Object.fromEntries(keys.filter((k): k is FieldKey => k !== "sessions").map((k) => [k, v[k]]));
  await tx.auditLog.create({
    data: {
      brokerId: ctx.brokerId,
      actorAdminId: ctx.adminId,
      action: "SYMBOL_CONFIG_UPDATED",
      entityType: "BrokerSymbol",
      entityId: existing.id,
      oldValue: { symbol: ctx.symbolName, source: ctx.source, ...pick(before), ...(keys.includes("sessions") ? { sessions: sessionsBefore!.map(win) } : {}) },
      newValue: { symbol: ctx.symbolName, source: ctx.source, ...pick(after), ...(keys.includes("sessions") ? { sessions: sessions!.map(win) } : {}) },
    },
  });
  return { row, changed: true, changedKeys: keys };
}

/** Creates the broker's row for a catalogue symbol, with its sessions, and one SYMBOL_ADDED audit row. */
export async function createBrokerSymbol(
  tx: Tx,
  ctx: WriteCtx,
  symbolId: string,
  data: Record<string, unknown>,
  sessions: SessionInput[],
  clonedFrom?: string,
): Promise<BrokerSymbol> {
  const row = await tx.brokerSymbol.create({ data: { brokerId: ctx.brokerId, symbolId, ...(data as object) } as Prisma.BrokerSymbolUncheckedCreateInput });
  if (sessions.length > 0) await replaceSessions(tx, row.id, sessions);
  await tx.auditLog.create({
    data: {
      brokerId: ctx.brokerId,
      actorAdminId: ctx.adminId,
      action: "SYMBOL_ADDED",
      entityType: "BrokerSymbol",
      entityId: row.id,
      oldValue: undefined,
      newValue: { symbol: ctx.symbolName, source: ctx.source, ...(clonedFrom ? { clonedFrom } : {}), ...fieldsView(row), sessions: sessions.map(win) },
    },
  });
  return row;
}
