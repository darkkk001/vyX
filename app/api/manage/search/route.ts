import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Backoffice global omni-search. Broker-scoped and RBAC-respecting, same
// role gate as every other /api/manage/* route -- this is a lookup, not
// a mutation, but it can still leak which accounts/orders/symbols exist
// at this broker to whoever can query it, so it gets the same MANAGER/
// BROKER_ADMIN check as the rest of this surface, not a looser one.
//
// Four entity types, matched by what the query actually looks like
// rather than trying every kind of match against every table on every
// keystroke:
//  - account number / name / email -> Account (always checked; this is
//    the common case)
//  - order/position ID, transaction ID -> Order/Position/Transaction,
//    matched by ID PREFIX (cuids are ~25 chars; nobody types one
//    character at a time meaning it, so this only fires once the query
//    is long enough to plausibly be a real prefix -- short queries would
//    otherwise table-scan three tables for a match that can't exist yet)
//  - symbol -> this broker's own enabled BrokerSymbol list
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();

  if (q.length < 2) {
    return NextResponse.json({ accounts: [], orders: [], positions: [], transactions: [], symbols: [] });
  }

  const idLike = q.length >= 6 && /^[a-z0-9]+$/i.test(q);

  const [accounts, orders, positions, transactions, brokerSymbols] = await Promise.all([
    prisma.account.findMany({
      where: {
        brokerId,
        OR: [
          { accountNumber: { contains: q } },
          { fullName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true, accountNumber: true, fullName: true, email: true, accountType: true },
      take: 6,
      orderBy: { accountNumber: "asc" },
    }),
    idLike
      ? prisma.order.findMany({
          where: { brokerId, id: { startsWith: q } },
          select: { id: true, side: true, type: true, status: true, account: { select: { id: true, accountNumber: true } }, symbol: { select: { name: true } } },
          take: 5,
        })
      : Promise.resolve([]),
    idLike
      ? prisma.position.findMany({
          where: { brokerId, id: { startsWith: q } },
          select: { id: true, side: true, status: true, account: { select: { id: true, accountNumber: true } }, symbol: { select: { name: true } } },
          take: 5,
        })
      : Promise.resolve([]),
    idLike
      ? prisma.transaction.findMany({
          where: { brokerId, id: { startsWith: q } },
          select: { id: true, type: true, status: true, amount: true, account: { select: { id: true, accountNumber: true } } },
          take: 5,
        })
      : Promise.resolve([]),
    prisma.brokerSymbol.findMany({
      where: { brokerId, enabled: true, symbol: { name: { contains: q, mode: "insensitive" } } },
      select: { symbolId: true, symbol: { select: { name: true, category: true } } },
      take: 6,
      orderBy: { symbol: { name: "asc" } },
    }),
  ]);

  return NextResponse.json({
    accounts: accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName, email: a.email, accountType: a.accountType })),
    orders: orders.map((o) => ({ id: o.id, accountId: o.account.id, accountNumber: o.account.accountNumber, symbol: o.symbol.name, side: o.side, type: o.type, status: o.status })),
    positions: positions.map((p) => ({ id: p.id, accountId: p.account.id, accountNumber: p.account.accountNumber, symbol: p.symbol.name, side: p.side, status: p.status })),
    transactions: transactions.map((t) => ({ id: t.id, accountId: t.account.id, accountNumber: t.account.accountNumber, type: t.type, status: t.status, amount: t.amount.toString() })),
    symbols: brokerSymbols.map((bs) => ({ id: bs.symbolId, name: bs.symbol.name, category: bs.symbol.category })),
  });
}
