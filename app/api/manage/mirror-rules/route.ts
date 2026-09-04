import { NextRequest, NextResponse } from "next/server";
import { Prisma, MirrorFillPriceMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

const FILL_PRICE_MODES: MirrorFillPriceMode[] = ["SOURCE_PRICE", "MARKET"];

// docs/briefs/VYX-MIRROR-V0-BRIEF.md -- "RBAC: dealing.manage roles only."
// MIRROR_MANAGE is a delegatable permission (lib/permission-labels.ts),
// same shape as RISK_SETTINGS/EMERGENCY_CONTROLS -- BROKER_ADMIN always
// has it implicitly, a MANAGER needs it delegated.
async function requireMirrorManage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "MIRROR_MANAGE")) return null;
  return session!;
}

function ruleStatus(rule: { enabled: boolean; killedAt: Date | null }): "ACTIVE" | "KILLED" | "DISABLED" {
  if (rule.killedAt) return "KILLED";
  return rule.enabled ? "ACTIVE" : "DISABLED";
}

async function serializeRule(rule: {
  id: string;
  sourceType: string;
  sourceId: string;
  targetAccountId: string;
  direction: string;
  multiplier: Prisma.Decimal;
  fillPriceMode: string;
  symbolFilter: string | null;
  maxOpenLots: Prisma.Decimal | null;
  maxDailyLoss: Prisma.Decimal | null;
  enabled: boolean;
  killedAt: Date | null;
  failureCount: number;
  createdAt: Date;
  createdBy: { email: string };
}, groupsById: Map<string, string>, accountsById: Map<string, { accountNumber: string; fullName: string }>) {
  const sourceLabel =
    rule.sourceType === "GROUP"
      ? (groupsById.get(rule.sourceId) ?? "(deleted group)")
      : (() => {
          const a = accountsById.get(rule.sourceId);
          return a ? `${a.accountNumber}, ${a.fullName}` : "(deleted account)";
        })();
  const target = accountsById.get(rule.targetAccountId);

  return {
    id: rule.id,
    sourceType: rule.sourceType,
    sourceId: rule.sourceId,
    sourceLabel,
    targetAccountId: rule.targetAccountId,
    targetAccountLabel: target ? `${target.accountNumber}, ${target.fullName}` : "(deleted account)",
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
  };
}

// Rules table + the group/account pickers the create dialog needs, in one
// response (same "one round trip for a whole page" convention every other
// self-fetching Manager page in this app already uses).
export async function GET() {
  const session = await requireMirrorManage();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId!;

  const [rules, groups, accounts] = await Promise.all([
    prisma.mirrorRule.findMany({
      where: { brokerId },
      include: { createdBy: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.group.findMany({ where: { brokerId }, select: { id: true, name: true } }),
    prisma.account.findMany({ where: { brokerId }, select: { id: true, accountNumber: true, fullName: true, kycRecord: { select: { id: true } } } }),
  ]);

  const groupsById = new Map(groups.map((g) => [g.id, g.name]));
  const accountsById = new Map(accounts.map((a) => [a.id, { accountNumber: a.accountNumber, fullName: a.fullName }]));

  return NextResponse.json({
    rows: await Promise.all(rules.map((r) => serializeRule(r, groupsById, accountsById))),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    // hasKyc is the create dialog's "recommend a dedicated master" signal
    // (the brief's own wording) -- this schema has no dedicated "master
    // account" flag, so a real KYC record is the closest available proxy
    // for "this looks like a genuine client account," not a hard rule.
    accounts: accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName, hasKyc: !!a.kycRecord })),
  });
}

export async function POST(request: NextRequest) {
  const session = await requireMirrorManage();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const sourceType = body?.sourceType === "GROUP" || body?.sourceType === "ACCOUNT" ? body.sourceType : null;
  const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
  const targetAccountId = typeof body?.targetAccountId === "string" ? body.targetAccountId.trim() : "";
  const direction = body?.direction === "SAME" ? "SAME" : "REVERSE";
  const fillPriceMode = FILL_PRICE_MODES.includes(body?.fillPriceMode) ? (body.fillPriceMode as MirrorFillPriceMode) : "SOURCE_PRICE";
  if (!sourceType || !sourceId || !targetAccountId) {
    return NextResponse.json({ error: "sourceType, sourceId, and targetAccountId are required" }, { status: 400 });
  }

  let multiplier: Prisma.Decimal;
  try {
    multiplier = new Prisma.Decimal(String(body?.multiplier ?? "1"));
  } catch {
    return NextResponse.json({ error: "invalid multiplier" }, { status: 400 });
  }
  if (multiplier.lte(0)) {
    return NextResponse.json({ error: "multiplier must be greater than 0" }, { status: 400 });
  }

  const parseOptionalDecimal = (v: unknown): Prisma.Decimal | null | "invalid" => {
    if (v == null || v === "") return null;
    try {
      const d = new Prisma.Decimal(String(v));
      return d.gt(0) ? d : "invalid";
    } catch {
      return "invalid";
    }
  };
  const maxOpenLots = parseOptionalDecimal(body?.maxOpenLots);
  if (maxOpenLots === "invalid") return NextResponse.json({ error: "invalid maxOpenLots" }, { status: 400 });
  const maxDailyLoss = parseOptionalDecimal(body?.maxDailyLoss);
  if (maxDailyLoss === "invalid") return NextResponse.json({ error: "invalid maxDailyLoss" }, { status: 400 });

  const symbolFilterRaw = typeof body?.symbolFilter === "string" ? body.symbolFilter.trim() : "";
  const symbolFilter = symbolFilterRaw
    ? symbolFilterRaw.split(",").map((s: string) => s.trim().toUpperCase()).filter(Boolean).join(",")
    : null;

  const [source, targetAccount] = await Promise.all([
    sourceType === "GROUP"
      ? prisma.group.findFirst({ where: { id: sourceId, brokerId } })
      : prisma.account.findFirst({ where: { id: sourceId, brokerId } }),
    prisma.account.findFirst({ where: { id: targetAccountId, brokerId } }),
  ]);
  if (!source) return NextResponse.json({ error: "source not found for this broker" }, { status: 404 });
  if (!targetAccount) return NextResponse.json({ error: "target account not found for this broker" }, { status: 404 });
  if (sourceType === "ACCOUNT" && sourceId === targetAccountId) {
    return NextResponse.json({ error: "an account cannot mirror into itself" }, { status: 400 });
  }

  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.mirrorRule.create({
      data: {
        brokerId,
        sourceType,
        sourceId,
        targetAccountId,
        direction,
        fillPriceMode,
        multiplier,
        symbolFilter,
        maxOpenLots: maxOpenLots ?? null,
        maxDailyLoss: maxDailyLoss ?? null,
        createdById: session.adminId!,
      },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MIRROR_RULE_CREATED",
        entityType: "MirrorRule",
        entityId: created.id,
        oldValue: {},
        newValue: { sourceType, sourceId, targetAccountId, direction, fillPriceMode, multiplier: multiplier.toString() },
      },
    });
    return created;
  });

  return NextResponse.json({ id: rule.id }, { status: 201 });
}
