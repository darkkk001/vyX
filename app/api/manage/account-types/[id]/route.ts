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

// Same "config now, enforce later" reasoning as account-types/route.ts's
// own POST. A field entirely ABSENT from the body keeps `existing`'s
// value (this PATCH's own `enabled` already works this way, a couple
// lines below) -- toggleTypeEnabled/makeTypeDefault in SettingsManager.tsx
// only ever resend name/description/pricingHint/sortOrder/isDefault/
// enabled, never the pricing fields, so without this fallback either of
// those two actions would silently zero out a type's saved pricing every
// time. A field that IS present but unparseable falls back to 0 rather
// than silently keeping the old value, since that's a real (if bad) input
// the admin just typed, not an unrelated action that never touched pricing.
// `existing`'s fields are typed `| null` since the 2026-09-07 migration
// pricing_engine_nullable_widening made these columns nullable -- this
// route itself never causes that (it always resolves to a concrete
// Decimal/boolean below, same as before), so the `?? 0`/`?? false` on the
// existing-value fallback is a no-op for every row today. Not "inherit"
// semantics -- that's the Phase 2 pricing engine's job (lib/pricing-
// engine.ts), this route still only ever stores flat literal values.
function parsePricingFields(
  body: unknown,
  existing: { spreadMarkup: Prisma.Decimal | null; commissionPerLot: Prisma.Decimal | null; swapLong: Prisma.Decimal | null; swapShort: Prisma.Decimal | null; swapFree: boolean | null }
) {
  const b = body as Record<string, unknown> | null;
  const parseDecimal = (v: unknown, fallback: Prisma.Decimal): Prisma.Decimal => {
    if (v === undefined) return fallback;
    try {
      const d = new Prisma.Decimal(String(v));
      return d.isFinite() ? d : new Prisma.Decimal(0);
    } catch {
      return new Prisma.Decimal(0);
    }
  };
  return {
    spreadMarkup: parseDecimal(b?.spreadMarkup, existing.spreadMarkup ?? new Prisma.Decimal(0)),
    commissionPerLot: parseDecimal(b?.commissionPerLot, existing.commissionPerLot ?? new Prisma.Decimal(0)),
    swapLong: parseDecimal(b?.swapLong, existing.swapLong ?? new Prisma.Decimal(0)),
    swapShort: parseDecimal(b?.swapShort, existing.swapShort ?? new Prisma.Decimal(0)),
    swapFree: typeof b?.swapFree === "boolean" ? b.swapFree : (existing.swapFree ?? false),
  };
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
  const pricing = parsePricingFields(body, existing);

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
        data: { name, description, pricingHint, sortOrder, isDefault, enabled, ...pricing },
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
            spreadMarkup: existing.spreadMarkup?.toString() ?? "0",
            commissionPerLot: existing.commissionPerLot?.toString() ?? "0",
            swapLong: existing.swapLong?.toString() ?? "0",
            swapShort: existing.swapShort?.toString() ?? "0",
            swapFree: existing.swapFree ?? false,
          },
          newValue: {
            name,
            description,
            pricingHint,
            sortOrder,
            isDefault,
            enabled,
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

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      pricingHint: updated.pricingHint,
      sortOrder: updated.sortOrder,
      isDefault: updated.isDefault,
      enabled: updated.enabled,
      spreadMarkup: updated.spreadMarkup?.toString() ?? "0",
      commissionPerLot: updated.commissionPerLot?.toString() ?? "0",
      swapLong: updated.swapLong?.toString() ?? "0",
      swapShort: updated.swapShort?.toString() ?? "0",
      swapFree: updated.swapFree ?? false,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "an account type with this name already exists" }, { status: 409 });
    }
    throw error;
  }
}
