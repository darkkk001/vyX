import { NextRequest, NextResponse } from "next/server";
import { tradingRightsRefusal } from "@/lib/account-trading-rights";
import { loadAccountAskRules } from "@/lib/ask-markup";
import { getLivePriceRow } from "@/lib/live-price";
import { getAccountSession } from "@/lib/account-auth";
import { prisma } from "@/lib/prisma";
import { announcePositionModified, levelFromSpec, refuseModify, type LevelSpec } from "@/lib/position-modify";

const MAX_POSITIONS = 200;

type Result = { positionId: string; ok: boolean; slPrice: string | null; tpPrice: string | null; error: string | null; nextOpenAt?: string };

function parseSpec(raw: unknown, allowBreakEven: boolean): LevelSpec | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") return "invalid";
  const o = raw as Record<string, unknown>;
  if (o.clear === true) return { clear: true };
  if (o.breakEven === true) return allowBreakEven ? { breakEven: true } : "invalid";
  if (typeof o.price === "string" || typeof o.price === "number") return { price: String(o.price) };
  if (typeof o.points === "string" || typeof o.points === "number") return { points: o.points };
  return "invalid";
}

// Modify SL / TP on several of the trader's open positions in ONE request (the terminal's grouped Trade tab:
// "Modify all" and "Break-even all"). Every position is judged on its own by exactly the single modify's rules
// (lib/position-modify.ts) -- ownership, open, market open, side-correct SL / TP, stops level against the server's
// live price -- the ones that pass are applied, and a result with the reason comes back for each position.
// Body: { positionIds: string[], sl?: Spec, tp?: Spec } where Spec is one of
//   { price } | { points } (MT5 points from each position's entry, sign per side) | { breakEven: true } (SL only) | { clear: true }
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const ids: string[] = Array.isArray(body?.positionIds) ? [...new Set<string>(body.positionIds.filter((x: unknown): x is string => typeof x === "string" && x.length > 0))] : [];
  if (ids.length === 0) return NextResponse.json({ error: "positionIds is required" }, { status: 400 });
  if (ids.length > MAX_POSITIONS) return NextResponse.json({ error: `at most ${MAX_POSITIONS} positions at a time` }, { status: 400 });
  const slSpec = parseSpec(body?.sl, true);
  const tpSpec = parseSpec(body?.tp, false);
  if (slSpec === "invalid" || tpSpec === "invalid") return NextResponse.json({ error: "sl / tp must be { price }, { points }, { breakEven } (sl only) or { clear }" }, { status: 400 });
  if (slSpec === undefined && tpSpec === undefined) return NextResponse.json({ error: "nothing to change: send sl and/or tp" }, { status: 400 });

  const accountRow = await prisma.account.findUnique({ where: { id: session.accountId }, select: { status: true, tradingRights: true } });
  const rightsRefused = accountRow ? tradingRightsRefusal(accountRow, "modify") : null;
  if (rightsRefused) return rightsRefused;

  // someone else's position id is answered exactly like an unknown one
  const owned = await prisma.position.findMany({ where: { id: { in: ids }, accountId: session.accountId, brokerId: session.brokerId } });
  const byId = new Map(owned.map((p) => [p.id, p]));
  const symbolIds = [...new Set(owned.map((p) => p.symbolId))];
  const [symbols, brokerSymbols] = await Promise.all([
    prisma.symbol.findMany({ where: { id: { in: symbolIds } }, select: { id: true, digits: true, name: true, category: true, contractSize: true } }),
    prisma.brokerSymbol.findMany({ where: { brokerId: session.brokerId, symbolId: { in: symbolIds } }, select: { symbolId: true, stopLevel: true, tradingSessions: true } }),
  ]);
  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  const brokerSymbolById = new Map(brokerSymbols.map((b) => [b.symbolId, b]));
  const liveByName = new Map<string, Awaited<ReturnType<typeof getLivePriceRow>>>();
  await Promise.all(symbols.map(async (s) => { liveByName.set(s.name, await getLivePriceRow(s.name)); }));
  const sellSymbolIds = [...new Set(owned.filter((p) => p.side === "SELL").map((p) => p.symbolId))];
  const askRuleFor = sellSymbolIds.length > 0 ? await loadAccountAskRules(prisma, session.accountId, sellSymbolIds) : null;

  const results: Result[] = [];
  for (const id of ids) {
    const position = byId.get(id);
    if (!position) { results.push({ positionId: id, ok: false, slPrice: null, tpPrice: null, error: "position not found" }); continue; }
    const symbol = symbolById.get(position.symbolId);
    const bs = brokerSymbolById.get(position.symbolId);
    const digits = symbol?.digits ?? 2;
    const sl = levelFromSpec("SL", slSpec, position, digits);
    const tp = levelFromSpec("TP", tpSpec, position, digits);
    const specError = (typeof sl === "object" && sl !== null ? sl.error : null) ?? (typeof tp === "object" && tp !== null ? tp.error : null);
    if (specError) { results.push({ positionId: id, ok: false, slPrice: null, tpPrice: null, error: specError }); continue; }
    const slPrice = sl as string | null | undefined;
    const tpPrice = tp as string | null | undefined;
    const brokerSymbol = bs && symbol ? { stopLevel: bs.stopLevel, symbol, tradingSessions: bs.tradingSessions } : null;
    const live = symbol ? liveByName.get(symbol.name) ?? null : null;
    const refused = refuseModify({ position, brokerSymbol, symbolName: symbol?.name ?? null, live, askRuleFor, slPrice, tpPrice });
    if (refused) {
      const error = String(refused.body.error ?? "refused");
      results.push({ positionId: id, ok: false, slPrice: null, tpPrice: null, error, ...(typeof refused.body.nextOpenAt === "string" ? { nextOpenAt: refused.body.nextOpenAt } : {}) });
      continue;
    }
    // guarded on OPEN so a position closed a moment ago is not written to
    const changed = await prisma.position.updateMany({
      where: { id, accountId: session.accountId, status: "OPEN" },
      data: { ...(slPrice !== undefined ? { slPrice } : {}), ...(tpPrice !== undefined ? { tpPrice } : {}) },
    });
    if (changed.count === 0) { results.push({ positionId: id, ok: false, slPrice: null, tpPrice: null, error: "position is not open" }); continue; }
    const updated = await prisma.position.findUniqueOrThrow({ where: { id } });
    const row = { ...updated, symbol: { name: symbol!.name, digits: symbol!.digits, contractSize: symbol!.contractSize } };
    await announcePositionModified({ session, before: position, row, symbolName: symbol!.name, slPrice, tpPrice });
    results.push({ positionId: id, ok: true, slPrice: updated.slPrice?.toString() ?? null, tpPrice: updated.tpPrice?.toString() ?? null, error: null });
  }
  return NextResponse.json({
    requested: results.length,
    modified: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
