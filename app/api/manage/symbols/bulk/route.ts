import { NextRequest, NextResponse } from "next/server";
import { withConfigEvent } from "@/lib/config-events";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { changedAgainst, crossCheck, fieldsView, parseSymbolFields, symbolWriteRefusal, type FieldKey } from "@/lib/symbol-config";
import { validateSessions } from "@/lib/symbol-sessions";
import { updateBrokerSymbol } from "@/lib/symbol-write";

// PATCH /api/manage/symbols/bulk: { ids: BrokerSymbol.id[], set: { enabled?, spreadMarkup?, swapLong?, swapShort?, maxLot?, sessions? } }
// One request, one result per id: { results: [{ id, ok, error? }] }. Every id is its own transaction with its own audit
// row, so a failing row never stops the others. A bad `set` (or a missing permission for what it changes) refuses the
// whole request before any row is touched.
const SET_KEYS: FieldKey[] = ["enabled", "spreadMarkup", "swapLong", "swapShort", "maxLot"];
const MAX_IDS = 500;

async function patchHandler(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const body = (await request.json().catch(() => null)) as { ids?: unknown; set?: unknown } | null;
  const ids = Array.isArray(body?.ids) && body!.ids.every((i) => typeof i === "string" && i !== "") ? [...new Set(body!.ids as string[])] : null;
  if (!ids || ids.length === 0) return NextResponse.json({ error: "ids must be a non-empty list of symbol ids" }, { status: 400 });
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `at most ${MAX_IDS} symbols per request` }, { status: 400 });
  const set = body?.set;
  if (!set || typeof set !== "object" || Array.isArray(set)) return NextResponse.json({ error: "set must be an object" }, { status: 400 });
  const setObj = set as Record<string, unknown>;
  const unknown = Object.keys(setObj).filter((k) => !(SET_KEYS as string[]).includes(k) && k !== "sessions");
  if (unknown.length > 0) return NextResponse.json({ error: `cannot set: ${unknown.join(", ")}` }, { status: 400 });
  if (Object.keys(setObj).length === 0) return NextResponse.json({ error: "set is empty" }, { status: 400 });

  const { data, errors } = parseSymbolFields(setObj, SET_KEYS);
  if (errors.length > 0) return NextResponse.json({ error: errors.map((e) => `${e.field} ${e.reason}`).join("; "), fieldErrors: errors }, { status: 400 });
  let sessions: ReturnType<typeof validateSessions>["rows"] | null = null;
  if ("sessions" in setObj) {
    const v = validateSessions(setObj.sessions);
    if (v.rowErrors.length > 0) return NextResponse.json({ error: "some sessions are invalid", rowErrors: v.rowErrors }, { status: 400 });
    sessions = v.rows;
  }

  const rows = await prisma.brokerSymbol.findMany({ where: { id: { in: ids }, brokerId }, include: { symbol: true } });
  // permissions, judged on what the request changes across the rows (an unknown id counts as changing everything sent;
  // a sessions list counts as a trading-hours write): pricing -> PRICING, enabled -> EMERGENCY_CONTROLS, the rest -> GROUPS_SYMBOLS
  const changed = new Set<string>(sessions ? ["sessions"] : []);
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    for (const k of changedAgainst(r ? fieldsView(r) : null, data)) changed.add(k);
  }
  const refused = await symbolWriteRefusal(session, [...changed], "manage/symbols/bulk PATCH");
  if (refused) return refused;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (!found) {
      results.push({ id, ok: false, error: "symbol not found" });
      continue;
    }
    const { symbol, ...bs } = found;
    try {
      if (data.enabled === true && symbol.quoteCurrency !== "USD") throw new Error(`${symbol.name} cannot be enabled yet: P/L in ${symbol.quoteCurrency} is not supported`);
      const cross = crossCheck(bs, data);
      if (cross.length > 0) throw new Error(cross[0].reason);
      await prisma.$transaction((tx) => updateBrokerSymbol(tx, { brokerId, adminId: session!.adminId, symbolName: symbol.name, source: "bulk" }, bs, data, sessions));
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : "update failed" });
    }
  }
  return NextResponse.json({ results });
}

export const PATCH = withConfigEvent("symbols", patchHandler);
