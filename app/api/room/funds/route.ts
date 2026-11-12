import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { roomMethods, withdrawable, payoutMethods, newPaymentReference } from "@/lib/room/funds";
import { roomTransactions } from "@/lib/room/transactions";
import { findWallet } from "@/lib/room/wallet";
import { WALLET_KEY, NEW_WALLET_NUMBER } from "@/lib/room/wallet-key";

// GET ?account=<id>: what the Deposit / Withdraw / Transfer screens need for one own account: the broker's methods,
// a fresh payment reference, the withdrawable amount, saved payout methods, pending withdrawals, KYC state and the
// recent transfers. Demo accounts have no funding (their balance is play money).
export async function GET(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const asked = new URL(request.url).searchParams.get("account");
  if (asked === WALLET_KEY) {
    const w = await findWallet(session.clientId, session.brokerId);
    if (!w) return newWalletFunds(session.clientId, session.brokerId);
  }
  const account = asked === WALLET_KEY ? await ownAccount(session, (await findWallet(session.clientId, session.brokerId))?.id) : await ownAccount(session, asked);
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const own = await prisma.account.findMany({ where: { clientId: session.clientId, brokerId: session.brokerId, status: { not: "CLOSED" } }, select: { id: true, accountNumber: true } });
  const [methods, avail, saved, pending, kyc, transfers] = await Promise.all([
    roomMethods(session.brokerId),
    withdrawable(account.id),
    payoutMethods(session.clientId),
    prisma.transaction.findMany({ where: { accountId: account.id, type: "WITHDRAWAL", status: "PENDING" }, select: { id: true, amount: true, createdAt: true }, orderBy: { createdAt: "desc" } }),
    prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } }),
    roomTransactions({ accountIds: own.map((a) => a.id), types: ["Transfer"] }, new Set(own.map((a) => a.accountNumber)), { skip: 0, take: 5 }),
  ]);
  return NextResponse.json({
    account: { id: account.id, accountNumber: account.accountNumber, mode: account.accountMode, currency: account.currency },
    methods,
    reference: newPaymentReference(account.accountNumber),
    available: avail.available,
    payoutMethods: saved,
    pendingWithdrawals: pending.map((p) => ({ id: p.id, amount: p.amount.abs().toFixed(2), at: p.createdAt.toISOString() })),
    kyc: kyc?.status ?? "NONE",
    transfers: transfers.rows,
  });
}

// the wallet the client has not used yet: nothing to withdraw, no pending requests, the broker's account currency
async function newWalletFunds(clientId: string, brokerId: string) {
  const [methods, saved, kyc, broker] = await Promise.all([
    roomMethods(brokerId),
    payoutMethods(clientId),
    prisma.clientKycRecord.findUnique({ where: { clientId }, select: { status: true } }),
    prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { defaultAccountCurrency: true } }),
  ]);
  return NextResponse.json({
    account: { id: WALLET_KEY, accountNumber: NEW_WALLET_NUMBER, mode: "LIVE", currency: broker.defaultAccountCurrency },
    methods,
    reference: newPaymentReference(NEW_WALLET_NUMBER),
    available: "0.00",
    payoutMethods: saved,
    pendingWithdrawals: [],
    kyc: kyc?.status ?? "NONE",
    transfers: [],
  });
}
