import { NextRequest, NextResponse } from "next/server";
import { loadSellAskRules, valuationAsk } from "@/lib/ask-markup";
import { withConfigEvent } from "@/lib/config-events";
import { Prisma, MirrorFillPriceMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { loadRateResolver } from "@/lib/fx";

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
      include: { symbol: { select: { name: true, digits: true, contractSize: true, quoteCurrency: true } }, account: { select: { currency: true } } },
    }),
    prisma.position.findMany({
      where: { id: { in: targetPositionIds } },
      include: { symbol: { select: { name: true, digits: true, contractSize: true, quoteCurrency: true } }, account: { select: { currency: true } } },
    }),
  ]);
  const sourceById = new Map(sourcePositions.map((p) => [p.id, p]));
  const targetById = new Map(targetPositions.map((p) => [p.id, p]));

  const allSymbolNames = new Set<string>([...sourcePositions, ...targetPositions].map((p) => p.symbol.name));
  const priceBySymbol = await getFreshPrices([...allSymbolNames]);
  // FX (Phase 2 batch 1): an open position's P/L converted to its account's currency (realizedPnl already is)
  const fx = await loadRateResolver(prisma, [...sourcePositions, ...targetPositions].map((p) => [p.symbol.quoteCurrency, p.account.currency] as const));
  // an open SELL is valued at its account's ask (lib/ask-markup.ts)
  const askRules = await loadSellAskRules(prisma, [...sourcePositions, ...targetPositions].filter((p) => p.status === "OPEN"));

  const pnlFor = (p: (typeof sourcePositions)[number]): Prisma.Decimal | null => {
    if (p.status === "CLOSED") return p.realizedPnl ?? new Prisma.Decimal(0);
    const live = priceBySymbol.get(p.symbol.name);
    if (!live) return null;
    const cp = p.side === "BUY" ? live.bid : valuationAsk(askRules, p, live.bid, live.ask);
    const rate = fx.rate(p.symbol.quoteCurrency, p.account.currency);
    if (!rate) return null; // unpriced
    return computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.symbol.contractSize }).mul(rate);
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
async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  // web5 (issues.md 191, owner 2026-09-30): the direction can be changed after creation. Refused (409) while any
  // position this rule copied is still open on either side -- those copies were opened for the OLD direction and a
  // close would mirror against the new one. Checked again under a row lock inside the write below.
  let directionChanged = false;
  if ("direction" in body) {
    if (body.direction !== "REVERSE" && body.direction !== "SAME") {
      return NextResponse.json({ error: "direction must be REVERSE or SAME" }, { status: 400 });
    }
    if (body.direction !== existing.direction) {
      directionChanged = true;
      data.direction = body.direction;
      oldValue.direction = existing.direction;
      newValue.direction = body.direction;
    }
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

  let openCopies = 0;
  const updated = await prisma.$transaction(async (tx) => {
    if (directionChanged) {
      await tx.$queryRaw`SELECT id FROM "MirrorRule" WHERE id = ${id} FOR UPDATE`;
      const links = await tx.mirrorLink.findMany({ where: { ruleId: id }, select: { sourcePositionId: true, targetPositionId: true } });
      const ids = links.flatMap((l) => [l.sourcePositionId, l.targetPositionId]);
      openCopies = ids.length ? await tx.position.count({ where: { id: { in: ids }, status: "OPEN" } }) : 0;
      if (openCopies > 0) return null;
    }
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

  if (!updated) {
    return NextResponse.json(
      { error: `${openCopies} copied position${openCopies === 1 ? " is" : "s are"} still open: disable the rule and close ${openCopies === 1 ? "it" : "them"} before changing the direction` },
      { status: 409 }
    );
  }
  return NextResponse.json({ id: updated.id, status: ruleStatus(updated), direction: updated.direction });
}

// Batch 5 (real-time): a successful write announces the change to every open client (lib/config-events.ts)
export const PATCH = withConfigEvent("mirror", patchHandler);

// Step 2 (owner 2026-09-30): MIR "Delete copy rule…". Only a rule that is not copying (DISABLED, or stopped by a limit)
// and none of whose copies is still live: every link's source AND copied position must be closed, else 409 with the
// reason. The rule and its links go; every position stays (trades are never deleted). The audit row keeps a full
// snapshot of the rule and every source -> copy pair, so the history is not lost. Row-locked, so a concurrent
// re-enable or a new copy cannot slip in between the check and the delete.
async function deleteHandler(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireMirrorManage();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const brokerId = session.brokerId!;

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "MirrorRule" WHERE id = ${id} FOR UPDATE`;
    const rule = await tx.mirrorRule.findFirst({ where: { id, brokerId } });
    if (!rule) return { status: 404 as const, error: "not found" };
    if (ruleStatus(rule) === "ACTIVE") return { status: 409 as const, error: "disable the copy rule before deleting it" };
    const links = await tx.mirrorLink.findMany({ where: { ruleId: id }, select: { sourcePositionId: true, targetPositionId: true } });
    const positionIds = links.flatMap((l) => [l.sourcePositionId, l.targetPositionId]);
    const open = positionIds.length ? await tx.position.count({ where: { id: { in: positionIds }, status: "OPEN" } }) : 0;
    if (open > 0) {
      return { status: 409 as const, error: `${open} copied position${open === 1 ? " is" : "s are"} still open: close ${open === 1 ? "it" : "them"} before deleting the rule` };
    }
    await tx.mirrorLink.deleteMany({ where: { ruleId: id } });
    await tx.mirrorRule.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MIRROR_RULE_DELETED",
        entityType: "MirrorRule",
        entityId: id,
        oldValue: {
          sourceType: rule.sourceType,
          sourceId: rule.sourceId,
          targetAccountId: rule.targetAccountId,
          direction: rule.direction,
          multiplier: rule.multiplier.toString(),
          fillPriceMode: rule.fillPriceMode,
          symbolFilter: rule.symbolFilter,
          maxOpenLots: rule.maxOpenLots?.toString() ?? null,
          maxDailyLoss: rule.maxDailyLoss?.toString() ?? null,
          status: ruleStatus(rule),
          createdAt: rule.createdAt.toISOString(),
          links,
        },
        newValue: { deleted: true, linksRemoved: links.length },
      },
    });
    return { status: 200 as const, linksRemoved: links.length };
  });

  if (result.status !== 200) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ id, deleted: true, linksRemoved: result.linksRemoved });
}

export const DELETE = withConfigEvent("mirror", deleteHandler);
