import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { parseLeverage } from "@/lib/leverage";
import { checkRateLimit } from "@/lib/rate-limit";
import { createNotification } from "@/lib/notifications";
import { checkLeverageChange, applyLeverageChange, LeverageChangeError } from "@/lib/room/leverage-change";

// POST {accountId, leverage}: the client's own leverage change (lib/room/leverage-change.ts). Live and demo accounts
// alike; a live change waits for staff when the broker reviews leverage changes, a demo change never waits.
export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-leverage:${session.clientId}`, 6, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const account = await ownAccount(session, body?.accountId);
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const to = parseLeverage(body?.leverage);
  if (to == null) return NextResponse.json({ error: "Pick a leverage." }, { status: 400 });

  const pending = await prisma.leverageChangeRequest.findFirst({ where: { accountId: account.id, status: "PENDING" }, select: { id: true } });
  if (pending) return NextResponse.json({ error: "A leverage change for this account is already pending." }, { status: 409 });

  let check;
  try {
    check = await checkLeverageChange(account.id, to);
  } catch (e) {
    if (e instanceof LeverageChangeError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
    throw e;
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId }, select: { leverageChangeReview: true } });
  if (broker.leverageChangeReview && account.accountMode === "LIVE") {
    const req = await prisma.leverageChangeRequest.create({
      data: { brokerId: session.brokerId, accountId: account.id, clientId: session.clientId, fromLeverage: check.from, toLeverage: to },
    });
    await prisma.auditLog.create({
      data: { brokerId: session.brokerId, clientId: session.clientId, action: "LEVERAGE_CHANGE_REQUESTED", entityType: "Account", entityId: account.id, oldValue: { leverage: check.from }, newValue: { leverage: to, requestId: req.id, marginLevelBefore: check.marginLevel, marginLevelAfter: check.marginLevelAfter } },
    });
    await createNotification(prisma, {
      brokerId: session.brokerId, type: "LEVERAGE_CHANGE_REQUESTED", title: "Leverage change request",
      body: `${account.accountNumber}: 1:${check.from} to 1:${to}`, entityType: "LeverageChangeRequest", entityId: req.id,
    });
    return NextResponse.json({ status: "pending", leverage: check.from, requested: to });
  }

  const ok = await applyLeverageChange({ brokerId: session.brokerId, accountId: account.id, clientId: session.clientId, from: check.from, to, actorAdminId: null, marginLevelBefore: check.marginLevel, marginLevelAfter: check.marginLevelAfter });
  if (!ok) return NextResponse.json({ error: "The leverage changed meanwhile. Try again." }, { status: 409 });
  return NextResponse.json({ status: "applied", leverage: to });
}
