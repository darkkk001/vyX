import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { publishTradingEvent } from "@/lib/nats";
import { withRequestKey } from "@/lib/room/request-key";
import { demoTopUp, DemoTopUpError } from "@/lib/room/demo-top-up";

// POST {key, amount}: top up one of the client's own DEMO accounts, at once, no approval, never above 100,000 in the
// account currency (lib/room/demo-top-up.ts). A live account is refused on the server whatever the page sends.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-topup:${session.clientId}`, 10, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  return withRequestKey(session.clientId, "TOPUP", body?.key, async () => {
    const account = await ownAccount(session, id);
    if (!account || account.isWallet) return NextResponse.json({ error: "Account not found." }, { status: 404 });
    if (account.accountMode !== "DEMO") return NextResponse.json({ error: "Top up is for demo accounts only." }, { status: 403 });
    if (account.status !== "ACTIVE") return NextResponse.json({ error: "This account is not active." }, { status: 400 });
    let amount: Prisma.Decimal;
    try { amount = new Prisma.Decimal(String(body?.amount ?? "").replace(/,/g, "").trim()); } catch { return NextResponse.json({ error: "Enter an amount." }, { status: 400 }); }
    try {
      const r = await prisma.$transaction((tx) => demoTopUp(tx, { brokerId: session.brokerId, accountId: account.id, accountMode: account.accountMode, currency: account.currency, amount }));
      await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "DEMO_TOP_UP", entityType: "Account", entityId: account.id, newValue: { accountNumber: account.accountNumber, amount: amount.toFixed(2), balance: r.balance.toFixed(2), source: "CLIENT" } } });
      // terminal, WebTrader and the Room hear it like any balance change
      await publishTradingEvent("BalanceChanged", { account_id: account.id, broker_id: session.brokerId, transaction_id: r.transactionId }).catch(() => {});
      return NextResponse.json({ status: "done", id: r.transactionId, amount: amount.toFixed(2), balance: r.balance.toFixed(2), currency: account.currency }, { status: 201 });
    } catch (e) {
      if (e instanceof DemoTopUpError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
