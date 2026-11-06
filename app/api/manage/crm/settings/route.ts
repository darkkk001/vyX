import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { crmStaff } from "@/lib/crm/core";
import { tiersOf } from "@/lib/room/tier";
import { humanCheckConfigured } from "@/lib/turnstile";
import { CLIENT_IDLE_MAX_MINUTES, CLIENT_IDLE_MIN_MINUTES, parseIdleMinutes } from "@/lib/client-auth";

// The broker's Trader's Room settings (BROKER_ADMIN; anyone in the CRM may read). GET -> module state (read-only; the
// Super Admin switches it), leverage review, tiers, app links, plan cards per client-selectable group with the IB rate,
// payment methods' receiving details. PATCH -> any of those parts.
async function snapshot(brokerId: string) {
  const [b, groups, rates, methods] = await Promise.all([
    prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { crmEnabled: true, leverageChangeReview: true, tierConfig: true, androidAppUrl: true, iosAppUrl: true, stakingEnabled: true, stakingMinAmount: true, stakingCycleDays: true, stakingRatePct: true, clientIdleMinutes: true, humanCheckEnabled: true, requireWithdrawal2fa: true } }),
    prisma.group.findMany({ where: { brokerId, isClientSelectable: true }, select: { id: true, name: true, displayName: true, leverage: true, planMinDeposit: true, planMaxLeverage: true, planSpreadFrom: true, planCommissionPerLot: true }, orderBy: { displayName: "asc" } }),
    prisma.ibPlanRate.findMany({ where: { brokerId }, select: { groupId: true, ratePerLot: true } }),
    prisma.paymentMethod.findMany({ where: { brokerId }, select: { id: true, type: true, enabled: true, processingTime: true, bankDetails: true, walletAddress: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const rateBy = new Map(rates.map((r) => [r.groupId, r.ratePerLot.toFixed(2)]));
  return {
    crmEnabled: b.crmEnabled,
    leverageChangeReview: b.leverageChangeReview,
    staking: { enabled: b.stakingEnabled, minAmount: b.stakingMinAmount.toFixed(2), cycleDays: b.stakingCycleDays, ratePct: b.stakingRatePct.toString() },
    clientIdleMinutes: b.clientIdleMinutes,
    humanCheckEnabled: b.humanCheckEnabled,
    requireWithdrawal2fa: b.requireWithdrawal2fa,
    tiers: tiersOf(b.tierConfig),
    androidAppUrl: b.androidAppUrl,
    iosAppUrl: b.iosAppUrl,
    plans: groups.map((g) => ({ groupId: g.id, group: g.name, plan: g.displayName, leverage: g.leverage, minDeposit: g.planMinDeposit?.toFixed(2) ?? null, maxLeverage: g.planMaxLeverage, spreadFrom: g.planSpreadFrom, commissionPerLot: g.planCommissionPerLot?.toFixed(2) ?? null, ibRatePerLot: rateBy.get(g.id) ?? null })),
    paymentMethods: methods.map((m) => ({ id: m.id, type: m.type, enabled: m.enabled, processingTime: m.processingTime, bankDetails: m.bankDetails, walletAddress: m.walletAddress })),
  };
}

export async function GET() {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  return NextResponse.json(await snapshot(g.staff.brokerId));
}

const url = (v: unknown) => (v === null || v === "" ? null : typeof v === "string" && /^https:\/\/[^\s]{4,300}$/.test(v.trim()) ? v.trim() : undefined);
const dec = (v: unknown, max: number) => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? new Prisma.Decimal(n.toFixed(2)) : undefined;
};

export async function PATCH(request: NextRequest) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  if (staff.role !== "BROKER_ADMIN") return NextResponse.json({ error: "forbidden: CRM settings are BROKER_ADMIN only" }, { status: 403 });
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  const before = await snapshot(staff.brokerId);
  const brokerData: Prisma.BrokerUpdateInput = {};
  if ("leverageChangeReview" in b) brokerData.leverageChangeReview = b.leverageChangeReview === true;
  if ("staking" in b) {
    const st = b.staking as Record<string, unknown> | null;
    if ("enabled" in (st ?? {})) brokerData.stakingEnabled = st!.enabled === true;
    if ("minAmount" in (st ?? {})) { const v = Number(st!.minAmount); if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ error: "Minimum must be a positive amount." }, { status: 400 }); brokerData.stakingMinAmount = new Prisma.Decimal(v.toFixed(2)); }
    if ("cycleDays" in (st ?? {})) { const v = Number(st!.cycleDays); if (!Number.isInteger(v) || v < 1 || v > 365) return NextResponse.json({ error: "Cycle is 1 to 365 days." }, { status: 400 }); brokerData.stakingCycleDays = v; }
    if ("ratePct" in (st ?? {})) { const v = Number(st!.ratePct); if (!Number.isFinite(v) || v < 0 || v > 100) return NextResponse.json({ error: "Rate is 0 to 100%." }, { status: 400 }); brokerData.stakingRatePct = new Prisma.Decimal(v.toFixed(3)); }
  }
  if ("clientIdleMinutes" in b) {
    const v = parseIdleMinutes(b.clientIdleMinutes);
    if (v === null) return NextResponse.json({ error: `Idle limit is ${CLIENT_IDLE_MIN_MINUTES} to ${CLIENT_IDLE_MAX_MINUTES} minutes.` }, { status: 400 });
    brokerData.clientIdleMinutes = v;
  }
  if ("requireWithdrawal2fa" in b) brokerData.requireWithdrawal2fa = b.requireWithdrawal2fa === true;
  if ("humanCheckEnabled" in b) {
    if (b.humanCheckEnabled === true && !humanCheckConfigured()) return NextResponse.json({ error: "The human check is not set up on this platform yet." }, { status: 400 });
    brokerData.humanCheckEnabled = b.humanCheckEnabled === true;
  }
  for (const k of ["androidAppUrl", "iosAppUrl"] as const) {
    if (k in b) { const v = url(b[k]); if (v === undefined) return NextResponse.json({ error: `${k} must be an https link.` }, { status: 400 }); brokerData[k] = v; }
  }
  if ("tiers" in b) {
    if (!Array.isArray(b.tiers) || b.tiers.length === 0 || b.tiers.length > 6) return NextResponse.json({ error: "Give 1 to 6 tiers." }, { status: 400 });
    const tiers = tiersOf({ tiers: b.tiers });
    if (tiers.length !== b.tiers.length || tiers[0].minLots !== 0) return NextResponse.json({ error: "Every tier needs a name and lots; the first starts at 0 lots." }, { status: 400 });
    brokerData.tierConfig = { tiers } as unknown as Prisma.InputJsonValue;
  }
  const planUpdates: { groupId: string; data: Prisma.GroupUpdateInput; rate?: Prisma.Decimal | null }[] = [];
  if (Array.isArray(b.plans)) {
    const ids = new Set(before.plans.map((p) => p.groupId));
    for (const p of b.plans) {
      if (!ids.has(p?.groupId)) return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
      const data: Prisma.GroupUpdateInput = {};
      if ("minDeposit" in p) { const v = dec(p.minDeposit, 1e9); if (v === undefined) return NextResponse.json({ error: "Min deposit is a positive amount." }, { status: 400 }); data.planMinDeposit = v; }
      if ("commissionPerLot" in p) { const v = dec(p.commissionPerLot, 1e6); if (v === undefined) return NextResponse.json({ error: "Commission is a positive amount." }, { status: 400 }); data.planCommissionPerLot = v; }
      if ("maxLeverage" in p) { const v = p.maxLeverage === null || p.maxLeverage === "" ? null : Number(p.maxLeverage); if (v !== null && (!Number.isInteger(v) || v < 1 || v > 1_000_000)) return NextResponse.json({ error: "Max leverage is a whole number." }, { status: 400 }); data.planMaxLeverage = v; }
      if ("spreadFrom" in p) data.planSpreadFrom = typeof p.spreadFrom === "string" && p.spreadFrom.trim() ? p.spreadFrom.trim().slice(0, 24) : null;
      let rate: Prisma.Decimal | null | undefined;
      if ("ibRatePerLot" in p) { rate = dec(p.ibRatePerLot, 1e6); if (rate === undefined) return NextResponse.json({ error: "IB rate is a positive amount." }, { status: 400 }); }
      planUpdates.push({ groupId: p.groupId, data, ...(rate !== undefined ? { rate } : {}) });
    }
  }
  const methodUpdates: { id: string; data: Prisma.PaymentMethodUpdateInput }[] = [];
  if (Array.isArray(b.paymentMethods)) {
    const ids = new Set(before.paymentMethods.map((m) => m.id));
    for (const m of b.paymentMethods) {
      if (!ids.has(m?.id)) return NextResponse.json({ error: "Unknown payment method." }, { status: 400 });
      const data: Prisma.PaymentMethodUpdateInput = {};
      if ("processingTime" in m) data.processingTime = typeof m.processingTime === "string" && m.processingTime.trim() ? m.processingTime.trim().slice(0, 60) : null;
      if ("bankDetails" in m) {
        if (m.bankDetails === null) data.bankDetails = Prisma.DbNull;
        else {
          const d = m.bankDetails as Record<string, unknown>;
          const s = (k: string) => (typeof d?.[k] === "string" ? (d[k] as string).trim().slice(0, 120) : "");
          data.bankDetails = { beneficiary: s("beneficiary"), bank: s("bank"), iban: s("iban"), swift: s("swift") };
        }
      }
      methodUpdates.push({ id: m.id, data });
    }
  }
  await prisma.$transaction(async (tx) => {
    if (Object.keys(brokerData).length) await tx.broker.update({ where: { id: staff.brokerId }, data: brokerData });
    for (const u of planUpdates) {
      if (Object.keys(u.data).length) await tx.group.update({ where: { id: u.groupId }, data: u.data });
      if (u.rate !== undefined) {
        if (u.rate === null) await tx.ibPlanRate.deleteMany({ where: { brokerId: staff.brokerId, groupId: u.groupId } });
        else await tx.ibPlanRate.upsert({ where: { brokerId_groupId: { brokerId: staff.brokerId, groupId: u.groupId } }, create: { brokerId: staff.brokerId, groupId: u.groupId, ratePerLot: u.rate }, update: { ratePerLot: u.rate } });
      }
    }
    for (const u of methodUpdates) if (Object.keys(u.data).length) await tx.paymentMethod.update({ where: { id: u.id }, data: u.data });
  });
  const after = await snapshot(staff.brokerId);
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, action: "CRM_SETTINGS_CHANGED", entityType: "Broker", entityId: staff.brokerId, oldValue: JSON.parse(JSON.stringify({ ...before, paymentMethods: undefined })), newValue: JSON.parse(JSON.stringify({ ...after, paymentMethods: undefined })) } });
  return NextResponse.json(after);
}
