import "server-only";
import { prisma } from "@/lib/prisma";
import { sendBrokerEmail } from "@/lib/email/adapter";
import { renderBrokerEmail } from "@/lib/email/template";
import { brokerPublicOrigin } from "@/lib/request-origin";

// Short, broker-branded e-mails about a decision on the client's own request. Sent after the decision committed: a failed
// send is logged and never fails or undoes the decision.
async function send(args: { brokerId: string; to: string; subject: string; heading: string; lines: string[]; ctaLabel: string; path: string }) {
  try {
    const broker = await prisma.broker.findUnique({
      where: { id: args.brokerId },
      select: { name: true, subdomain: true, customDomain: true, logoUrl: true, primaryColor: true, supportEmail: true, emailEnabled: true, emailFromAddress: true, emailFromName: true },
    });
    if (!broker) return;
    const { html, text } = renderBrokerEmail(
      { name: broker.name, logoUrl: broker.logoUrl, primaryColor: broker.primaryColor, supportEmail: broker.supportEmail },
      { preheader: args.subject, heading: args.heading, bodyLines: args.lines, cta: { label: args.ctaLabel, url: `${brokerPublicOrigin(broker)}${args.path}` } }
    );
    await sendBrokerEmail(
      { name: broker.name, emailEnabled: broker.emailEnabled, emailFromAddress: broker.emailFromAddress, emailFromName: broker.emailFromName },
      { to: args.to, subject: args.subject, html, text }
    );
  } catch (err) {
    console.error("[client-notices] e-mail failed", err);
  }
}

export function sendKycDecisionEmail(args: { brokerId: string; to: string; approved: boolean; rejectionReason: string }) {
  return send({
    brokerId: args.brokerId,
    to: args.to,
    subject: args.approved ? "Your verification is approved" : "Your verification needs attention",
    heading: args.approved ? "Verification approved" : "Verification not approved",
    lines: args.approved
      ? ["Your documents have been approved. You can now fund your account and withdraw."]
      : [args.rejectionReason ? `Your documents were not approved: ${args.rejectionReason}` : "Your documents were not approved.", "Please upload them again."],
    ctaLabel: args.approved ? "Open your account" : "Upload documents",
    path: args.approved ? "/room" : "/room/verify",
  });
}

export function sendFundsDecisionEmail(args: { brokerId: string; to: string; kind: "DEPOSIT" | "WITHDRAWAL"; approved: boolean; amount: string; currency: string; accountNumber: string; reviewNote: string | null }) {
  const what = args.kind === "DEPOSIT" ? "deposit" : "withdrawal";
  const money = `${args.amount} ${args.currency}`;
  const word = args.approved ? "approved" : "rejected";
  return send({
    brokerId: args.brokerId,
    to: args.to,
    subject: `Your ${what} of ${money} was ${word}`,
    heading: `${what === "deposit" ? "Deposit" : "Withdrawal"} ${word}`,
    lines: [`Your ${what} of ${money} on account ${args.accountNumber} was ${word}.`, ...(!args.approved && args.reviewNote ? [`Reason: ${args.reviewNote}`] : [])],
    ctaLabel: "View history",
    path: "/room/history",
  });
}
