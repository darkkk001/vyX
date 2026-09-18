import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { generateTemporaryPassword } from "@/lib/passwords";
import { sendBrokerEmail } from "@/lib/email/adapter";
import { renderBrokerEmail } from "@/lib/email/template";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Resets a trading account's password. If the account has an email on file AND the
// broker's mail is configured (emailEnabled + a verified From), the new temporary
// password is emailed to the client and the admin is told it was sent ({emailed}).
// Otherwise the password is handed back to the admin to relay manually ({password}),
// with {emailFallback} when an email existed but the broker's mail isn't set up.
// The password is generated once, never stored in plaintext, never echoed again after
// this response (see lib/passwords.ts). Always audited (ACCOUNT_PASSWORD_RESET).
// Every existing session of the account is revoked with it: this is the
// broker's "this account is compromised" action, and until 2026-09-18 an
// attacker holding a session cookie simply kept trading through it.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const account = await prisma.account.findUnique({ where: { id } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const password = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction([
    prisma.account.update({ where: { id: account.id }, data: { passwordHash } }),
    prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "ACCOUNT_PASSWORD_RESET",
        entityType: "Account",
        entityId: account.id,
        newValue: { accountNumber: account.accountNumber },
      },
    }),
  ]);
  await revokeAllAccountSessions(account.id);

  const email = (account.email ?? "").trim();
  const broker = await prisma.broker.findUnique({
    where: { id: brokerId },
    select: { name: true, logoUrl: true, primaryColor: true, supportEmail: true, emailEnabled: true, emailFromAddress: true, emailFromName: true },
  });
  const emailConfigured = !!(broker?.emailEnabled && broker?.emailFromAddress);

  if (email && emailConfigured) {
    const brokerName = broker!.name ?? "your broker";
    const { html, text } = renderBrokerEmail(
      { name: brokerName, logoUrl: broker!.logoUrl ?? null, primaryColor: broker!.primaryColor ?? null, supportEmail: broker!.supportEmail ?? null },
      {
        preheader: `Your ${brokerName} trading account password was reset.`,
        heading: "Your password was reset",
        bodyLines: [
          `The password for your trading account ${account.accountNumber} was reset by ${brokerName}.`,
          `Your temporary password is: ${password}`,
          `Please sign in and change it as soon as you can.`,
        ],
        extraNote: "If you did not expect this, contact support.",
      }
    );
    try {
      await sendBrokerEmail(
        { name: brokerName, emailEnabled: broker!.emailEnabled, emailFromAddress: broker!.emailFromAddress, emailFromName: broker!.emailFromName },
        { to: email, subject: `Your password was reset for ${brokerName}`, html, text }
      );
      return NextResponse.json({ emailed: true, to: email });
    } catch (err) {
      console.error("[reset-password] email send failed, returning password to admin", err);
      return NextResponse.json({ password, emailFallback: true });
    }
  }

  return NextResponse.json({ password, emailFallback: !!email && !emailConfigured });
}
