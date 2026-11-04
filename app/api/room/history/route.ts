import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { roomTransactions, ROOM_TX_TYPES, type RoomTxType } from "@/lib/room/transactions";
import { toCsv } from "@/lib/csv";

// Trader's Room History. GET ?tab=transactions|trades&account=<id|all>&type=<Deposit|...|all>&period=30d|90d|ytd|all
// &page=1&format=csv. Every own account by default; a page is 20 rows; CSV is the whole filtered set (10,000 rows max).
const PAGE = 20;
const CSV_MAX = 10_000;

function periodStart(p: string | null): Date | undefined {
  const now = new Date();
  if (p === "30d") return new Date(now.getTime() - 30 * 86400e3);
  if (p === "ytd") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  if (p === "all") return undefined;
  return new Date(now.getTime() - 90 * 86400e3);
}

export async function GET(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const q = new URL(request.url).searchParams;
  const tab = q.get("tab") === "trades" ? "trades" : "transactions";
  const csv = q.get("format") === "csv";
  const page = Math.max(1, Math.min(10_000, Number(q.get("page")) || 1));
  const from = periodStart(q.get("period"));

  const own = await prisma.account.findMany({ where: { clientId: session.clientId, brokerId: session.brokerId }, select: { id: true, accountNumber: true, currency: true } });
  const wanted = q.get("account");
  const accounts = wanted && wanted !== "all" ? own.filter((a) => a.id === wanted) : own;
  if (accounts.length === 0) return csv ? new NextResponse("", { status: 404 }) : NextResponse.json({ rows: [], total: 0, page, pageSize: PAGE });
  const numberById = new Map(own.map((a) => [a.id, a.accountNumber]));

  if (tab === "transactions") {
    const type = q.get("type");
    const types = type && (ROOM_TX_TYPES as string[]).includes(type) ? [type as RoomTxType] : undefined;
    const { rows, total } = await roomTransactions({ accountIds: accounts.map((a) => a.id), types, from }, new Set(own.map((a) => a.accountNumber)), csv ? { skip: 0, take: CSV_MAX } : { skip: (page - 1) * PAGE, take: PAGE });
    if (csv) {
      const body = toCsv(rows.map((r) => ({ ...r, at: r.at.replace("T", " ").slice(0, 19) })), [
        { key: "at", label: "Date (UTC)" }, { key: "ref", label: "ID" }, { key: "type", label: "Type" }, { key: "account", label: "Account" },
        { key: "method", label: "Method" }, { key: "amount", label: "Amount" }, { key: "currency", label: "Currency" }, { key: "status", label: "Status" },
      ]);
      return csvResponse(body, "transactions");
    }
    return NextResponse.json({ rows, total, page, pageSize: PAGE });
  }

  // trades: closed (and voided) positions, newest close first
  const where: Prisma.PositionWhereInput = {
    accountId: { in: accounts.map((a) => a.id) },
    status: { in: ["CLOSED", "VOIDED"] },
    deletedAt: null,
    ...(from ? { closedAt: { gte: from } } : {}),
  };
  const [list, total] = await Promise.all([
    prisma.position.findMany({
      where,
      select: { id: true, ticket: true, accountId: true, side: true, volume: true, initialVolume: true, openPrice: true, closePrice: true, realizedPnl: true, status: true, openedAt: true, closedAt: true, symbol: { select: { name: true, digits: true } } },
      orderBy: { closedAt: "desc" },
      skip: csv ? 0 : (page - 1) * PAGE,
      take: csv ? CSV_MAX : PAGE,
    }),
    prisma.position.count({ where }),
  ]);
  const rows = list.map((p) => {
    const digits = p.symbol.digits ?? 5;
    return {
      id: p.id,
      ticket: String(p.ticket),
      account: numberById.get(p.accountId) ?? "",
      symbol: p.symbol.name,
      side: p.side,
      lots: (p.initialVolume ?? p.volume).toFixed(2),
      openPrice: p.openPrice.toFixed(digits),
      closePrice: p.closePrice?.toFixed(digits) ?? "",
      profit: (p.realizedPnl ?? new Prisma.Decimal(0)).toFixed(2),
      status: p.status === "VOIDED" ? "Voided" : "Closed",
      openedAt: p.openedAt.toISOString(),
      closedAt: (p.closedAt ?? p.openedAt).toISOString(),
    };
  });
  if (csv) {
    const body = toCsv(rows.map((r) => ({ ...r, openedAt: r.openedAt.replace("T", " ").slice(0, 19), closedAt: r.closedAt.replace("T", " ").slice(0, 19) })), [
      { key: "closedAt", label: "Closed (UTC)" }, { key: "ticket", label: "Ticket" }, { key: "account", label: "Account" }, { key: "symbol", label: "Symbol" },
      { key: "side", label: "Side" }, { key: "lots", label: "Lots" }, { key: "openedAt", label: "Opened (UTC)" }, { key: "openPrice", label: "Open price" },
      { key: "closePrice", label: "Close price" }, { key: "profit", label: "Profit" }, { key: "status", label: "Status" },
    ]);
    return csvResponse(body, "trades");
  }
  return NextResponse.json({ rows, total, page, pageSize: PAGE });
}

function csvResponse(body: string, kind: string) {
  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${kind}-${day}.csv"`, "Cache-Control": "no-store" } });
}
