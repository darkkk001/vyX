import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { periodStart, sessionOf, tradeAccounts, type Period } from "@/lib/room/analytics";
import { JOURNAL_SELECT, PRESET_TAGS, netOf, rOf } from "@/lib/room/journal";

// GET ?account=all|<id>&symbol=&tag=&period=30d|90d|ytd|all&page=: every closed trade of the client's accounts, newest
// close first, 20 a page, with the client's tags. Also the symbols and tags to filter by.
const PAGE = 20;
const PERIODS: Period[] = ["30d", "90d", "ytd", "all"];

export async function GET(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const q = new URL(request.url).searchParams;
  const period = (PERIODS.find((p) => p === q.get("period")) ?? "90d") as Period;
  const from = periodStart(period);
  const page = Math.max(1, Math.min(10_000, Number(q.get("page")) || 1));
  const own = await prisma.account.findMany({ where: { clientId: session.clientId, brokerId: session.brokerId }, select: { id: true, accountNumber: true } });
  const accounts = tradeAccounts(own, q.get("account"));
  const numberById = new Map(own.map((a) => [a.id, a.accountNumber]));
  const symbol = q.get("symbol");
  const tag = q.get("tag");

  let tagged: string[] | null = null;
  if (tag && tag !== "all") {
    tagged = (await prisma.tradeJournalEntry.findMany({ where: { clientId: session.clientId, tags: { has: tag } }, select: { positionId: true } })).map((e) => e.positionId);
  }
  const where: Prisma.PositionWhereInput = {
    accountId: { in: accounts.map((a) => a.id) },
    status: "CLOSED",
    deletedAt: null,
    ...(from ? { closedAt: { gte: from } } : {}),
    ...(symbol && symbol !== "all" ? { symbol: { name: symbol } } : {}),
    ...(tagged ? { id: { in: tagged } } : {}),
  };
  const [rows, total, symbols, used] = await Promise.all([
    prisma.position.findMany({ where, select: JOURNAL_SELECT, orderBy: { closedAt: "desc" }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.position.count({ where }),
    prisma.position.findMany({ where: { accountId: { in: own.map((a) => a.id) }, status: "CLOSED", deletedAt: null }, distinct: ["symbolId"], select: { symbol: { select: { name: true } } } }),
    prisma.tradeJournalEntry.findMany({ where: { clientId: session.clientId }, select: { tags: true } }),
  ]);
  const entries = await prisma.tradeJournalEntry.findMany({ where: { positionId: { in: rows.map((r) => r.id) } }, select: { positionId: true, tags: true } });
  const tagsBy = new Map(entries.map((e) => [e.positionId, e.tags]));
  const allTags = [...new Set([...PRESET_TAGS, ...used.flatMap((u) => u.tags)])];
  return NextResponse.json({
    rows: rows.map((p) => {
      const r = rOf(p);
      return {
        id: p.id, closedAt: (p.closedAt ?? p.openedAt).toISOString(), account: numberById.get(p.accountId) ?? "", symbol: p.symbol.name, side: p.side,
        lots: (p.initialVolume ?? p.volume).toFixed(2), r: r == null ? null : r.toFixed(1), net: netOf(p).toFixed(2), session: sessionOf(p.openedAt), tags: tagsBy.get(p.id) ?? [],
      };
    }),
    total, page, pageSize: PAGE,
    symbols: symbols.map((s) => s.symbol.name).sort(),
    tags: allTags,
  });
}
