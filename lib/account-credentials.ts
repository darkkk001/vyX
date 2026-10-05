import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { sendBrokerEmail } from "@/lib/email/adapter";
import { renderBrokerEmail } from "@/lib/email/template";

// Staff credentials for a trading account (owner 2026-10-05, docs/contracts/staff-credentials.md): the reset /
// set-password / password-revealed routes share the gate, the e-mail and the password rule from here.

export type NotEmailedReason = "UNAVAILABLE" | "INTERNAL_ACCOUNT" | "NO_EMAIL" | "NOT_REQUESTED";
export type EmailOutcome = { emailed: boolean; to: string | null; notEmailedReason: NotEmailedReason | null };

export type CredentialAccount = { id: string; brokerId: string; accountNumber: string; email: string | null; isInternal: boolean };

// Same gate as the password reset always had: BROKER_ADMIN or any MANAGER of the account's own broker. SUPPORT and
// other brokers are refused; another broker's account answers 404 exactly like a missing one.
export async function requireAccountForCredentials(id: string): Promise<
  { ok: true; adminId: string; brokerId: string; account: CredentialAccount } | { ok: false; response: NextResponse }
> {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  const account = await prisma.account.findUnique({
    where: { id },
    select: { id: true, brokerId: true, accountNumber: true, email: true, isInternal: true },
  });
  if (!account || account.brokerId !== session!.brokerId) {
    return { ok: false, response: NextResponse.json({ error: "account not found" }, { status: 404 }) };
  }
  return { ok: true, adminId: session!.adminId, brokerId: session!.brokerId!, account };
}

// At least 8 characters, a letter and a digit, at most 128. The platform had no shared rule (each form checked only
// "at least 8"); this is the owner's stated fallback for staff-chosen client passwords.
export const PASSWORD_RULE_TEXT = "Use at least 8 characters with letters and digits.";
export function passwordIsStrong(pw: string): boolean {
  return pw.length >= 8 && pw.length <= 128 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

// E-mails the new password to the account's own address. Internal accounts are NEVER e-mailed, whatever was asked.
export async function emailNewPassword(account: CredentialAccount, password: string, kind: "reset" | "set"): Promise<EmailOutcome> {
  if (account.isInternal) return { emailed: false, to: null, notEmailedReason: "INTERNAL_ACCOUNT" };
  const email = (account.email ?? "").trim();
  if (!email) return { emailed: false, to: null, notEmailedReason: "NO_EMAIL" };
  const broker = await prisma.broker.findUnique({
    where: { id: account.brokerId },
    select: { name: true, logoUrl: true, primaryColor: true, supportEmail: true, emailEnabled: true, emailFromAddress: true, emailFromName: true },
  });
  if (!broker?.emailEnabled || !broker.emailFromAddress) return { emailed: false, to: null, notEmailedReason: "UNAVAILABLE" };

  const brokerName = broker.name ?? "your broker";
  const { html, text } = renderBrokerEmail(
    { name: brokerName, logoUrl: broker.logoUrl ?? null, primaryColor: broker.primaryColor ?? null, supportEmail: broker.supportEmail ?? null },
    kind === "reset"
      ? {
          preheader: `Your ${brokerName} trading account password was reset.`,
          heading: "Your password was reset",
          bodyLines: [
            `The password for your trading account ${account.accountNumber} was reset by ${brokerName}.`,
            `Your temporary password is: ${password}`,
            `Please sign in and change it as soon as you can.`,
          ],
          extraNote: "If you did not expect this, contact support.",
        }
      : {
          preheader: `Your ${brokerName} trading account has a new password.`,
          heading: "Your password was changed",
          bodyLines: [
            `${brokerName} set a new password for your trading account ${account.accountNumber}.`,
            `Your new password is: ${password}`,
            `You can change it after you sign in.`,
          ],
          extraNote: "If you did not expect this, contact support.",
        }
  );
  try {
    await sendBrokerEmail(
      { name: brokerName, emailEnabled: broker.emailEnabled, emailFromAddress: broker.emailFromAddress, emailFromName: broker.emailFromName },
      { to: email, subject: kind === "reset" ? `Your password was reset for ${brokerName}` : `Your password was changed for ${brokerName}`, html, text }
    );
    return { emailed: true, to: email, notEmailedReason: null };
  } catch (err) {
    console.error(`[account-credentials] ${kind} e-mail send failed`, err);
    return { emailed: false, to: null, notEmailedReason: "UNAVAILABLE" };
  }
}
