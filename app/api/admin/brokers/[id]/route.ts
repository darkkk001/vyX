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
  const hasSupportEmail = "supportEmail" in (body ?? {});
  const supportEmail = hasSupportEmail ? (typeof body.supportEmail === "string" && body.supportEmail.trim() ? body.supportEmail.trim() : null) : undefined;
  if (!executionEngine && !status && !hasSupportEmail) {
    return NextResponse.json({ error: "executionEngine, status, or supportEmail is required" }, { status: 400 });
  }

  const existing = await prisma.broker.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
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

    return tx.broker.findUniqueOrThrow({ where: { id } });
  });

  return NextResponse.json({
    id: updated.id,
    supportEmail: updated.supportEmail,
    executionEngine: updated.executionEngine,
    status: updated.status,
    trialEndsAt: updated.trialEndsAt,
    nextInvoiceAt: updated.nextInvoiceAt,
  });
}
