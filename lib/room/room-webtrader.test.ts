import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Room "Open WebTrader" (owner 2026-11-13): sidebar (Overview > WebTrader), Downloads and Dashboard's Trade on card all
// open /api/room/webtrader in a new tab: signed in to the client's live account, or WebTrader's sign-in page when the
// client has no live account. Real database; the Room session and Redis (the one-time token) are stubbed.
const store = new Map<string, string>();
vi.mock("@/lib/redis", () => ({ getRedis: () => ({
  set: async (k: string, v: string) => { store.set(k, v); return "OK"; },
  get: async (k: string) => store.get(k) ?? null,
  getdel: async (k: string) => { const v = store.get(k) ?? null; store.delete(k); return v; },
  del: async (k: string) => { store.delete(k); return 1; },
}) }));
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));

const read = (p: string) => readFileSync(p, "utf8");
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let n = 0;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("room-webtrader.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Wt ${s}`, subdomain: `wt-${s}`, crmEnabled: true } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", displayName: "Standard", leverage: 100, isDefault: true, category: "B_BOOK" } })).id;
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(accounts: { mode: "LIVE" | "DEMO"; archived?: boolean; wallet?: boolean; ageMin?: number }[]) {
  const k = ++n;
  const c = await prisma.client.create({ data: { brokerId, email: `wt-${k}-${s}@t.local`, passwordHash: "x", fullName: "Wt" } });
  const ids: string[] = [];
  for (const [i, a] of accounts.entries()) {
    ids.push((await prisma.account.create({ data: { brokerId, groupId, clientId: c.id, accountNumber: `4${Date.now() % 1_000_000}${k}${i}`, email: c.email, passwordHash: "x", fullName: "Wt", accountMode: a.mode, isWallet: a.wallet ?? false, archivedAt: a.archived ? new Date() : null, createdAt: new Date(Date.now() - (a.ageMin ?? 0) * 60000) } })).id);
  }
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId } } } as never);
  return ids;
}
async function open() {
  const { GET } = await import("@/app/api/room/webtrader/route");
  const r = await GET(new NextRequest("https://t.local/api/room/webtrader", { headers: { host: "t.local", "x-forwarded-proto": "https" } }));
  return r.headers.get("location") ?? "";
}

describe("Room Open WebTrader", () => {
  it("signs in to the client's oldest active live account (not demo, archived or the wallet)", async () => {
    if (!dbReachable) return;
    const [, , oldLive] = await client([{ mode: "DEMO", ageMin: 90 }, { mode: "LIVE", archived: true, ageMin: 80 }, { mode: "LIVE", ageMin: 60 }, { mode: "LIVE", ageMin: 10 }, { mode: "LIVE", wallet: true, ageMin: 100 }]);
    const to = await open();
    expect(to).toMatch(/^https:\/\/t\.local\/trade\/sso\?token=/);
    const token = new URL(to).searchParams.get("token")!;
    const { consumeSsoToken } = await import("@/lib/sso");
    expect(await consumeSsoToken(token)).toMatchObject({ accountId: oldLive, brokerId });
  });
  it("no live account: WebTrader's own sign-in page", async () => {
    if (!dbReachable) return;
    await client([{ mode: "DEMO" }]);
    expect(await open()).toBe("https://t.local/trade/login");
  });
  it("signed out of the Room: the Room's sign-in", async () => {
    if (!dbReachable) return;
    const { roomApiSession } = await import("@/lib/room/context");
    vi.mocked(roomApiSession).mockResolvedValue({ response: new Response(null, { status: 401 }) } as never);
    expect(await open()).toBe("https://t.local/login");
  });
  it("sidebar (Overview, under Accounts), Downloads and Dashboard all open it in a new tab", () => {
    const side = read("components/room/RoomSidebar.tsx");
    expect(side).toContain('{ href: "/room/accounts", label: "Accounts", icon: "accounts" }, { href: "/api/room/webtrader", label: "WebTrader", icon: "webtrader", newTab: true }] },');
    expect(side).toContain('{...(it.newTab ? { target: "_blank", rel: "noopener" } : {})}');
    expect(read("app/(broker)/room/(shell)/downloads/page.tsx")).toContain('<a href="/api/room/webtrader" target="_blank" rel="noopener"');
    expect(read("app/(broker)/room/(shell)/page.tsx")).toContain('<span>WebTrader</span><a href="/api/room/webtrader" target="_blank" rel="noopener"');
  });
});
