import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { clientRef } from "@/lib/crm/core";

// Partner payout requests from the Trader's Room. Paying stays the existing IB payout (IB tab: pay the links, maker-
// checker as today); this queue only shows who asked and lets staff close the request. Permission IB_PAYOUTS.
// GET -> pending. PATCH {id, action: DONE|DECLINE}.
async function gate() {
  const s = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(s, "IB_PAYOUTS")) return null;
  return s!;
}

export async function GET() {
  const s = await gate();
  if (!s) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await prisma.ibPayoutRequest.findMany({ where: { brokerId: s.brokerId!, status: "PENDING" }, orderBy: { createdAt: "asc" } });
  const [clients, accounts] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: rows.map((r) => r.clientId) } }, select: { id: true, clientNumber: true, fullName: true } }),
    prisma.account.findMany({ where: { id: { in: rows.map((r) => r.ibAccountId) } }, select: { id: true, accountNumber: true } }),
  ]);
  const c = new Map(clients.map((x) => [x.id, x]));
  const a = new Map(accounts.map((x) => [x.id, x.accountNumber]));
  return NextResponse.json({ requests: rows.map((r) => ({ id: r.id, client: c.get(r.clientId) ? `${clientRef(c.get(r.clientId)!.clientNumber)} ${c.get(r.clientId)!.fullName}` : "", ibAccount: a.get(r.ibAccountId) ?? "", amount: r.amount.toFixed(2), requestedAt: r.createdAt.toISOString() })) });
}

export async function PATCH(request: NextRequest) {
  const s = await gate();
  if (!s) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = await request.json().catch(() => null);
  const status = b?.action === "DONE" ? "APPROVED" : b?.action === "DECLINE" ? "REJECTED" : null;
  if (typeof b?.id !== "string" || !status) return NextResponse.json({ error: "Bad request." }, { status: 400 });
  const done = await prisma.ibPayoutRequest.updateMany({ where: { id: b.id, brokerId: s.brokerId!, status: "PENDING" }, data: { status, reviewedAt: new Date() } });
  if (done.count === 0) return NextResponse.json({ error: "Request not found or already closed." }, { status: 404 });
  const r = await prisma.ibPayoutRequest.findUniqueOrThrow({ where: { id: b.id } });
  await prisma.auditLog.create({ data: { brokerId: s.brokerId!, actorAdminId: s.adminId, clientId: r.clientId, action: status === "APPROVED" ? "IB_PAYOUT_REQUEST_DONE" : "IB_PAYOUT_REQUEST_DECLINED", entityType: "Account", entityId: r.ibAccountId, newValue: { requestId: r.id, amount: r.amount.toFixed(2) } } });
  return NextResponse.json({ status });
}
