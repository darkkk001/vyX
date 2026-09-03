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

// Every AccountType for this broker, enabled and disabled -- the Settings
// CRUD page (app/manage/(shell)/settings) shows both with a toggle; the
// Add-account form's own segmented picker filters to `enabled` client-
// side, same "one fetch, two consumers filter differently" shape as
// AccountsManager.tsx already uses for `groups`.
export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const types = await prisma.accountType.findMany({
    where: { brokerId: session.brokerId! },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json(
    types.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      pricingHint: t.pricingHint,
      sortOrder: t.sortOrder,
      isDefault: t.isDefault,
      enabled: t.enabled,
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const description = typeof body?.description === "string" && body.description.trim() ? body.description.trim() : null;
  const pricingHint = typeof body?.pricingHint === "string" && body.pricingHint.trim() ? body.pricingHint.trim() : null;
  const sortOrder = Number.isFinite(Number(body?.sortOrder)) ? Math.trunc(Number(body.sortOrder)) : 0;
  const isDefault = body?.isDefault === true;

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Same "only one default at a time" rule as Group.isDefault --
      // see app/api/manage/groups/route.ts's own POST for the identical
      // pattern.
      if (isDefault) {
        await tx.accountType.updateMany({ where: { brokerId, isDefault: true }, data: { isDefault: false } });
      }
      const type = await tx.accountType.create({
        data: { brokerId, name, description, pricingHint, sortOrder, isDefault },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "ACCOUNT_TYPE_CREATED",
          entityType: "AccountType",
          entityId: type.id,
          newValue: { name, description, pricingHint, sortOrder, isDefault },
        },
      });
      return type;
    });

    return NextResponse.json(
      {
        id: created.id,
        name: created.name,
        description: created.description,
        pricingHint: created.pricingHint,
        sortOrder: created.sortOrder,
        isDefault: created.isDefault,
        enabled: created.enabled,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "an account type with this name already exists" }, { status: 409 });
    }
    throw error;
  }
}
