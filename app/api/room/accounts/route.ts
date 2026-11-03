import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { roomPlans, groupCeiling, leverageOptions } from "@/lib/room/plans";
import { tierLeverageCeiling } from "@/lib/room/tier";
import { provisionAccount } from "@/lib/account-provisioning";
import { AccountStructureError } from "@/lib/account-structure";
import { GUEST_START_BALANCE } from "@/lib/demo";
import { checkRateLimit } from "@/lib/rate-limit";
import { createNotification } from "@/lib/notifications";
import { publishTradingEvent } from "@/lib/nats";
import { advanceLead } from "@/lib/crm/leads";

// Trader's Room Accounts screen.
// GET ?mode=LIVE|DEMO -> the plans for that mode, each own account's leverage ceiling / choices / pending request,
//                        the pending live-account request, KYC state.
// POST {mode, groupId, leverage, currency} -> DEMO: created now (starting balance 10,000, the client's own password);
//                        LIVE: a request for the broker (KYC approved first), the plan and leverage kept as its defaults.
export async function GET(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const mode = new URL(request.url).searchParams.get("mode") === "DEMO" ? "DEMO" : "LIVE";

  const [plans, accounts, pending, liveRequest, kyc, broker] = await Promise.all([
    roomPlans(session.brokerId, mode),
    prisma.account.findMany({
      where: { clientId: session.clientId, brokerId: session.brokerId, status: "ACTIVE" },
      select: { id: true, leverage: true, group: { select: { leverage: true, planMaxLeverage: true } } },
    }),
    prisma.leverageChangeRequest.findMany({ where: { clientId: session.clientId, status: "PENDING" }, select: { accountId: true, toLeverage: true, createdAt: true } }),
    prisma.liveAccountRequest.findFirst({ where: { clientId: session.clientId, status: "PENDING" }, select: { id: true, createdAt: true } }),
    prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } }),
    prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId }, select: { defaultAccountCurrency: true, defaultAccountLeverage: true, leverageChangeReview: true } }),
  ]);
  const pendingBy = new Map(pending.map((p) => [p.accountId, p]));
  const tierCeiling = await tierLeverageCeiling(session.brokerId, session.clientId);
  return NextResponse.json({
    mode,
    plans,
    currencies: [broker.defaultAccountCurrency],
    leverageReview: broker.leverageChangeReview,
    leverage: accounts.map((a) => {
      const ceiling = Math.max(a.group ? groupCeiling(a.group) : broker.defaultAccountLeverage, tierCeiling ?? 0);
      const p = pendingBy.get(a.id);
      return { accountId: a.id, current: a.leverage, ceiling, options: leverageOptions(ceiling), pending: p ? { to: p.toLeverage, at: p.createdAt.toISOString() } : null };
    }),
    liveRequest: liveRequest ? { at: liveRequest.createdAt.toISOString() } : null,
    kycApproved: kyc?.status === "APPROVED",
  });
}

export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-open-account:${session.clientId}`, 6, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const mode = body?.mode === "DEMO" ? "DEMO" : body?.mode === "LIVE" ? "LIVE" : null;
  if (!mode) return NextResponse.json({ error: "Pick Live or Demo." }, { status: 400 });
  const plan = (await roomPlans(session.brokerId, mode)).find((p) => p.groupId === body?.groupId);
  if (!plan) return NextResponse.json({ error: "Pick a plan." }, { status: 400 });
  const leverage = Number(body?.leverage);
  if (!Number.isInteger(leverage) || !plan.leverageOptions.includes(leverage)) {
    return NextResponse.json({ error: `Pick a leverage up to 1:${plan.maxLeverage}.` }, { status: 400 });
  }
  const [client, broker] = await Promise.all([
    prisma.client.findUnique({ where: { id: session.clientId }, select: { id: true, fullName: true, email: true, passwordHash: true, country: true, phone: true, dateOfBirth: true, kycRecord: { select: { status: true } } } }),
    prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId }, select: { defaultAccountCurrency: true } }),
  ]);
  if (!client) return NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 });
  const currency = typeof body?.currency === "string" && body.currency === broker.defaultAccountCurrency ? body.currency : broker.defaultAccountCurrency;

  if (mode === "DEMO") {
    const demoCount = await prisma.account.count({ where: { clientId: client.id, accountMode: "DEMO", status: "ACTIVE" } });
    if (demoCount >= 5) return NextResponse.json({ error: "You already have 5 demo accounts." }, { status: 409 });
    try {
      const account = await provisionAccount({
        brokerId: session.brokerId, fullName: client.fullName, email: client.email, passwordHash: client.passwordHash,
        accountMode: "DEMO", accountTypeId: null, currency, leverage, groupId: plan.groupId,
        initialBalance: new Prisma.Decimal(GUEST_START_BALANCE), country: client.country, phone: client.phone, dateOfBirth: client.dateOfBirth,
        clientId: client.id, createdByAdminId: null,
      });
      await advanceLead(session.brokerId, client.id, "DEMO");
      return NextResponse.json({ status: "created", accountNumber: account.accountNumber }, { status: 201 });
    } catch (error) {
      if (error instanceof AccountStructureError) return NextResponse.json({ error: "This plan is not available for demo." }, { status: 400 });
      throw error;
    }
  }

  if (client.kycRecord?.status !== "APPROVED") {
    return NextResponse.json({ error: "Verify your identity before opening a live account.", code: "KYC_REQUIRED" }, { status: 403 });
  }
  const existing = await prisma.liveAccountRequest.findFirst({ where: { clientId: client.id, status: "PENDING" }, select: { id: true } });
  if (existing) return NextResponse.json({ error: "Your live account request is already with your broker." }, { status: 409 });
  const created = await prisma.liveAccountRequest.create({
    data: { brokerId: session.brokerId, clientId: client.id, accountTypeId: null, status: "PENDING", requestedGroupId: plan.groupId, requestedLeverage: leverage, requestedCurrency: currency },
  });
  await prisma.auditLog.create({
    data: { brokerId: session.brokerId, clientId: client.id, action: "LIVE_ACCOUNT_REQUESTED", entityType: "LiveAccountRequest", entityId: created.id, newValue: { plan: plan.name, groupId: plan.groupId, leverage, currency, source: "CLIENT" } },
  });
  await createNotification(prisma, {
    brokerId: session.brokerId, type: "LIVE_ACCOUNT_REQUESTED", title: "New Live account request",
    body: `${client.fullName} (${client.email}) requested a Live ${plan.name} account, 1:${leverage}`,
    entityType: "LiveAccountRequest", entityId: created.id,
  });
  await publishTradingEvent("LiveAccountRequested", { broker_id: session.brokerId, request_id: created.id }).catch(() => {});
  return NextResponse.json({ status: "requested" }, { status: 201 });
}
