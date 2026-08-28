import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Same book-exposure computation app/manage/(shell)/liquidity/page.tsx's
// Server Component used to do inline -- exposed as JSON so
// LiquidityManager can fetch it itself (both the website and a bundled
// manager-shell desktop app use this one path now). The liquidity
// provider roster itself is served separately by the already-existing
// /api/manage/liquidity-providers route.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const grouped = await prisma.position.groupBy({
    by: ["symbolId", "bookType"],
    where: { brokerId, status: "OPEN" },
    _sum: { volume: true },
  });

  const symbolIds = [...new Set(grouped.map((g) => g.symbolId))];
  const symbols = await prisma.symbol.findMany({ where: { id: { in: symbolIds } }, select: { id: true, name: true } });
  const nameById = new Map(symbols.map((s) => [s.id, s.name]));

  const bookExposureBySymbol = new Map<string, { symbol: string; aBookVolume: string; bBookVolume: string }>();
  for (const g of grouped) {
    const name = nameById.get(g.symbolId) ?? g.symbolId;
    const existing = bookExposureBySymbol.get(name) ?? { symbol: name, aBookVolume: "0", bBookVolume: "0" };
    const volume = (g._sum.volume ?? 0).toString();
    if (g.bookType === "A_BOOK") existing.aBookVolume = volume;
    else existing.bBookVolume = volume;
    bookExposureBySymbol.set(name, existing);
  }

  return NextResponse.json([...bookExposureBySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)));
}
