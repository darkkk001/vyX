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
      spreadMarkup: t.spreadMarkup.toString(),
      commissionPerLot: t.commissionPerLot.toString(),
      swapLong: t.swapLong.toString(),
      swapShort: t.swapShort.toString(),
      swapFree: t.swapFree,
    }))
  );
}

// Storage-only pricing fields (2026-09-05) -- spreadMarkup/commissionPerLot/
// swapLong/swapShort/swapFree are real values a broker sets here and they
// save, but no live fill-time path reads them yet (Group/GroupSymbolConfig
// via lib/group-pricing.ts remains the only thing actually applied to a
// real fill). See AccountType.spreadMarkup's own schema comment for the
// full "config now, enforce later" reasoning. Invalid/missing input on any
// of these silently falls back to 0/false rather than rejecting the
// request -- same tolerant-parse convention every other Decimal field in
// this app's POST routes already uses (e.g. Group's own marginCallLevel).
function parsePricingFields(body: unknown) {
  const b = body as Record<string, unknown> | null;
  const parseDecimal = (v: unknown): Prisma.Decimal => {
    try {
      const d = new Prisma.Decimal(String(v ?? "0"));
      return d.isFinite() ? d : new Prisma.Decimal(0);
    } catch {
      return new Prisma.Decimal(0);
    }
  };
  return {
    spreadMarkup: parseDecimal(b?.spreadMarkup),
    commissionPerLot: parseDecimal(b?.commissionPerLot),
    swapLong: parseDecimal(b?.swapLong),
    swapShort: parseDecimal(b?.swapShort),
    swapFree: b?.swapFree === true,
  };
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
  const pricing = parsePricingFields(body);

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Same "only one default at a time" rule as Group.isDefault --
      // see app/api/manage/groups/route.ts's own POST for the identical
      // pattern.
      if (isDefault) {
        await tx.accountType.updateMany({ where: { brokerId, isDefault: true }, data: { isDefault: false } });
      }
      const type = await tx.accountType.create({
        data: { brokerId, name, description, pricingHint, sortOrder, isDefault, ...pricing },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "ACCOUNT_TYPE_CREATED",
          entityType: "AccountType",
          entityId: type.id,
          newValue: {
            name,
            description,
            pricingHint,
            sortOrder,
            isDefault,
            spreadMarkup: pricing.spreadMarkup.toString(),
            commissionPerLot: pricing.commissionPerLot.toString(),
            swapLong: pricing.swapLong.toString(),
            swapShort: pricing.swapShort.toString(),
            swapFree: pricing.swapFree,
          },
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
        spreadMarkup: created.spreadMarkup.toString(),
        commissionPerLot: created.commissionPerLot.toString(),
        swapLong: created.swapLong.toString(),
        swapShort: created.swapShort.toString(),
        swapFree: created.swapFree,
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
