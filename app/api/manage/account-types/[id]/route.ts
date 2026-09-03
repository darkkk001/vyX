import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const existing = await prisma.accountType.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "account type not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const description = typeof body?.description === "string" && body.description.trim() ? body.description.trim() : null;
  const pricingHint = typeof body?.pricingHint === "string" && body.pricingHint.trim() ? body.pricingHint.trim() : null;
  const sortOrder = Number.isFinite(Number(body?.sortOrder)) ? Math.trunc(Number(body.sortOrder)) : 0;
  const isDefault = body?.isDefault === true;
  // enabled is always independently toggleable -- see AccountType.enabled's
  // own schema comment for why disabling is never blocked by existing
  // Account references (only a hard delete would need that guard, and
  // there is no delete route). Not present in the body = leave as-is,
  // matching a PATCH's own partial-update convention rather than forcing
  // every caller to always resend it.
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : existing.enabled;

  // A broker must always have exactly one default (app/api/manage/
  // accounts/route.ts's own account-creation fallback depends on it
  // existing) -- reject unsetting the only default in place rather than
  // silently leaving zero, which would only surface much later as a
  // confusing "no default account type" failure on account creation.
  if (existing.isDefault && !isDefault) {
    const otherDefault = await prisma.accountType.findFirst({ where: { brokerId, isDefault: true, id: { not: id } } });
    if (!otherDefault) {
      return NextResponse.json({ error: "make another type the default first -- a broker always needs exactly one" }, { status: 400 });
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (isDefault && !existing.isDefault) {
        await tx.accountType.updateMany({ where: { brokerId, isDefault: true }, data: { isDefault: false } });
      }
      const type = await tx.accountType.update({
        where: { id },
        data: { name, description, pricingHint, sortOrder, isDefault, enabled },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "ACCOUNT_TYPE_UPDATED",
          entityType: "AccountType",
          entityId: id,
          oldValue: {
            name: existing.name,
            description: existing.description,
            pricingHint: existing.pricingHint,
            sortOrder: existing.sortOrder,
            isDefault: existing.isDefault,
            enabled: existing.enabled,
          },
          newValue: { name, description, pricingHint, sortOrder, isDefault, enabled },
        },
      });
      return type;
    });

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      pricingHint: updated.pricingHint,
      sortOrder: updated.sortOrder,
      isDefault: updated.isDefault,
      enabled: updated.enabled,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "an account type with this name already exists" }, { status: 409 });
    }
    throw error;
  }
}
