import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { loadHmrState } from "@/lib/hmr";

// GET /api/trade/hmr: the active and upcoming HMR windows (owner spec 2026-11-06, C3) that touch the symbols THIS account can trade, so
// the apps can show a banner. Only what a trader needs: currency, UTC instants, the leverage new positions get, the symbols affected.
// An empty list when the broker's plugin is off. Existing positions are not touched by a window (their margin leverage was fixed when
// they opened), so this carries nothing about them.
export async function GET() {
  const session = await getAccountSession();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { brokerId: true, group: { select: { restrictSymbols: true, allowedSymbols: { select: { symbolId: true } } } } },
  });
  if (!account) return NextResponse.json({ error: "account not found" }, { status: 404 });
  const now = new Date();
  const state = await loadHmrState(prisma, account.brokerId, now);
  if (!state.enabled) return NextResponse.json({ enabled: false, windows: [] });

  const rows = await prisma.brokerSymbol.findMany({ where: { brokerId: account.brokerId, enabled: true }, select: { symbolId: true, symbol: { select: { name: true } } } });
  const allow = account.group?.restrictSymbols ? new Set(account.group.allowedSymbols.map((s) => s.symbolId)) : null;
  const mine = new Set(rows.filter((r) => !allow || allow.has(r.symbolId)).map((r) => r.symbol.name));

  const windows = state.windows
    .map((w) => ({ w, symbols: [...(state.symbolsByCurrency.get(w.currency) ?? [])].filter((s) => mine.has(s)).sort() }))
    .filter((x) => x.symbols.length > 0)
    .sort((a, b) => a.w.startsAt.getTime() - b.w.startsAt.getTime())
    .map(({ w, symbols }) => ({
      currency: w.currency,
      startsAt: w.startsAt.toISOString(),
      endsAt: w.endsAt.toISOString(),
      leverage: w.leverage,
      active: w.startsAt.getTime() <= now.getTime() && now.getTime() < w.endsAt.getTime(),
      symbols,
    }));
  return NextResponse.json({ enabled: true, windows });
}
