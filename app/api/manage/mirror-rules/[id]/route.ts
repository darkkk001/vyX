import { NextRequest, NextResponse } from "next/server";
import { Prisma, MirrorFillPriceMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";

const FILL_PRICE_MODES: MirrorFillPriceMode[] = ["SOURCE_PRICE", "MARKET"];

async function requireMirrorManage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "MIRROR_MANAGE")) return null;
  return session!;
}

function ruleStatus(rule: { enabled: boolean; killedAt: Date | null }): "ACTIVE" | "KILLED" | "DISABLED" {
  if (rule.killedAt) return "KILLED";
  return rule.enabled ? "ACTIVE" : "DISABLED";
}

// Rule detail: open mirrored positions (source <-> target, lots, P/L both
// sides), net strategy P/L, recent MIRROR_FAILED log -- see the brief's
// own "Rule detail" spec. Net strategy P/L is scoped to THIS rule's own
// mirrored positions specifically (realized, from linked CLOSED targets,
// plus floating on linked OPEN ones) -- not the whole target account,
// since a master account could in principle carry non-mirrored trades too.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireMirrorManage();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const rule = await prisma.mirrorRule.findFirst({
    where: { id, brokerId: session.brokerId! },
    include: { createdBy: { select: { email: true } } },
  });
  if (!rule) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [source, targetAccount, links, failures] = await Promise.all([
    rule.sourceType === "GROUP"
      ? prisma.group.findUnique({ where: { id: rule.sourceId }, select: { name: true } })
      : prisma.account.findUnique({ where: { id: rule.sourceId }, select: { accountNumber: true, fullName: true } }),
    prisma.account.findUnique({ where: { id: rule.targetAccountId }, select: { accountNumber: true, fullName: true } }),
    prisma.mirrorLink.findMany({ where: { ruleId: rule.id }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.auditLog.findMany({
      where: { brokerId: session.brokerId!, action: "MIRROR_FAILED", entityType: "MirrorRule", entityId: rule.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const sourcePositionIds = links.map((l) => l.sourcePositionId);
  const targetPositionIds = links.map((l) => l.targetPositionId);
  const [sourcePositions, targetPositions] = await Promise.all([
    prisma.position.findMany({
      where: { id: { in: sourcePositionIds } },
      include: { symbol: { select: { name: true, digits: true, contractSize: true } } },
    }),
    prisma.position.findMany({
      where: { id: { in: targetPositionIds } },
      include: { symbol: { select: { name: true, digits: true, contractSize: true } } },
    }),
  ]);
  const sourceById = new Map(sourcePositions.map((p) => [p.id, p]));
  const targetById = new Map(targetPositions.map((p) => [p.id, p]));

  const allSymbolNames = new Set<string>([...sourcePositions, ...targetPositions].map((p) => p.symbol.name));
  const priceBySymbol = await getFreshPrices([...allSymbolNames]);

  const pnlFor = (p: (typeof sourcePositions)[number]): Prisma.Decimal | null => {
    if (p.status === "CLOSED") return p.realizedPnl ?? new Prisma.Decimal(0);
    const live = priceBySymbol.get(p.symbol.name);
    if (!live) return null;
    const cp = p.side === "BUY" ? live.bid : live.ask;
    return computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.symbol.contractSize });
  };

  let netStrategyPnl = new Prisma.Decimal(0);
  let netStrategyPnlKnown = true;
  const positionRows = links.map((link) => {
    const s = sourceById.get(link.sourcePositionId);
    const t = targetById.get(link.targetPositionId);
    const targetPnl = t ? pnlFor(t) : null;
    if (targetPnl == null) netStrategyPnlKnown = false;
    else netStrategyPnl = netStrategyPnl.add(targetPnl);
    return {
      sourcePositionId: link.sourcePositionId,
      targetPositionId: link.targetPositionId,
      symbol: s?.symbol.name ?? t?.symbol.name ?? null,
      sourceSide: s?.side ?? null,
      sourceVolume: s ? s.volume.toString() : null,
      sourceStatus: s?.status ?? null,
      sourcePnl: s ? (pnlFor(s)?.toString() ?? null) : null,
      targetSide: t?.side ?? null,
      targetVolume: t ? t.volume.toString() : null,
      targetStatus: t?.status ?? null,
      targetPnl: targetPnl ? targetPnl.toString() : null,
    };
  });

  return NextResponse.json({
    rule: {
      id: rule.id,
      sourceType: rule.sourceType,
      sourceLabel: rule.sourceType === "GROUP" ? (source as { name: string } | null)?.name ?? "(deleted group)" : source ? `${(source as { accountNumber: string; fullName: string }).accountNumber}, ${(source as { accountNumber: string; fullName: string }).fullName}` : "(deleted account)",
      targetAccountLabel: targetAccount ? `${targetAccount.accountNumber}, ${targetAccount.fullName}` : "(deleted account)",
      direction: rule.direction,
      multiplier: rule.multiplier.toString(),
      fillPriceMode: rule.fillPriceMode,
      symbolFilter: rule.symbolFilter,
      maxOpenLots: rule.maxOpenLots ? rule.maxOpenLots.toString() : null,
      maxDailyLoss: rule.maxDailyLoss ? rule.maxDailyLoss.toString() : null,
      enabled: rule.enabled,
      killedAt: rule.killedAt ? rule.killedAt.toISOString() : null,
      status: ruleStatus(rule),
      failureCount: rule.failureCount,
      createdByEmail: rule.createdBy.email,
      createdAt: rule.createdAt.toISOString(),
    },
    positions: positionRows,
    netStrategyPnl: netStrategyPnlKnown ? netStrategyPnl.toString() : null,
    recentFailures: failures.map((f) => ({
      createdAt: f.createdAt.toISOString(),
      reason: (f.newValue as { reason?: string } | null)?.reason ?? null,
    })),
  });
}

// Edit fields, toggle enabled, or manually reset a triggered kill switch
// (enabled: true while killedAt is set clears killedAt too -- an explicit
// admin re-enable, not something that happens on its own). Maker-checker
// NOT required for v0 (the brief's own explicit call); every change is
// still audited.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireMirrorManage();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const existing = await prisma.mirrorRule.findFirst({ where: { id, brokerId: session.brokerId! } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const data: Prisma.MirrorRuleUpdateInput = {};
  const oldValue: Record<string, Prisma.InputJsonValue | null> = {};
  const newValue: Record<string, Prisma.InputJsonValue | null> = {};

  if (typeof body.enabled === "boolean") {
    data.enabled = body.enabled;
    oldValue.enabled = existing.enabled;
    newValue.enabled = body.enabled;
    if (body.enabled && existing.killedAt) {
      data.killedAt = null; // manual re-enable clears a triggered kill switch
      oldValue.killedAt = existing.killedAt.toISOString();
      newValue.killedAt = null;
    }
  }
  if (body.multiplier != null) {
    let multiplier: Prisma.Decimal;
    try {
      multiplier = new Prisma.Decimal(String(body.multiplier));
    } catch {
      return NextResponse.json({ error: "invalid multiplier" }, { status: 400 });
    }
    if (multiplier.lte(0)) return NextResponse.json({ error: "multiplier must be greater than 0" }, { status: 400 });
    data.multiplier = multiplier;
    oldValue.multiplier = existing.multiplier.toString();
    newValue.multiplier = multiplier.toString();
  }
  if (typeof body.fillPriceMode === "string") {
    if (!FILL_PRICE_MODES.includes(body.fillPriceMode as MirrorFillPriceMode)) {
      return NextResponse.json({ error: "invalid fillPriceMode" }, { status: 400 });
    }
    const fillPriceMode = body.fillPriceMode as MirrorFillPriceMode;
    data.fillPriceMode = fillPriceMode;
    oldValue.fillPriceMode = existing.fillPriceMode;
    newValue.fillPriceMode = fillPriceMode;
  }
  if ("symbolFilter" in body) {
    const raw = typeof body.symbolFilter === "string" ? body.symbolFilter.trim() : "";
    const symbolFilter = raw ? raw.split(",").map((s: string) => s.trim().toUpperCase()).filter(Boolean).join(",") : null;
    data.symbolFilter = symbolFilter;
    oldValue.symbolFilter = existing.symbolFilter;
    newValue.symbolFilter = symbolFilter;
  }
  for (const field of ["maxOpenLots", "maxDailyLoss"] as const) {
    if (field in body) {
      const v = body[field];
      if (v == null || v === "") {
        data[field] = null;
        oldValue[field] = existing[field] ? existing[field]!.toString() : null;
        newValue[field] = null;
      } else {
        let d: Prisma.Decimal;
        try {
          d = new Prisma.Decimal(String(v));
        } catch {
          return NextResponse.json({ error: `invalid ${field}` }, { status: 400 });
        }
        if (d.lte(0)) return NextResponse.json({ error: `${field} must be greater than 0` }, { status: 400 });
        data[field] = d;
        oldValue[field] = existing[field] ? existing[field]!.toString() : null;
        newValue[field] = d.toString();
      }
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no recognized fields to update" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.mirrorRule.update({ where: { id }, data });
    await tx.auditLog.create({
      data: {
        brokerId: session.brokerId!,
        actorAdminId: session.adminId,
        action: "MIRROR_RULE_UPDATED",
        entityType: "MirrorRule",
        entityId: id,
        oldValue,
        newValue,
      },
    });
    return u;
  });

  return NextResponse.json({ id: updated.id, status: ruleStatus(updated) });
}
