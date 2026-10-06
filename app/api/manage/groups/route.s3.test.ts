import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Step 3 (owner 2026-10-06): the Dealing desk checkbox maps to category + forceDealingMode on the server side of the
// contract, a new B_BOOK / DEALING group is client-selectable by itself (S2), the staff account route refuses the
// account-level swap-free override (S1), and the audited clearing script lists, writes once, and a re-run changes 0.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (s: { role: string } | null, roles: string[]) => s !== null && roles.includes(s.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});
const brokerIds: string[] = [];

async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `GrpS3 ${s}`, subdomain: `grps3-${s}` } });
  brokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `s3-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const mk = (category: "A_BOOK" | "B_BOOK" | "DEALING" | "REVERSAL" | "COVERAGE", extra: Record<string, unknown> = {}) =>
    prisma.group.create({ data: { brokerId: broker.id, name: `${category}-${s}`, category, leverage: 100, ...extra } });
  return { brokerId: broker.id, adminId: admin.id, s, mk };
}

async function as(fx: { brokerId: string; adminId: string }) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
}
const form = (name: string, over: Record<string, unknown> = {}) => ({
  name, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", modeRestriction: "ANY", dealingMode: "INHERIT", tradingRestriction: "BOTH", isDefault: false, swapFree: false, ...over,
});
async function post(fx: { brokerId: string; adminId: string }, body: Record<string, unknown>) {
  await as(fx);
  const { POST } = await import("./route");
  const res = await POST(new NextRequest("https://t.local/api/manage/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
async function patch(fx: { brokerId: string; adminId: string }, groupId: string, body: Record<string, unknown>) {
  await as(fx);
  const { PATCH } = await import("./[id]/route");
  const res = await PATCH(new NextRequest("https://t.local/api/manage/groups/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: groupId }) });
  return { status: res.status, json: await res.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.notification.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.account.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.group.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokerIds } } });
  await prisma.$disconnect();
});

describe("Dealing desk checkbox (D0 = B): what the server stores", () => {
  it("checked = DEALING + forceDealingMode; unchecked = B_BOOK + forceDealingMode off", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const g = await fx.mk("B_BOOK");
    const on = await patch(fx, g.id, form(g.name, { category: "DEALING", forceDealingMode: true }));
    expect(on.status).toBe(200);
    expect(on.json.category).toBe("DEALING");
    expect(on.json.forceDealingMode).toBe(true);
    const off = await patch(fx, g.id, form(g.name, { category: "B_BOOK", forceDealingMode: false }));
    expect(off.json.category).toBe("B_BOOK");
    expect(off.json.forceDealingMode).toBe(false);
    // unchecking a DEALING group that had the force flag never leaves the flag behind on a Book group
    const stale = await patch(fx, g.id, form(g.name, { category: "B_BOOK", forceDealingMode: true }));
    expect(stale.json.forceDealingMode).toBe(false);
  });

  it("A_BOOK / REVERSAL / COVERAGE groups keep their category when the form sends no category (it never does for them)", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    for (const c of ["A_BOOK", "REVERSAL", "COVERAGE"] as const) {
      const g = await fx.mk(c, c === "A_BOOK" ? { modeRestriction: "LIVE_ONLY" } : {});
      const r = await patch(fx, g.id, form(g.name, { forceDealingMode: false, dealingMode: "AUTO", ...(c === "A_BOOK" ? { modeRestriction: "LIVE_ONLY" } : {}) }));
      expect(r.status).toBe(200);
      expect(r.json.category).toBe(c);
      expect(r.json.dealingMode).toBe("AUTO");
    }
  });
});

describe("S2: new Book / Dealing groups are client-selectable by themselves", () => {
  it("B_BOOK and DEALING yes, A_BOOK / REVERSAL no", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const out: Record<string, boolean | undefined> = {};
    let i = 0;
    for (const c of ["B_BOOK", "DEALING", "A_BOOK", "REVERSAL"]) {
      const created = await post(fx, form(`${c}-${fx.s}-${i++}`, { category: c }));
      expect(created.status).toBe(201);
      out[c] = (await prisma.group.findUniqueOrThrow({ where: { id: created.json.id } })).isClientSelectable;
    }
    expect(out).toEqual({ B_BOOK: true, DEALING: true, A_BOOK: false, REVERSAL: false });
  });

  it("an edit that does not send the flag keeps it", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const g = await fx.mk("B_BOOK", { isClientSelectable: false });
    await patch(fx, g.id, form(g.name, { category: "B_BOOK" }));
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).isClientSelectable).toBe(false);
  });
});

describe("S1: swap-free is the group's decision only", () => {
  it("the staff account route refuses an account-level swap-free override and writes nothing", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const g = await fx.mk("B_BOOK");
    const n = `3${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "5")}`;
    const acc = await prisma.account.create({ data: { brokerId: fx.brokerId, groupId: g.id, accountNumber: n, email: `s3-${n}@test.local`, passwordHash: "x", fullName: "S3", balance: new Prisma.Decimal(1000), leverage: 100, accountMode: "LIVE" } });
    await as(fx);
    const { PATCH } = await import("../accounts/[id]/route");
    for (const swapFree of [true, false, null]) {
      const res = await PATCH(new NextRequest("https://t.local/api/manage/accounts/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ swapFree }) }), { params: Promise.resolve({ id: acc.id }) });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("SWAP_FREE_GROUP_ONLY");
    }
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).swapFree).toBeNull();
  });
});

describe("scripts/clear-account-swapfree-overrides.ts", () => {
  it("dry run lists and writes nothing; apply clears each with one audit row; the second run changes 0", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const g = await fx.mk("B_BOOK");
    const mkAcc = (sf: boolean | null, k: string) => {
      const n = `3${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, k)}`;
      return prisma.account.create({ data: { brokerId: fx.brokerId, groupId: g.id, accountNumber: n, email: `s3-${n}@test.local`, passwordHash: "x", fullName: "S3", balance: new Prisma.Decimal(1), leverage: 100, accountMode: "LIVE", swapFree: sf } });
    };
    const a1 = await mkAcc(true, "6");
    const a2 = await mkAcc(false, "7");
    const a3 = await mkAcc(null, "8");
    const { clearSwapFreeOverrides, AUDIT_ACTION } = await import("@/scripts/clear-account-swapfree-overrides");
    const scope = { brokerId: fx.brokerId };

    const dry = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return clearSwapFreeOverrides(tx, { apply: false, ...scope });
    });
    expect(dry.cleared).toBe(0);
    expect(dry.accounts.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a1.id } })).swapFree).toBe(true);

    const applied = await prisma.$transaction((tx) => clearSwapFreeOverrides(tx, { apply: true, ...scope }));
    expect(applied.cleared).toBe(2);
    const rows = await prisma.account.findMany({ where: { id: { in: [a1.id, a2.id, a3.id] } } });
    expect(rows.every((r) => r.swapFree === null)).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { brokerId: fx.brokerId, action: AUDIT_ACTION }, orderBy: { entityId: "asc" } });
    expect(audits).toHaveLength(2);
    const old = new Map(audits.map((a) => [a.entityId, (a.oldValue as { swapFree: boolean }).swapFree]));
    expect(old.get(a1.id)).toBe(true);
    expect(old.get(a2.id)).toBe(false);
    expect(audits.every((a) => (a.newValue as { swapFree: unknown }).swapFree === null)).toBe(true);

    const again = await prisma.$transaction((tx) => clearSwapFreeOverrides(tx, { apply: true, ...scope }));
    expect(again.cleared).toBe(0);
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: AUDIT_ACTION } })).toBe(2);
  });
});
