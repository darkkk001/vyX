import { NextRequest, NextResponse } from "next/server";
import { withConfigEvent } from "@/lib/config-events";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { fieldsView, parseSymbolFields } from "@/lib/symbol-config";
import { updateBrokerSymbol } from "@/lib/symbol-write";

// PATCH /api/manage/symbols/[id]: `id` is BrokerSymbol.id (like the sessions route). Partial update of the symbols-tab
// settings: the new fields (tick size / value, margin and profit currency, execution mode, fill policy, swap type and
// triple-swap day, freeze level, margin rates, description, display order) and tradingMode (now incl. CLOSE_ONLY).
// A field not sent stays as it is; null or "" clears an optional one. One audit row when something changed.
// The pricing / enable settings keep their own routes' gates (PATCH /api/manage/symbols, bulk) and are not taken here.
const ALLOWED = [
  "tradingMode",
  "tickSize",
  "tickValue",
  "marginCurrency",
  "profitCurrency",
  "executionMode",
  "fillPolicy",
  "swapType",
  "tripleSwapDay",
  "freezeLevel",
  "marginInitial",
  "marginMaintenance",
  "description",
  "displayOrder",
] as const;

async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const existing = await prisma.brokerSymbol.findUnique({ where: { id }, include: { symbol: { select: { name: true } } } });
  if (!existing || existing.brokerId !== session!.brokerId) {
    return NextResponse.json({ error: "symbol not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "send a JSON object with the fields to change" }, { status: 400 });
  }
  const { data, errors } = parseSymbolFields(body, ALLOWED);
  if (errors.length > 0) {
    return NextResponse.json({ error: errors.map((e) => `${e.field} ${e.reason}`).join("; "), fieldErrors: errors }, { status: 400 });
  }
  const { symbol, ...bs } = existing;
  const { row } = await prisma.$transaction((tx) =>
    updateBrokerSymbol(tx, { brokerId: session!.brokerId!, adminId: session!.adminId, symbolName: symbol.name, source: "edit" }, bs, data, null),
  );
  return NextResponse.json({ brokerSymbolId: row.id, symbolId: row.symbolId, symbolName: symbol.name, ...fieldsView(row) });
}

export const PATCH = withConfigEvent("symbols", patchHandler);
