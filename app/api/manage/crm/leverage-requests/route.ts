import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { checkLeverageChange, applyLeverageChange, LeverageChangeError } from "@/lib/room/leverage-change";
import { publishRoomChanged } from "@/lib/room/events";

// Client leverage requests (Trader's Room, broker reviews leverage changes). Same permission as a direct leverage edit:
// BROKER_ADMIN or ACCOUNT_FINANCE. GET -> pending ones with the margin level now and after. PATCH {id, action:
// APPROVE|REJECT, reason?} -> approve re-runs the stop-out check at that moment and applies; reject keeps the leverage.
async function gate() {
  const s = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(s, "ACCOUNT_FINANCE")) return null;
  return s!;
}

export async function GET() {
  const s = await gate();
  if (!s) return NextResponse.json({ error: "forbidden: leverage changes need BROKER_ADMIN or ACCOUNT_FINANCE" }, { status: 403 });
  const rows = await prisma.leverageChangeRequest.findMany({
    where: { brokerId: s.brokerId!, status: "PENDING" },
    select: { id: true, fromLeverage: true, toLeverage: true, createdAt: true, accountId: true, account: { select: { accountNumber: true, fullName: true, leverage: true } } },
    orderBy: { createdAt: "asc" },
  });
  const out = await Promise.all(rows.map(async (r) => {
    let after: string | null = null, level: string | null = null, refusal: string | null = null;
    try {
      const c = await checkLeverageChange(r.accountId, r.toLeverage);
      level = c.marginLevel?.toFixed(1) ?? null;
      after = c.marginLevelAfter?.toFixed(1) ?? null;
    } catch (e) { refusal = e instanceof LeverageChangeError ? e.message : "Cannot check right now."; }
    return { id: r.id, accountNumber: r.account.accountNumber, fullName: r.account.fullName, from: r.fromLeverage, to: r.toLeverage, current: r.account.leverage, requestedAt: r.createdAt.toISOString(), marginLevel: level, marginLevelAfter: after, refusal };
  }));
  return NextResponse.json({ requests: out });
}

export async function PATCH(request: NextRequest) {
  const s = await gate();
  if (!s) return NextResponse.json({ error: "forbidden: leverage changes need BROKER_ADMIN or ACCOUNT_FINANCE" }, { status: 403 });
  const b = await request.json().catch(() => null);
  const action = b?.action === "APPROVE" ? "APPROVE" : b?.action === "REJECT" ? "REJECT" : null;
  if (typeof b?.id !== "string" || !action) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const req = await prisma.leverageChangeRequest.findFirst({ where: { id: b.id, brokerId: s.brokerId!, status: "PENDING" } });
  if (!req) return NextResponse.json({ error: "Request not found or already reviewed." }, { status: 404 });
  if (action === "REJECT") {
    const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 300) : null;
    const done = await prisma.leverageChangeRequest.updateMany({ where: { id: req.id, status: "PENDING" }, data: { status: "REJECTED", rejectionReason: reason, reviewedByAdminId: s.adminId, reviewedAt: new Date() } });
    if (done.count === 0) return NextResponse.json({ error: "Already reviewed." }, { status: 409 });
    await prisma.auditLog.create({ data: { brokerId: s.brokerId!, actorAdminId: s.adminId, clientId: req.clientId, action: "LEVERAGE_CHANGE_REJECTED", entityType: "Account", entityId: req.accountId, newValue: { requestId: req.id, to: req.toLeverage, reason } } });
    await publishRoomChanged(s.brokerId!, [req.accountId], "account");
    return NextResponse.json({ status: "REJECTED" });
  }
  let check;
  try { check = await checkLeverageChange(req.accountId, req.toLeverage); }
  catch (e) {
    if (e instanceof LeverageChangeError && e.code) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status }); // B1: LEVERAGE_ABOVE_GROUP_MAX
    return NextResponse.json({ error: e instanceof LeverageChangeError ? e.message : "Cannot check right now." }, { status: 409 });
  }
  const claim = await prisma.leverageChangeRequest.updateMany({ where: { id: req.id, status: "PENDING" }, data: { status: "APPROVED", reviewedByAdminId: s.adminId, reviewedAt: new Date() } });
  if (claim.count === 0) return NextResponse.json({ error: "Already reviewed." }, { status: 409 });
  const ok = await applyLeverageChange({ brokerId: s.brokerId!, accountId: req.accountId, clientId: req.clientId, from: check.from, to: req.toLeverage, actorAdminId: s.adminId, requestId: req.id, marginLevelBefore: check.marginLevel, marginLevelAfter: check.marginLevelAfter });
  if (!ok) {
    await prisma.leverageChangeRequest.update({ where: { id: req.id }, data: { status: "PENDING", reviewedByAdminId: null, reviewedAt: null } });
    return NextResponse.json({ error: "The leverage changed meanwhile. Review again." }, { status: 409 });
  }
  return NextResponse.json({ status: "APPROVED", leverage: req.toLeverage });
}
