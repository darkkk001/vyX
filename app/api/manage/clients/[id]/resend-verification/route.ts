import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendClientVerificationEmail, STAFF_RESEND_PER_CLIENT_PER_HOUR, maskEmail } from "@/lib/email/verification-email";
import { requestOrigin } from "@/lib/request-origin";

// Staff "Resend verification e-mail" on a client-portal login (owner 2026-10-05, after the 12-day e-mail
// outage left sign-ups that could not verify). Same e-mail as portal register / resend
// (lib/email/verification-email.ts). Same gate as the client password reset: BROKER_ADMIN or any MANAGER of the
// client's own broker; the read-only SUPPORT role is refused like every write. Unlike the public portal route this
// one is explicit about why nothing was sent: staff need the reason (docs/contracts/staff-resend-verification.md).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const client = await prisma.client.findUnique({ where: { id }, select: { id: true, brokerId: true, email: true, status: true, emailVerifiedAt: true } });
  if (!client || client.brokerId !== brokerId) {
    return NextResponse.json({ error: "client not found", code: "CLIENT_NOT_FOUND" }, { status: 404 });
  }
  if (client.emailVerifiedAt) {
    return NextResponse.json({ error: "this client's e-mail is already verified", code: "ALREADY_VERIFIED" }, { status: 409 });
  }
  if (client.status !== "ACTIVE") {
    return NextResponse.json({ error: "this client is not active", code: "CLIENT_NOT_ACTIVE" }, { status: 409 });
  }
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { emailEnabled: true, emailFromAddress: true } });
  if (!broker?.emailEnabled || !broker.emailFromAddress) {
    return NextResponse.json({ error: "e-mail is not set up for this broker", code: "EMAIL_NOT_CONFIGURED" }, { status: 409 });
  }
  const limit = await checkRateLimit(`staff-resend-verification:${brokerId}:${client.id}`, STAFF_RESEND_PER_CLIENT_PER_HOUR, 60 * 60);
  if (!limit.allowed) {
    return NextResponse.json({ error: "too many resends for this client, try again later", code: "RATE_LIMITED" }, { status: 429 });
  }

  try {
    await sendClientVerificationEmail({ brokerId, clientId: client.id, email: client.email, fallbackOrigin: () => requestOrigin(request) });
  } catch (err) {
    // step 2: the provider's own error text (status, body) stays in the server log
    console.error("[staff-resend-verification] email send failed", err);
    return NextResponse.json({ error: "The e-mail could not be sent. Try again later.", code: "SEND_FAILED" }, { status: 502 });
  }

  await prisma.auditLog.create({
    data: {
      brokerId,
      actorAdminId: session!.adminId,
      action: "STAFF_VERIFICATION_RESENT",
      entityType: "Client",
      entityId: client.id,
      newValue: { email: client.email },
    },
  });

  return NextResponse.json({ sent: true, to: maskEmail(client.email) });
}
