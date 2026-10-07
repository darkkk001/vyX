import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 3b item 6 (owner 2026-10-07): Risk radar flag / whitelist / note. A flag keeps an account flagged (and in the RDR badge), a whitelist
// takes it out of both, a note is text; applied when the radar is read.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
const radar = vi.hoisted(() => ({ payload: null as unknown }));
vi.mock("@/lib/risk-radar-cache", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/risk-radar-cache")>()), getRiskRadarPayload: vi.fn(async () => radar.payload) }));
import { getAdminSession } from "@/lib/auth";
import { applyRiskMarks, effectivelyFlagged, markIsEmpty, nextMark, NO_MARK, riskRadarBadgeCountWithMarks } from "@/lib/risk-marks";
import type { RiskRadarRow } from "@/lib/risk-radar";

const row = (id: string, flags: Partial<RiskRadarRow> = {}): RiskRadarRow => ({ accountId: id, accountNumber: "N" + id, trades30d: 10, winRatePct: 50, avgHoldMinutes: 5, avgLot: 1, profitVelocityPerDay: 0, scalpFlag: false, martingaleFlag: false, latencyArbFlag: false, newsTraderFlag: false, ...flags });

describe("marks (pure)", () => {
  it("a whitelist wins, a manual flag counts, else any pattern", () => {
    expect(effectivelyFlagged(row("a"), undefined)).toBe(false);
    expect(effectivelyFlagged(row("a", { scalpFlag: true }), undefined)).toBe(true);
    expect(effectivelyFlagged(row("a", { scalpFlag: true }), { flagged: false, whitelisted: true, note: "" })).toBe(false);
    expect(effectivelyFlagged(row("a"), { flagged: true, whitelisted: false, note: "" })).toBe(true);
  });
  it("the badge counts flagged accounts with marks applied, plus same-IP clusters", () => {
    const payload = { rows: [row("a", { scalpFlag: true }), row("b"), row("c", { martingaleFlag: true })], sameIpClusters: [{ ipAddress: "1.1.1.1", accounts: [] }], newsHistory: {}, computedAt: "" } as never;
    const marks = new Map([["a", { flagged: false, whitelisted: true, note: "" }], ["b", { flagged: true, whitelisted: false, note: "" }]]);
    expect(riskRadarBadgeCountWithMarks(payload, marks)).toBe(3);        // b (manual) + c (pattern) + 1 cluster; a is whitelisted
    expect(riskRadarBadgeCountWithMarks(payload, new Map())).toBe(3);    // a + c + 1 cluster
  });
  it("only the keys sent change; flag and whitelist never together; the note is trimmed and capped", () => {
    expect(nextMark(NO_MARK, { flagged: true })).toEqual({ ok: true, mark: { flagged: true, whitelisted: false, note: "" } });
    expect(nextMark({ flagged: true, whitelisted: false, note: "x" }, { whitelisted: true })).toMatchObject({ ok: false });
    expect(nextMark({ flagged: true, whitelisted: false, note: "x" }, { flagged: false, whitelisted: true })).toEqual({ ok: true, mark: { flagged: false, whitelisted: true, note: "x" } });
    expect(nextMark(NO_MARK, { note: "  watch this one  " })).toEqual({ ok: true, mark: { flagged: false, whitelisted: false, note: "watch this one" } });
    expect(nextMark(NO_MARK, { note: "x".repeat(501) })).toMatchObject({ ok: false });
    expect(nextMark(NO_MARK, { flagged: "yes" })).toMatchObject({ ok: false });
    expect(markIsEmpty(NO_MARK)).toBe(true);
  });
  it("marks are applied to every row", () => {
    const r = applyRiskMarks({ rows: [row("a"), row("b")], sameIpClusters: [], newsHistory: {} as never, computedAt: "" }, new Map([["b", { flagged: true, whitelisted: false, note: "hi" }]]));
    expect(r.rows.map((x) => [x.flagged, x.whitelisted, x.note])).toEqual([[false, false, ""], [true, false, "hi"]]);
  });
});

let dbReachable = false;
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("s3b-radar-marks.test.ts: DB unreachable, skipping"); } });
const brokers: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.riskAccountMark.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.account.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.group.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world() {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Rdr ${sfx}`, subdomain: `rdr-${sfx}` } }); brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `RG-${sfx}`, leverage: 100 } });
  const mkAcc = async () => { const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "4")}`; return prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `r-${n}@test.local`, passwordHash: "x", fullName: "R", accountMode: "LIVE", balance: new Prisma.Decimal(100), leverage: 100 } }); };
  const admin = (role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT") => prisma.adminUser.create({ data: { brokerId: b.id, email: `rdr-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role } });
  return { b, mkAcc, admin };
}

describe("PUT /api/manage/risk-radar/marks/{accountId} and GET risk-radar", () => {
  it("flag, whitelist, note: stored, audited, applied to the radar read; an empty mark deletes the row; a foreign account is not found; SUPPORT refused", async () => {
    if (!dbReachable) return;
    const w = await world(); const other = await world();
    const acc = await w.mkAcc(); const foreign = await other.mkAcc(); const boss = await w.admin("MANAGER"); const support = await w.admin("SUPPORT");
    radar.payload = { rows: [row(acc.id, { scalpFlag: true })], sameIpClusters: [], newsHistory: {}, computedAt: "x" };
    const as = (a: { id: string; role: string }) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: w.b.id } as never);
    const { PUT } = await import("@/app/api/manage/risk-radar/marks/[accountId]/route");
    const { GET } = await import("@/app/api/manage/risk-radar/route");
    const put = (id: string, body: unknown) => PUT(new NextRequest("https://t.local/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ accountId: id }) });
    as(boss);
    expect((await put(foreign.id, { flagged: true })).status).toBe(404);
    expect((await put(acc.id, { flagged: true, whitelisted: true })).status).toBe(400);
    const r1 = await put(acc.id, { whitelisted: true, note: "our own test client" }); expect(r1.status).toBe(200);
    let g1 = await (await GET()).json();
    expect(g1.rows[0]).toMatchObject({ whitelisted: true, flagged: false, note: "our own test client", scalpFlag: true });
    const r2 = await put(acc.id, { whitelisted: false, flagged: true }); expect(await r2.json()).toMatchObject({ flagged: true, whitelisted: false, note: "our own test client" });
    expect((await prisma.riskAccountMark.findUniqueOrThrow({ where: { accountId: acc.id } })).updatedByAdminId).toBe(boss.id);
    const audit = await prisma.auditLog.findMany({ where: { brokerId: w.b.id, action: "RISK_MARK_UPDATED" }, orderBy: { createdAt: "asc" } });
    expect(audit).toHaveLength(2);
    expect((audit[1].oldValue as { whitelisted: boolean }).whitelisted).toBe(true); expect((audit[1].newValue as { flagged: boolean }).flagged).toBe(true);
    await put(acc.id, { flagged: false, note: "" });
    expect(await prisma.riskAccountMark.count({ where: { accountId: acc.id } })).toBe(0);          // all three empty: the row is gone
    g1 = await (await GET()).json(); expect(g1.rows[0]).toMatchObject({ whitelisted: false, flagged: false, note: "" });
    as(support); expect((await put(acc.id, { flagged: true })).status).toBe(403);
  });
});
