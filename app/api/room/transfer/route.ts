import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { executeTransfer, TransferError } from "@/lib/transfer";
import { publishTradingEvent } from "@/lib/nats";
import { checkRateLimit } from "@/lib/rate-limit";
import { withRequestKey, withTwinGuard, twinSince, twinAmount } from "@/lib/room/request-key";

// POST {key, fromId, toId, amount}: an instant transfer between two of the client's own accounts (same mode, same
// currency). lib/transfer.ts runs every money check: both rows locked, balance and the source's open-position margin.
export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-transfer:${session.clientId}`, 10, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const body = await request.json().catch(() => null);
  // one transfer per form load (body.key), and never the same transfer twice within 60 s (lib/room/request-key.ts)
  return withRequestKey(session.clientId, "TRANSFER", body?.key, async () => {
    const [from, to] = await Promise.all([ownAccount(session, body?.fromId), ownAccount(session, body?.toId)]);
    if (!from || !to) return NextResponse.json({ error: "Account not found." }, { status: 404 });
    let amount: Prisma.Decimal;
    try { amount = new Prisma.Decimal(String(body?.amount ?? "")); } catch { return NextResponse.json({ error: "Enter an amount." }, { status: 400 }); }
    if (!amount.gt(0) || amount.decimalPlaces() > 2) return NextResponse.json({ error: "Enter an amount." }, { status: 400 });

    try {
      return await withTwinGuard(session.clientId, "TRANSFER", [from.id, "TRANSFER", twinAmount(amount), to.id], async () => {
        const twin = await prisma.transaction.findFirst({
          where: { accountId: from.id, type: "TRANSFER_OUT", amount: amount.neg(), note: `Transfer to ${to.accountNumber}: ${NOTE}`, createdAt: { gte: twinSince() } },
          orderBy: { createdAt: "asc" }, select: { id: true },
        });
        if (twin) return NextResponse.json({ status: "done", id: twin.id, duplicate: true }, { status: 200 });
        const { outTxn, inTxn } = await prisma.$transaction((tx) =>
          executeTransfer(tx, { brokerId: session.brokerId, fromAccountId: from.id, toAccountId: to.id, amount, note: NOTE, adminId: null, clientId: session.clientId })
        );
        // same events as the staff transfer (app/api/manage/transfers)
        await publishTradingEvent("BalanceChanged", { account_id: from.id, broker_id: session.brokerId, transaction_id: outTxn.id }).catch(() => {});
        await publishTradingEvent("BalanceChanged", { account_id: to.id, broker_id: session.brokerId, transaction_id: inTxn.id }).catch(() => {});
        return NextResponse.json({ status: "done", id: outTxn.id }, { status: 201 });
      });
    } catch (e) {
      if (e instanceof TransferError) return NextResponse.json({ error: clientMessage(e.message) }, { status: e.status });
      throw e;
    }
  });
}
const NOTE = "client transfer";

function clientMessage(m: string): string {
  if (m === "cannot transfer to the same account") return "Pick two different accounts.";
  if (m === "cannot transfer between a Demo and a Live account") return "Transfers stay within live or within demo accounts.";
  if (m.startsWith("currency mismatch")) return "Both accounts need the same currency.";
  if (m === "insufficient balance on the source account") return "Not enough balance on the source account.";
  if (m.startsWith("transfer refused:")) return "Free margin on the source account does not cover this amount.";
  if (m === "both accounts must be active") return "Both accounts must be active.";
  return m;
}
