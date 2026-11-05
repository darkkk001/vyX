import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withConfigEvent } from "@/lib/config-events";
import { HMR_CURRENCIES, resetHmrCache, seedHmrCorrelations } from "@/lib/hmr";
import { forbidden, requireHmrAdmin, windowDto } from "@/lib/hmr-admin";

// HMR plugin (owner spec 2026-11-06, C4): GET the plugin state (switch, windows, per-currency symbol lists), PUT { enabled } to
// switch it on or off. Off by default; every change audited. BROKER_ADMIN only.
export async function GET() {
  const session = await requireHmrAdmin();
  if (!session) return forbidden();
  const brokerId = session.brokerId!;
  const [broker, windows, correlations] = await Promise.all([
    prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { hmrEnabled: true } }),
    prisma.hmrWindow.findMany({ where: { brokerId }, orderBy: [{ startsAt: "desc" }, { id: "asc" }] }),
    prisma.hmrCorrelation.findMany({ where: { brokerId }, orderBy: { currency: "asc" } }),
  ]);
  return NextResponse.json({
    enabled: broker.hmrEnabled,
    currencies: HMR_CURRENCIES,
    windows: windows.map(windowDto),
    correlations: Object.fromEntries(correlations.map((c) => [c.currency, c.symbols])),
  });
}

async function putHandler(request: NextRequest) {
  const session = await requireHmrAdmin();
  if (!session) return forbidden();
  const brokerId = session.brokerId!;
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
  const enabled: boolean = body.enabled;
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { hmrEnabled: true } });
    if (before.hmrEnabled === enabled) return { changed: false };
    await tx.broker.update({ where: { id: brokerId }, data: { hmrEnabled: enabled } });
    // the default symbol map (C2) is seeded from the broker's enabled symbols the first time the plugin is switched on
    if (enabled) await seedHmrCorrelations(tx, brokerId);
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session.adminId, action: enabled ? "HMR_ENABLED" : "HMR_DISABLED", entityType: "Broker", entityId: brokerId, oldValue: { hmrEnabled: before.hmrEnabled }, newValue: { hmrEnabled: enabled } },
    });
    return { changed: true };
  });
  resetHmrCache(brokerId);
  return NextResponse.json({ enabled, changed: result.changed });
}

export const PUT = withConfigEvent("settings", putHandler);
