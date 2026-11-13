import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { consumePasswordResetToken, hashPassword } from "@/lib/client-auth";
import { replaceClientPassword } from "@/lib/client-password";
import { checkRateLimit } from "@/lib/rate-limit";
import { humanCheckRefusal } from "@/lib/turnstile";
import { clientIpOf } from "@/lib/demo";
import { clientIp } from "@/lib/order-execution";

// Consumes the token POST /api/portal/forgot-password minted (single-use,
// 1h TTL) and sets a new password. Does NOT log the client in -- same as
// most real reset flows, forces a fresh login with the new credential
// rather than trusting possession of the reset link as an ongoing session.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }
  const byIp = await checkRateLimit(`portal-reset-password-ip:${brokerId}:${clientIpOf(request.headers)}`, 20, 60 * 60);
  if (!byIp.allowed) {
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  const refused = await humanCheckRefusal(brokerId, body?.turnstileToken, clientIp(request.headers));
  if (refused) return refused;
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json({ error: "reset token is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  const clientId = await consumePasswordResetToken(token);
  if (!clientId) {
    return NextResponse.json({ error: "this reset link is invalid or has expired, request a new one" }, { status: 400 });
  }

  // the link reached this person's inbox, so the e-mail is proven too (a CRM invitation arrives unverified)
  const current = await prisma.client.findUnique({ where: { id: clientId }, select: { emailVerifiedAt: true, brokerId: true } });
  // a reset link only works on the broker it was sent from
  if (!current || current.brokerId !== brokerId) {
    return NextResponse.json({ error: "this reset link is invalid or has expired, request a new one" }, { status: 400 });
  }
  const passwordHash = await hashPassword(password);
  // A reset is the takeover remediation: the old credential dies everywhere, trading accounts included, with every
  // existing session (pentest 2026-09-18 #2, review 2026-11-05). Nothing to keep -- this flow never logs the client in.
  await replaceClientPassword({
    clientId,
    passwordHash,
    clientData: current && !current.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {},
    action: "CLIENT_PASSWORD_RESET",
    audit: { via: "reset-link" },
  });

  return NextResponse.json({ ok: true });
}
