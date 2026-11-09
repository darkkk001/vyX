import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Owner 2026-11-10: a group's markup may go negative only once the engine and gateway with negative-markup support are live.
// Until NEGATIVE_MARKUP_ENABLED is on (lib/negative-markup-flag.ts, OFF by default; the VPS session turns it on with the owner's go),
// the group markup save route refuses a negative value with "Negative markup is not live yet." A positive markup is saved as before
// in both states. Against a real database, through the route itself.
vi.mock("@/lib/auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
vi.mock("@/lib/config-events", async (importActual) => ({ ...(await importActual<typeof import("@/lib/config-events")>()), withConfigEvent: (_scope: string, h: unknown) => h }));
vi.mock("@/lib/account-events", async (importActual) => ({ ...(await importActual<typeof import("@/lib/account-events")>()), publishAccountsUpdatedAfterResponse: vi.fn() }));

const s = randomUUID().replace(/-/g, "").slice(0, 8);
let dbReachable = false;
let groupId = "";
let symbolId = "";

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("groups pricing route.test.ts: DB unreachable, skipping"); return; }
  const broker = await prisma.broker.create({ data: { name: `Neg ${s}`, subdomain: `neg-${s}` } });
  groupId = (await prisma.group.create({ data: { brokerId: broker.id, name: "raw", leverage: 100 } })).id;
  symbolId = (await prisma.symbol.create({ data: { name: `ZNEG${s}`.toUpperCase().slice(0, 12), baseCurrency: "ZNG", quoteCurrency: "USD", digits: 5, contractSize: 100000, category: "FOREX" } })).id;
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId, enabled: true } });
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `neg-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, brokerId: broker.id, role: "BROKER_ADMIN" } as never);
});
afterEach(() => { delete process.env.NEGATIVE_MARKUP_ENABLED; });
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function save(spreadMarkup: string) {
  const { PATCH } = await import("@/app/api/manage/groups/[id]/pricing/route");
  const req = new NextRequest(`https://t.local/api/manage/groups/${groupId}/pricing`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbolId, spreadMarkup }) });
  const r = await (PATCH as unknown as (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>)(req, { params: Promise.resolve({ id: groupId }) });
  return { status: r.status, body: await r.json() };
}
const stored = async () => (await prisma.groupSymbolConfig.findFirst({ where: { groupId, symbolId }, select: { spreadMarkup: true } }))?.spreadMarkup?.toString() ?? null;

describe("group markup save: negative only once the flag is on", () => {
  it("flag off (the default): a negative markup is refused with the reason and nothing is stored", async () => {
    if (!dbReachable) return;
    await prisma.groupSymbolConfig.deleteMany({ where: { groupId, symbolId } });
    expect(await save("-1.3")).toEqual({ status: 400, body: { error: "Negative markup is not live yet." } });
    expect(await stored()).toBeNull();
  });
  it("flag off: a positive markup is saved as before", async () => {
    if (!dbReachable) return;
    expect((await save("2")).status).toBe(200);
    expect(await stored()).toBe("2");
  });
  it("flag on: a negative markup is saved", async () => {
    if (!dbReachable) return;
    process.env.NEGATIVE_MARKUP_ENABLED = "1";
    expect((await save("-1.3")).status).toBe(200);
    expect(await stored()).toBe("-1.3");
  });
  it("flag on: a positive markup is saved as before", async () => {
    if (!dbReachable) return;
    process.env.NEGATIVE_MARKUP_ENABLED = "1";
    expect((await save("1.5")).status).toBe(200);
    expect(await stored()).toBe("1.5");
  });
  it("only the exact value 1 turns it on", async () => {
    if (!dbReachable) return;
    process.env.NEGATIVE_MARKUP_ENABLED = "true";
    expect((await save("-0.5")).body.error).toBe("Negative markup is not live yet.");
  });
});
