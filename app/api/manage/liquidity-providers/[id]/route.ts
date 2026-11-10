import { withConfigEvent } from "@/lib/config-events";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
// owner 2026-11-10: Liquidity providers is a delegatable permission (BROKER_ADMIN, or a MANAGER holding LIQUIDITY_PROVIDERS)
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

const VALID_STATUS = ["PROSPECTIVE", "NEGOTIATING", "CONTRACTED", "CONNECTED"];

async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "LIQUIDITY_PROVIDERS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.liquidityProvider.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const data: { status?: "PROSPECTIVE" | "NEGOTIATING" | "CONTRACTED" | "CONNECTED"; notes?: string | null; name?: string } = {};

  if (body?.status != null) {
    if (!VALID_STATUS.includes(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    data.status = body.status;
  }
  if ("notes" in (body ?? {})) {
    data.notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
  }
  // bo 1.0.101 (owner 2026-11-05): the broker names its liquidity provider as it wants it shown (the row is per broker already)
  if ("name" in (body ?? {})) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "Enter a name for this liquidity provider." }, { status: 400 });
    if (name.length > 80) return NextResponse.json({ error: "The name can be at most 80 characters." }, { status: 400 });
    const clash = await prisma.liquidityProvider.findFirst({ where: { brokerId, name: { equals: name, mode: "insensitive" }, NOT: { id } }, select: { id: true } });
    if (clash) return NextResponse.json({ error: `Another liquidity provider is already called ${name}.` }, { status: 409 });
    data.name = name;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const provider = await tx.liquidityProvider.update({ where: { id }, data });
    // Phase 2 batch 5: a notes edit is audited too (it used to write nothing)
    if (data.notes !== undefined && (data.notes ?? null) !== (existing.notes ?? null)) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "LP_NOTES_CHANGED",
          entityType: "LiquidityProvider",
          entityId: id,
          oldValue: { notes: existing.notes ?? null },
          newValue: { notes: provider.notes ?? null },
        },
      });
    }
    if (data.name !== undefined && data.name !== existing.name) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "LP_NAME_CHANGED",
          entityType: "LiquidityProvider",
          entityId: id,
          oldValue: { name: existing.name },
          newValue: { name: provider.name },
        },
      });
    }
    if (data.status !== undefined) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session!.adminId,
          action: "LP_STATUS_CHANGED",
          entityType: "LiquidityProvider",
          entityId: id,
          oldValue: { status: existing.status },
          newValue: { status: provider.status },
        },
      });
    }
    return provider;
  });

  return NextResponse.json({ id: updated.id, name: updated.name, status: updated.status, notes: updated.notes });
}

// Step 2 (owner 2026-09-30): LP "Delete provider…". BROKER_ADMIN (the same gate as PATCH). Refused (409, with the
// reason) while any routing rule points at the provider -- the owner's rule: never delete the rules with it -- and while
// a bridge connection (LpConnection, A.1.3) belongs to it (its foreign key would refuse the delete as a 500 otherwise).
// The audit row keeps a full snapshot of the provider record.
async function deleteHandler(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "LIQUIDITY_PROVIDERS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LiquidityProvider" WHERE id = ${id} FOR UPDATE`;
    const existing = await tx.liquidityProvider.findUnique({ where: { id } });
    if (!existing || existing.brokerId !== brokerId) return { status: 404 as const, error: "not found" };
    const rules = await tx.lpRoutingRule.count({ where: { liquidityProviderId: id } });
    if (rules > 0) {
      return { status: 409 as const, error: `${rules} routing rule${rules === 1 ? " points" : "s point"} at this provider: delete or move ${rules === 1 ? "it" : "them"} first` };
    }
    const connections = await tx.lpConnection.count({ where: { liquidityProviderId: id } });
    if (connections > 0) {
      return { status: 409 as const, error: `this provider has ${connections === 1 ? "a bridge connection" : `${connections} bridge connections`}: delete ${connections === 1 ? "it" : "them"} first` };
    }
    await tx.liquidityProvider.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "LP_DELETED",
        entityType: "LiquidityProvider",
        entityId: id,
        oldValue: {
          name: existing.name,
          contactName: existing.contactName,
          contactEmail: existing.contactEmail,
          contactPhone: existing.contactPhone,
          protocol: existing.protocol,
          status: existing.status,
          notes: existing.notes,
          createdAt: existing.createdAt.toISOString(),
        },
        newValue: { deleted: true },
      },
    });
    return { status: 200 as const };
  });

  if (result.status !== 200) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ id, deleted: true });
}

// live reference data (owner 2026-10-29): every open backoffice re-reads this list at once
export const PATCH = withConfigEvent("lps", patchHandler);
export const DELETE = withConfigEvent("lps", deleteHandler);
