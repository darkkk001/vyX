import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Profile "Choose avatar" (owner 2026-11-14): POST /api/room/avatar saves a preset or the initials, for the signed-in
// client only. Real database; the Room session and the rate limit are stubbed.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "", clientId = "", otherId = "";
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("room-avatar.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Av ${s}`, subdomain: `av-${s}`, crmEnabled: true } })).id;
  clientId = (await prisma.client.create({ data: { brokerId, email: `av-1-${s}@t.local`, passwordHash: "x", fullName: "Av" } })).id;
  otherId = (await prisma.client.create({ data: { brokerId, email: `av-2-${s}@t.local`, passwordHash: "x", fullName: "Av", avatarPreset: "owl" } })).id;
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId, brokerId, broker: { id: brokerId, subdomain: `av-${s}` } } } as never);
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function post(body: unknown) {
  const { POST } = await import("@/app/api/room/avatar/route");
  const r = await POST(new NextRequest("https://t.local/api/room/avatar", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: r.status, preset: (await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).avatarPreset };
}

describe("POST /api/room/avatar", () => {
  it("saves a preset, then the initials again; another client's choice is untouched", async () => {
    if (!dbReachable) return;
    expect(await post({ preset: "wolf" })).toEqual({ status: 200, preset: "wolf" });
    expect(await post({ preset: null })).toEqual({ status: 200, preset: null });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: otherId } })).avatarPreset).toBe("owl");
  });
  it("refuses a name that is no preset", async () => {
    if (!dbReachable) return;
    await post({ preset: "bear" });
    expect(await post({ preset: "../../etc/passwd" })).toEqual({ status: 400, preset: "bear" });
    expect(await post({ preset: 5 })).toEqual({ status: 400, preset: "bear" });
  });
});
