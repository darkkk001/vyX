import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

// Pre-auth (no trader session exists yet) -- replaces a mailto: link
// with an actual in-app request: shows up as a Notification in the
// broker's Manager backoffice (app/manage/(shell)/notifications), which
// a dealer can act on directly (reset the password) rather than relying
// on the trader's device having an email client configured, or the
// broker noticing a stray email.
export async function POST(request: NextRequest) {
  const brokerId = request.headers.get("x-broker-id");
  if (!brokerId) {
    return NextResponse.json({ error: "no broker resolved for this domain" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const accountNumber = typeof body?.accountNumber === "string" ? body.accountNumber.trim() : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!accountNumber) {
    return NextResponse.json({ error: "accountNumber is required" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`forgot-password:${brokerId}:${accountNumber}`, 3, 3600);
  if (!allowed) {
    // Same generic response as success -- doesn't reveal whether the
    // rate limit or a real send is what happened.
    return NextResponse.json({ ok: true });
  }

  const account = await prisma.account.findFirst({ where: { brokerId, accountNumber } });
  // Only records a request for an account that actually exists (same
  // "don't leak whether this identifier is real" rule the login route
  // already applies) -- there's nothing a dealer could act on for a
  // typo'd account number anyway. Always returns the same generic
  // response either way.
  if (account) {
    await prisma.notification.create({
      data: {
        brokerId,
        type: "PASSWORD_RESET_REQUESTED",
        title: `Password reset requested: ${account.accountNumber}`,
        body: note ? `${account.fullName} (${account.accountNumber}): ${note}` : `${account.fullName} (${account.accountNumber}) requested a password reset.`,
        entityType: "Account",
        entityId: account.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
