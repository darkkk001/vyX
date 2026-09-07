import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";
import { createNotification } from "@/lib/notifications";
import { checkRateLimit } from "@/lib/rate-limit";

// A Live account is gated on KYC (LiveAccountRequest's own schema
// comment) -- a client can't submit one of these while their
// ClientKycRecord.status isn't APPROVED. Unlike Demo (created instantly,
// see app/api/portal/accounts/route.ts), this only ever creates a
// PENDING request; the real Account is created at approval time
// (app/api/manage/live-account-requests/[id]/route.ts).
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const requests = await prisma.liveAccountRequest.findMany({
    where: { clientId: session.clientId },
    select: { id: true, status: true, rejectionReason: true, accountType: { select: { name: true } }, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    requests.map((r) => ({
      id: r.id,
      status: r.status,
      rejectionReason: r.rejectionReason,
      accountTypeName: r.accountType?.name ?? null,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { allowed } = await checkRateLimit(`portal-live-request:${session.clientId}`, 5, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const kyc = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId } });
  if (!kyc || kyc.status !== "APPROVED") {
    return NextResponse.json({ error: "complete KYC verification before opening a Live account" }, { status: 403 });
  }

  const existingPending = await prisma.liveAccountRequest.findFirst({
    where: { clientId: session.clientId, status: "PENDING" },
  });
  if (existingPending) {
    return NextResponse.json({ error: "you already have a Live account request under review" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  let accountTypeId: string | null = null;
  if (typeof body?.accountTypeId === "string" && body.accountTypeId) {
    const found = await prisma.accountType.findUnique({ where: { id: body.accountTypeId } });
    if (!found || found.brokerId !== session.brokerId || !found.enabled) {
      return NextResponse.json({ error: "account type not found" }, { status: 404 });
    }
    accountTypeId = found.id;
  } else {
    const defaultType = await prisma.accountType.findFirst({ where: { brokerId: session.brokerId, isDefault: true } });
    accountTypeId = defaultType?.id ?? null;
  }

  const created = await prisma.liveAccountRequest.create({
    data: { brokerId: session.brokerId, clientId: session.clientId, accountTypeId, status: "PENDING" },
  });

  const client = await prisma.client.findUnique({ where: { id: session.clientId }, select: { fullName: true, email: true } });
  await createNotification(prisma, {
    brokerId: session.brokerId,
    type: "LIVE_ACCOUNT_REQUESTED",
    title: "New Live account request",
    body: `${client?.fullName ?? session.clientId} (${client?.email ?? ""}) requested a Live account`,
    entityType: "LiveAccountRequest",
    entityId: created.id,
  });

  return NextResponse.json({ id: created.id, status: created.status }, { status: 201 });
}
