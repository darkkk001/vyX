// Symbols tab (backoffice 1.0.101): the CSV import behind POST /api/manage/symbols/import.
// The header is the export header: the GET /api/manage/symbols field names, `symbolName` plus any of FIELD_KEYS. Other
// columns of that export (category, digits, ...) are read-only and ignored. An empty cell means "leave as it is" (so an
// export with unset fields re-imports without clearing anything); to clear a field use the edit routes.
// planImport validates every row against the live data and decides create / update / skip; applyImport writes the ok ones.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { symbolHiddenFromBroker } from "@/lib/synthetic-symbols";
import { displayCurrency } from "@/lib/demo-policy";
import { parseCsv } from "@/lib/symbol-csv";
import { FIELD_KEYS, crossCheck, fieldsView, gateReason, parseSymbolFields, symbolGates, type FieldKey } from "@/lib/symbol-config";
import { createBrokerSymbol, updateBrokerSymbol } from "@/lib/symbol-write";
import type { AdminSessionPayload } from "@/lib/auth";

export type ImportRow = { line: number; symbol: string; action: "create" | "update" | "skip"; ok: boolean; errors: string[] };
export type PlannedRow = ImportRow & { data?: Record<string, unknown>; existingId?: string; symbolId?: string };

export const MAX_IMPORT_ROWS = 2000;

function same(current: unknown, next: unknown): boolean {
  if (next instanceof Prisma.Decimal) return current !== null && current !== undefined && new Prisma.Decimal(String(current)).equals(next);
  return current === next;
}

export async function planImport(session: AdminSessionPayload, text: string): Promise<{ error: string } | { rows: PlannedRow[] }> {
  const records = parseCsv(text);
  if (records.length === 0) return { error: "the file is empty" };
  const header = records[0].cells.map((h) => h.trim());
  const nameCol = header.findIndex((h) => h === "symbolName" || h === "symbol");
  if (nameCol < 0) return { error: "the header needs a symbolName column" };
  const columns = header.map((h, i) => ({ h, i })).filter((c) => (FIELD_KEYS as readonly string[]).includes(c.h)) as { h: FieldKey; i: number }[];
  const body = records.slice(1);
  if (body.length === 0) return { error: "the file has a header but no rows" };
  if (body.length > MAX_IMPORT_ROWS) return { error: `at most ${MAX_IMPORT_ROWS} rows per import` };

  const brokerId = session.brokerId!;
  const names = [...new Set(body.map((r) => (r.cells[nameCol] ?? "").trim()).filter(Boolean))];
  const symbols = await prisma.symbol.findMany({ where: { name: { in: names } } });
  const symByName = new Map(symbols.map((s) => [s.name, s]));
  const existing = await prisma.brokerSymbol.findMany({ where: { brokerId, symbolId: { in: symbols.map((s) => s.id) } } });
  const bsBySymbol = new Map(existing.map((b) => [b.symbolId, b]));
  const gates = await symbolGates(session);
  const seen = new Set<string>();
  const rows: PlannedRow[] = [];

  for (const rec of body) {
    const name = (rec.cells[nameCol] ?? "").trim();
    const row: PlannedRow = { line: rec.line, symbol: name, action: "skip", ok: false, errors: [] };
    rows.push(row);
    if (!name) {
      row.errors.push("symbolName is empty");
      continue;
    }
    if (seen.has(name)) {
      row.errors.push(`${name} appears twice in the file`);
      continue;
    }
    seen.add(name);
    const symbol = symByName.get(name);
    if (!symbol || (await symbolHiddenFromBroker(prisma, brokerId, symbol.name))) {
      row.errors.push(`${name} is not in the platform catalogue`);
      continue;
    }
    if (rec.cells.length > header.length) {
      row.errors.push("more cells than header columns");
      continue;
    }
    const input: Record<string, unknown> = {};
    for (const c of columns) {
      const cell = (rec.cells[c.i] ?? "").trim();
      if (cell === "") continue;
      input[c.h] = c.h === "enabled" ? (/^(true|yes|1)$/i.test(cell) ? true : /^(false|no|0)$/i.test(cell) ? false : cell) : cell;
    }
    const { data, errors } = parseSymbolFields(input);
    if (errors.length > 0) {
      row.errors.push(...errors.map((e) => `${e.field} ${e.reason}`));
      continue;
    }
    const current = bsBySymbol.get(symbol.id);
    const cross = crossCheck(current ?? null, data);
    if (cross.length > 0) {
      row.errors.push(cross[0].reason);
      continue;
    }
    if (data.enabled === true && symbol.quoteCurrency !== "USD") {
      row.errors.push(`${symbol.name} cannot be enabled yet: P/L in ${displayCurrency(symbol.quoteCurrency)} is not supported`);
      continue;
    }
    if (current) {
      const view = fieldsView(current);
      const changed = Object.fromEntries(Object.entries(data).filter(([k, v]) => !same(view[k as FieldKey], v)));
      if (Object.keys(changed).length === 0) {
        row.ok = true; // nothing to change
        continue;
      }
      const denied = gateReason(gates, Object.keys(changed));
      if (denied) {
        row.errors.push(denied);
        continue;
      }
      Object.assign(row, { action: "update", ok: true, data: changed, existingId: current.id, symbolId: symbol.id });
    } else {
      const denied = gateReason(gates, Object.keys(data));
      if (denied) {
        row.errors.push(denied);
        continue;
      }
      Object.assign(row, { action: "create", ok: true, data: { enabled: false, ...data }, symbolId: symbol.id });
    }
  }
  return { rows };
}

/** Writes the ok create / update rows (one transaction and one audit row each). A row that fails to write is reported, the others still apply. */
export async function applyImport(session: AdminSessionPayload, rows: PlannedRow[]): Promise<void> {
  const brokerId = session.brokerId!;
  for (const row of rows) {
    if (!row.ok || row.action === "skip" || !row.data) continue;
    const ctx = { brokerId, adminId: session.adminId, symbolName: row.symbol, source: "import" };
    try {
      await prisma.$transaction(async (tx) => {
        if (row.action === "create") await createBrokerSymbol(tx, ctx, row.symbolId!, row.data!, []);
        else {
          const current = await tx.brokerSymbol.findUniqueOrThrow({ where: { id: row.existingId! } });
          await updateBrokerSymbol(tx, ctx, current, row.data!, null);
        }
      });
    } catch (e) {
      row.ok = false;
      row.errors.push(e instanceof Error ? e.message : "write failed");
    }
  }
}

export function publicRows(rows: PlannedRow[]): ImportRow[] {
  return rows.map(({ line, symbol, action, ok, errors }) => ({ line, symbol, action: ok ? action : "skip", ok, errors }));
}
