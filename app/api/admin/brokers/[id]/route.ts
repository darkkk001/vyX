import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

const VALID_STATUSES = new Set(["TRIAL", "ACTIVE", "SUSPENDED", "DISABLED"]);
const TRIAL_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;
const INVOICE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

// Only SUPER_ADMIN may change a broker's execution engine or lifecycle
// status -- both are platform-level settings, not something a broker's
// own BROKER_ADMIN should control. executionEngine: setting this to RUST
// does NOT currently change any trading behavior -- see ExecutionEngine's
// schema comment / ADR-003. status: TRIAL/ACTIVE/SUSPENDED/DISABLED are
// config-only lifecycle states (see BrokerStatus's schema comment) -- no
// payment processor is involved, this just gates nothing yet either
// (existing app/api/trade/* routes don't check Broker.status at all).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const executionEngine = body?.executionEngine === "LEGACY" || body?.executionEngine === "RUST" ? body.executionEngine : null;
  const status = typeof body?.status === "string" && VALID_STATUSES.has(body.status) ? body.status : null;
  // Branding -- undefined (key absent) means "leave unchanged"; an empty
  // string means "clear it" (e.g. revoking a support email), distinct
  // from not touching the field at all. Explicit `in` checks rather than
  // `typeof === "string"` so an intentional `null`/"" clear isn't
  // silently ignored.
  // Presence check, not truthy -- `false` is a real, meaningful value here
  // (turn the pricing engine back off), not "field absent." See
  // Broker.pricingEngineEnabled's own schema comment: per-broker, only
  // ever flipped after that broker's shadow comparison
  // (lib/pricing-shadow-compare.ts) has been reviewed clean.
  const hasPricingEngineEnabled = "pricingEngineEnabled" in (body ?? {});
  const pricingEngineEnabled = hasPricingEngineEnabled ? body.pricingEngineEnabled === true : undefined;
  const hasSupportEmail = "supportEmail" in (body ?? {});
  const supportEmail = hasSupportEmail ? (typeof body.supportEmail === "string" && body.supportEmail.trim() ? body.supportEmail.trim() : null) : undefined;
  const hasLogoUrl = "logoUrl" in (body ?? {});
  const logoUrl = hasLogoUrl ? (typeof body.logoUrl === "string" && body.logoUrl.trim() ? body.logoUrl.trim() : null) : undefined;
  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const hasPrimaryColor = "primaryColor" in (body ?? {});
  if (hasPrimaryColor && typeof body.primaryColor === "string" && body.primaryColor.trim() && !HEX_COLOR_RE.test(body.primaryColor.trim())) {
    return NextResponse.json({ error: "primaryColor must be a 6-digit hex color like #1e8a5f" }, { status: 400 });
  }
  const primaryColor = hasPrimaryColor ? (typeof body.primaryColor === "string" && body.primaryColor.trim() ? body.primaryColor.trim() : null) : undefined;

  // Transactional email config -- see lib/email/adapter.ts's
  // sendBrokerEmail. All four saved together from one form (BrokersManager's
  // "Transactional email" section) rather than per-field like support
  // email/logo/color above, since emailEnabled=true is only meaningful
  // alongside an emailFromAddress.
  const hasEmailFromDomain = "emailFromDomain" in (body ?? {});
  const emailFromDomain = hasEmailFromDomain ? (typeof body.emailFromDomain === "string" && body.emailFromDomain.trim() ? body.emailFromDomain.trim().toLowerCase() : null) : undefined;
  const hasEmailFromAddress = "emailFromAddress" in (body ?? {});
  const emailFromAddress = hasEmailFromAddress ? (typeof body.emailFromAddress === "string" && body.emailFromAddress.trim() ? body.emailFromAddress.trim().toLowerCase() : null) : undefined;
  const hasEmailFromName = "emailFromName" in (body ?? {});
  const emailFromName = hasEmailFromName ? (typeof body.emailFromName === "string" && body.emailFromName.trim() ? body.emailFromName.trim() : null) : undefined;
  const hasEmailEnabled = "emailEnabled" in (body ?? {});
  const emailEnabled = hasEmailEnabled ? body.emailEnabled === true : undefined;

  if (!executionEngine && !status && !hasPricingEngineEnabled && !hasSupportEmail && !hasLogoUrl && !hasPrimaryColor && !hasEmailFromDomain && !hasEmailFromAddress && !hasEmailFromName && !hasEmailEnabled) {
    return NextResponse.json({ error: "executionEngine, status, pricingEngineEnabled, supportEmail, logoUrl, primaryColor, or an email config field is required" }, { status: 400 });
  }

  const existing = await prisma.broker.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  // emailEnabled can only ever turn on a real send if there's a From
  // address to send from -- check the resulting value (either freshly
  // set in this request, or already on the row) rather than just what
  // this request happens to include.
  const resultingEmailFromAddress = hasEmailFromAddress ? emailFromAddress : existing.emailFromAddress;
  if (emailEnabled === true && !resultingEmailFromAddress) {
    return NextResponse.json({ error: "set emailFromAddress before enabling email sending" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data: {
      executionEngine?: "LEGACY" | "RUST";
      status?: "TRIAL" | "ACTIVE" | "SUSPENDED" | "DISABLED";
      trialEndsAt?: Date | null;
      nextInvoiceAt?: Date | null;
    } = {};

    if (executionEngine) {
      data.executionEngine = executionEngine;
      const broker = await tx.broker.update({ where: { id }, data: { executionEngine } });
      await tx.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_EXECUTION_ENGINE_CHANGED",
          entityType: "Broker",
          entityId: id,
          oldValue: { executionEngine: existing.executionEngine },
          newValue: { executionEngine: broker.executionEngine },
        },
      });
    }

    if (status) {
      if (status === "TRIAL") {
        data.trialEndsAt = new Date(Date.now() + TRIAL_PERIOD_MS);
        data.nextInvoiceAt = null;
      } else if (status === "ACTIVE") {
        data.nextInvoiceAt = new Date(Date.now() + INVOICE_PERIOD_MS);
      } else {
        data.trialEndsAt = null;
        data.nextInvoiceAt = null;
      }
      const broker = await tx.broker.update({ where: { id }, data: { status, trialEndsAt: data.trialEndsAt, nextInvoiceAt: data.nextInvoiceAt } });
      await tx.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_STATUS_CHANGED",
          entityType: "Broker",
          entityId: id,
          oldValue: { status: existing.status },
          newValue: { status: broker.status },
        },
      });
    }

    if (hasPricingEngineEnabled) {
      const broker = await tx.broker.update({ where: { id }, data: { pricingEngineEnabled } });
      await tx.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_PRICING_ENGINE_TOGGLED",
          entityType: "Broker",
          entityId: id,
          oldValue: { pricingEngineEnabled: existing.pricingEngineEnabled },
          newValue: { pricingEngineEnabled: broker.pricingEngineEnabled },
        },
      });
    }

    if (hasSupportEmail) {
      const broker = await tx.broker.update({ where: { id }, data: { supportEmail } });
      await tx.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_SUPPORT_EMAIL_CHANGED",
          entityType: "Broker",
          entityId: id,
          oldValue: { supportEmail: existing.supportEmail },
          newValue: { supportEmail: broker.supportEmail },
        },
      });
    }

    if (hasLogoUrl) {
      const broker = await tx.broker.update({ where: { id }, data: { logoUrl } });
      await tx.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_LOGO_CHANGED",
          entityType: "Broker",
          entityId: id,
          oldValue: { logoUrl: existing.logoUrl },
          newValue: { logoUrl: broker.logoUrl },
        },
      });
    }

    if (hasPrimaryColor) {
      const broker = await tx.broker.update({ where: { id }, data: { primaryColor } });
      await tx.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_PRIMARY_COLOR_CHANGED",
          entityType: "Broker",
          entityId: id,
          oldValue: { primaryColor: existing.primaryColor },
          newValue: { primaryColor: broker.primaryColor },
        },
      });
    }

    if (hasEmailFromDomain || hasEmailFromAddress || hasEmailFromName || hasEmailEnabled) {
      const broker = await tx.broker.update({
        where: { id },
        data: {
          ...(hasEmailFromDomain ? { emailFromDomain } : {}),
          ...(hasEmailFromAddress ? { emailFromAddress } : {}),
          ...(hasEmailFromName ? { emailFromName } : {}),
          ...(hasEmailEnabled ? { emailEnabled } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_EMAIL_CONFIG_CHANGED",
          entityType: "Broker",
          entityId: id,
          oldValue: { emailFromDomain: existing.emailFromDomain, emailFromAddress: existing.emailFromAddress, emailFromName: existing.emailFromName, emailEnabled: existing.emailEnabled },
          newValue: { emailFromDomain: broker.emailFromDomain, emailFromAddress: broker.emailFromAddress, emailFromName: broker.emailFromName, emailEnabled: broker.emailEnabled },
        },
      });
    }

    return tx.broker.findUniqueOrThrow({ where: { id } });
  });

  return NextResponse.json({
    id: updated.id,
    supportEmail: updated.supportEmail,
    logoUrl: updated.logoUrl,
    primaryColor: updated.primaryColor,
    executionEngine: updated.executionEngine,
    pricingEngineEnabled: updated.pricingEngineEnabled,
    status: updated.status,
    trialEndsAt: updated.trialEndsAt,
    nextInvoiceAt: updated.nextInvoiceAt,
    emailFromDomain: updated.emailFromDomain,
    emailFromAddress: updated.emailFromAddress,
    emailFromName: updated.emailFromName,
    emailEnabled: updated.emailEnabled,
  });
}
