import { NextRequest, NextResponse } from "next/server";
import { withConfigEvent } from "@/lib/config-events";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { updateBrokerSymbol } from "@/lib/symbol-write";
import { symbolWriteRefusal } from "@/lib/symbol-config";

// PATCH /api/manage/symbols/order: { order: [{ id: BrokerSymbol.id, displayOrder: whole number >= 0 }] }
// The trader symbol list (GET /api/trade/symbols) is sorted by displayOrder, symbols without one last, then by name.
// Result per id like the bulk route; a symbol whose order does not change is ok and writes nothing.
async function patchHandler(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const body = (await request.json().catch(() => null)) as { order?: unknown } | null;
  if (!Array.isArray(body?.order) || body!.order.length === 0) return NextResponse.json({ error: "order must be a non-empty list of { id, displayOrder }" }, { status: 400 });
  if (body!.order.length > 2000) return NextResponse.json({ error: "at most 2000 symbols per request" }, { status: 400 });
  const items: { id: string; displayOrder: number }[] = [];
  for (const [i, raw] of (body!.order as unknown[]).entries()) {
    const r = raw as { id?: unknown; displayOrder?: unknown } | null;
    if (typeof r?.id !== "string" || r.id === "" || typeof r.displayOrder !== "number" || !Number.isInteger(r.displayOrder) || r.displayOrder < 0 || r.displayOrder > 2_000_000_000) {
      return NextResponse.json({ error: `order[${i}] needs an id and a whole displayOrder, 0 or more` }, { status: 400 });
    }
    items.push({ id: r.id, displayOrder: r.displayOrder });
  }
  if (new Set(items.map((i) => i.id)).size !== items.length) return NextResponse.json({ error: "a symbol is listed twice" }, { status: 400 });

  const rows = await prisma.brokerSymbol.findMany({ where: { id: { in: items.map((i) => i.id) }, brokerId }, include: { symbol: { select: { name: true } } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  // GROUPS_SYMBOLS, judged on the symbols whose order actually changes (an unknown id counts as a change)
  if (items.some((i) => byId.get(i.id)?.displayOrder !== i.displayOrder)) {
    const refused = await symbolWriteRefusal(session, ["displayOrder"], "manage/symbols/order PATCH");
    if (refused) return refused;
  }
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const item of items) {
    const found = byId.get(item.id);
    if (!found) {
      results.push({ id: item.id, ok: false, error: "symbol not found" });
      continue;
    }
    const { symbol, ...bs } = found;
    try {
      await prisma.$transaction((tx) => updateBrokerSymbol(tx, { brokerId, adminId: session!.adminId, symbolName: symbol.name, source: "order" }, bs, { displayOrder: item.displayOrder }, null));
      results.push({ id: item.id, ok: true });
    } catch (e) {
      results.push({ id: item.id, ok: false, error: e instanceof Error ? e.message : "update failed" });
    }
  }
  return NextResponse.json({ results });
}

export const PATCH = withConfigEvent("symbols", patchHandler);
