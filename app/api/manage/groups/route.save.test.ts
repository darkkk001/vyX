import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Stage 4 / 1.0.11: the Groups table dropped to seven columns and six fields moved into the edit
// form. This pins that every one of them still round-trips through the API, so "moved into the
// form" cannot quietly become "no longer editable".
//
// It also covers tradingRestriction, which was BROKEN until this release: the form offered
// NONE / CLOSE_ONLY / DISABLED while the route only ever accepted BOTH / BUY_ONLY / SELL_ONLY and
// silently coerced anything else to BOTH -- so a broker could pick "close-only", see it accepted,
// and the group would keep trading both ways.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (s: { role: string } | null, roles: string[]) => s !== null && roles.includes(s.role),
}));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});

const brokerIds: string[] = [];

async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `GrpSave ${s}`, subdomain: `grpsave-${s}` } });
  brokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({
    data: { brokerId: broker.id, email: `gs-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" },
  });
  const group = await prisma.group.create({
    data: { brokerId: broker.id, name: `G-${s}`, category: "B_BOOK", leverage: 100, isClientSelectable: true },
  });
  return { brokerId: broker.id, adminId: admin.id, groupId: group.id, name: group.name };
}

/** GroupForm submits the whole form every time; this route is a full replace, not a partial
 *  update, so a test that sends a subset is testing something the UI never does. */
function fullBody(name: string, over: Record<string, unknown> = {}) {
  return { name, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category: "B_BOOK", modeRestriction: "ANY", dealingMode: "INHERIT", tradingRestriction: "BOTH", isDefault: false, forceDealingMode: false, swapFree: false, ...over };
}

async function patch(fx: { brokerId: string; adminId: string; groupId: string }, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { PATCH } = await import("./[id]/route");
  const res = await PATCH(
    new NextRequest("https://test.local/api/manage/groups/x", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: fx.groupId }) }
  );
  return { status: res.status, json: await res.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.group.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokerIds } } });
  await prisma.$disconnect();
});

describe("Groups: the fields moved into the edit form still save", () => {
  it("round-trips every moved field", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    // exactly what GroupForm submits
    const res = await patch(fx, {
      name: fx.name,
      leverage: 500,
      marginCallLevel: "80",
      stopOutLevel: "40",
      maxLotSize: "25",
      swapFree: true,
      modeRestriction: "DEMO_ONLY",
      // "Always send to dealer" (forceDealingMode) is kept only on a DEALING group (Phase 2 batch 2 routing rule)
      category: "DEALING",
      dealingMode: "MANUAL",
      tradingRestriction: "BOTH",
      forceDealingMode: true,
      isDefault: false,
    });
    expect(res.status).toBe(200);

    const g = await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } });
    expect(g.leverage).toBe(500);                          // moved to form
    expect(g.marginCallLevel.toString()).toBe("80");       // moved to form
    expect(g.stopOutLevel.toString()).toBe("40");          // moved to form
    expect(g.maxLotSize?.toString()).toBe("25");           // moved to form
    expect(g.swapFree).toBe(true);                         // moved to form
    expect(g.modeRestriction).toBe("DEMO_ONLY");           // moved to form (Accepts)
    expect(g.dealingMode).toBe("MANUAL");
    expect(g.forceDealingMode).toBe(true);
  });

  it("saves each real trading restriction -- the control used to be a no-op", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    for (const value of ["BUY_ONLY", "SELL_ONLY", "BOTH"] as const) {
      const res = await patch(fx, fullBody(fx.name, { tradingRestriction: value }));
      expect(res.status).toBe(200);
      const g = await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } });
      expect(g.tradingRestriction).toBe(value);
    }
  });

  // The old form's values. They are not in the enum, so the route falls back to BOTH -- which is
  // exactly why the control appeared to work and did nothing. Pinned so nobody reintroduces them.
  it("still coerces the old invalid values to BOTH", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await patch(fx, fullBody(fx.name, { tradingRestriction: "BUY_ONLY" }));
    await patch(fx, fullBody(fx.name, { tradingRestriction: "CLOSE_ONLY" }));
    const g = await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } });
    expect(g.tradingRestriction).toBe("BOTH");
  });
});
