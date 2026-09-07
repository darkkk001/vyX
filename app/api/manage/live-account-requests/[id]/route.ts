import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { generateTemporaryPassword } from "@/lib/passwords";
import { hashPassword } from "@/lib/client-auth";
import { provisionAccount } from "@/lib/account-provisioning";
import { stashRevealedCredentials } from "@/lib/live-account-credentials";
import { sendBrokerEmail } from "@/lib/email/adapter";
import { renderBrokerEmail } from "@/lib/email/template";
import { brokerPublicOrigin } from "@/lib/request-origin";

// Approving creates the real Account (LiveAccountRequest's own schema
// comment: there is no Account, and therefore no real credential, until
// this happens) -- rejecting just records why, same shape as every other
// decision route in this app. The generated password is never stored:
// it's stashed once for the client's own next portal visit
// (lib/live-account-credentials.ts) AND emailed immediately, since
// unlike Demo's own instant self-service creation, this approval happens
// out of band from anything the client is doing right now -- "portal +
// email" per the design, not portal alone.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.liveAccountRequest.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "request not found" }, { status: 404 });
  }
  if (existing.status !== "PENDING") {
    return NextResponse.json({ error: "request already reviewed" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action === "APPROVE" ? "APPROVE" : body?.action === "REJECT" ? "REJECT" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be APPROVE or REJECT" }, { status: 400 });
  }
  const rejectionReason = typeof body?.rejectionReason === "string" ? body.rejectionReason.trim().slice(0, 500) : "";
  if (action === "REJECT" && !rejectionReason) {
    return NextResponse.json({ error: "rejectionReason is required to reject" }, { status: 400 });
  }

  if (action === "REJECT") {
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.liveAccountRequest.update({
        where: { id },
        data: { status: "REJECTED", rejectionReason, reviewedByAdminId: session!.adminId, reviewedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "LIVE_ACCOUNT_REQUEST_REJECTED",
          entityType: "LiveAccountRequest",
          entityId: id,
          oldValue: { status: "PENDING" },
          newValue: { status: "REJECTED", rejectionReason },
        },
      });
      return r;
    });
    return NextResponse.json({ id: updated.id, status: updated.status });
  }

  // APPROVE
  const [client, broker] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: existing.clientId } }),
    prisma.broker.findUniqueOrThrow({
      where: { id: brokerId },
      select: {
        name: true, subdomain: true, customDomain: true, logoUrl: true, primaryColor: true, supportEmail: true,
        defaultAccountCurrency: true, defaultAccountLeverage: true,
        emailEnabled: true, emailFromAddress: true, emailFromName: true,
      },
    }),
  ]);
  const defaultGroup = await prisma.group.findFirst({ where: { brokerId, isDefault: true } });

  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  const account = await provisionAccount({
    brokerId,
    fullName: client.fullName,
    email: client.email,
    passwordHash,
    accountMode: "LIVE",
    accountTypeId: existing.accountTypeId,
    currency: broker.defaultAccountCurrency,
    leverage: defaultGroup?.leverage ?? broker.defaultAccountLeverage,
    groupId: defaultGroup?.id ?? null,
    initialBalance: new Prisma.Decimal(0),
    country: client.country,
    phone: client.phone,
    dateOfBirth: client.dateOfBirth,
    clientId: client.id,
    createdByAdminId: session!.adminId,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.liveAccountRequest.update({
      where: { id },
      data: { status: "APPROVED", reviewedByAdminId: session!.adminId, reviewedAt: new Date(), createdAccountId: account.id },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "LIVE_ACCOUNT_REQUEST_APPROVED",
        entityType: "LiveAccountRequest",
        entityId: id,
        oldValue: { status: "PENDING" },
        newValue: { status: "APPROVED", accountId: account.id, accountNumber: account.accountNumber },
      },
    });
    return r;
  });

  await stashRevealedCredentials(client.id, { accountNumber: account.accountNumber, password });

  const portalLoginUrl = `${brokerPublicOrigin(broker)}/portal/login`;

  const { html, text } = renderBrokerEmail(
    { name: broker.name, logoUrl: broker.logoUrl, primaryColor: broker.primaryColor, supportEmail: broker.supportEmail },
    {
      preheader: `Your ${broker.name} Live account is ready.`,
      heading: "Your Live account is ready",
      bodyLines: [
        `Your Live account request has been approved. Here are your account details:`,
        `Account number: ${account.accountNumber}`,
        `Password: ${password}`,
        `For your security, please log in and change your password as soon as possible.`,
      ],
      cta: { label: "Log in to your account", url: portalLoginUrl },
    }
  );

  await sendBrokerEmail(
    { name: broker.name, emailEnabled: broker.emailEnabled, emailFromAddress: broker.emailFromAddress, emailFromName: broker.emailFromName },
    {
      to: client.email,
      subject: `Your Live account is ready - ${broker.name}`,
      html,
      text,
    }
  );

  return NextResponse.json({ id: updated.id, status: updated.status, accountNumber: account.accountNumber });
}
