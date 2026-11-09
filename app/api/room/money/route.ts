import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { conversionRate, loadFxLookup } from "@/lib/fx";
import { summarizeMoney } from "@/lib/room/money";
import { partnerUnpaid } from "@/lib/room/partner";

// GET: the top-bar money menu (owner 2026-11-10). Overall (funding wallet + LIVE trading accounts, in USD), each live
// trading account, the funding wallet (0.00 until it exists; a read never creates it) and, for an IB, the partner wallet
// (unpaid commission). Demo accounts never count. Every figure is the server's (lib/room/money.ts).
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const [accounts, broker, partner] = await Promise.all([
    prisma.account.findMany({
      where: { clientId: session.clientId, brokerId: session.brokerId, accountMode: "LIVE", status: { not: "CLOSED" }, archivedAt: null },
      select: { id: true, accountNumber: true, accountMode: true, isWallet: true, balance: true, currency: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId }, select: { defaultAccountCurrency: true } }),
    partnerUnpaid(session.brokerId, session.clientId),
  ]);
  const partnerCurrency = partner ? accounts.find((a) => a.accountNumber === partner.accountNumber)?.currency ?? broker.defaultAccountCurrency : broker.defaultAccountCurrency;
  const currencies = new Set([...accounts.map((a) => a.currency), broker.defaultAccountCurrency, partnerCurrency]);
  const lookup = await loadFxLookup(prisma, [...currencies].map((c) => [c, "USD"] as const));
  const money = summarizeMoney(
    {
      accounts: accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, balance: a.balance, currency: a.currency, mode: a.accountMode, isWallet: a.isWallet })),
      partner: partner ? { accountNumber: partner.accountNumber, unpaid: partner.unpaid, currency: partnerCurrency } : null,
      walletCurrency: broker.defaultAccountCurrency,
    },
    (from, to) => conversionRate(from, to, lookup)
  );
  return NextResponse.json(money, { headers: { "cache-control": "no-store" } });
}
