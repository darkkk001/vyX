import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { accountFigures } from "@/lib/room/figures";
import { checkRateLimit } from "@/lib/rate-limit";
import { publishTradingEvent } from "@/lib/nats";
import { publishRoomChanged } from "@/lib/room/events";
import { openStake, planOf, StakeError } from "@/lib/room/staking";

// GET: the broker's plan, the client's eligible accounts with their free margin, active stakes and history.
// POST {accountId, amount}: a new stake (lib/room/staking.ts). A broker without the feature answers 404.
const view = (s: { id: string; amount: Prisma.Decimal; currency: string; ratePct: Prisma.Decimal; cycleDays: number; returnAmount: Prisma.Decimal; startAt: Date; endAt: Date; paidAt: Date | null; status: string; account: { accountNumber: string } }) => ({
  id: s.id, account: s.account.accountNumber, amount: s.amount.toFixed(2), currency: s.currency, ratePct: s.ratePct.toString(), cycleDays: s.cycleDays,
  returnAmount: s.returnAmount.toFixed(2), startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), paidAt: s.paidAt?.toISOString() ?? null, status: s.status,
});

export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId }, select: { stakingEnabled: true, stakingMinAmount: true, stakingCycleDays: true, stakingRatePct: true } });
  if (!broker.stakingEnabled) return NextResponse.json({ error: "Staking is not available." }, { status: 404 });
  const [kyc, accounts, stakes] = await Promise.all([
    prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } }),
    prisma.account.findMany({ where: { clientId: session.clientId, brokerId: session.brokerId, accountMode: "LIVE", status: "ACTIVE" }, select: { id: true, accountNumber: true, currency: true, leverage: true, balance: true, credit: true, brokerId: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.stake.findMany({ where: { clientId: session.clientId, brokerId: session.brokerId }, orderBy: { startAt: "desc" }, take: 100, include: { account: { select: { accountNumber: true } } } }),
  ]);
  const verified = kyc?.status === "APPROVED";
  return NextResponse.json({
    verified,
    plan: planOf(broker),
    accounts: verified ? await Promise.all(accounts.map(async (a) => ({ id: a.id, accountNumber: a.accountNumber, currency: a.currency, free: (await accountFigures(a)).freeMargin }))) : [],
    active: stakes.filter((s) => s.status === "ACTIVE").map(view),
    history: stakes.filter((s) => s.status !== "ACTIVE").map(view),
  });
}

export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-stake:${session.clientId}`, 6, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  const body = await request.json().catch(() => null);
  let amount: Prisma.Decimal;
  try { amount = new Prisma.Decimal(String(body?.amount ?? "")); } catch { return NextResponse.json({ error: "Enter an amount." }, { status: 400 }); }
  if (!amount.gt(0)) return NextResponse.json({ error: "Enter an amount." }, { status: 400 });
  try {
    const { stake, transactionId } = await openStake({ brokerId: session.brokerId, clientId: session.clientId, accountId: String(body?.accountId ?? ""), amount });
    await publishTradingEvent("BalanceChanged", { account_id: stake.accountId, broker_id: session.brokerId, transaction_id: transactionId }).catch(() => {});
    await publishRoomChanged(session.brokerId, [stake.accountId], "funds");
    return NextResponse.json({ id: stake.id }, { status: 201 });
  } catch (e) {
    if (e instanceof StakeError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
