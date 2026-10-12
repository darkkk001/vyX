import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 3b item 4 (owner 2026-10-07): the trading halt incident log, built from the audit rows halt / close-only / sign-out-all write.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
import { getAdminSession } from "@/lib/auth";
import { buildIncidents, type IncidentAuditRow } from "@/lib/incident-log";

const t = (m: number) => new Date(Date.UTC(2026, 9, 7, 9, m, 0));
const row = (id: string, action: string, min: number, newValue: unknown, entityId = "b1", who: string | null = "a@x.io"): IncidentAuditRow => ({ id, action, entityId, createdAt: t(min), actorEmail: who, oldValue: null, newValue });

describe("buildIncidents", () => {
  const groups = new Map([["g1", "Standard"]]);
  it("pairs a switch-on with its switch-off: who, when, how long", () => {
    const r = buildIncidents([row("2", "RISK_HALT_TOGGLED", 25, { tradingHalted: false }, "b1", "b@x.io"), row("1", "RISK_HALT_TOGGLED", 10, { tradingHalted: true })], groups, t(60));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "HALT", scope: "All trading", startedBy: "a@x.io", endedBy: "b@x.io", durationSeconds: 15 * 60, active: false });
    expect(r[0].startedAt).toBe(t(10).toISOString()); expect(r[0].endedAt).toBe(t(25).toISOString());
  });
  it("a stretch still on is active with its length so far", () => {
    const r = buildIncidents([row("1", "RISK_CLOSE_ONLY_TOGGLED", 0, { closeOnly: true })], groups, t(30));
    expect(r[0]).toMatchObject({ kind: "CLOSE_ONLY", active: true, endedAt: null, durationSeconds: 1800 });
  });
  it("group halts are told apart by group and kind; a repeated switch-on starts nothing new; an orphan switch-off is no incident", () => {
    const r = buildIncidents([
      row("1", "GROUP_HALT_TOGGLED", 1, { tradingHalted: true }, "g1"), row("2", "GROUP_HALT_TOGGLED", 2, { tradingHalted: true }, "g1"),
      row("3", "GROUP_CLOSE_ONLY_TOGGLED", 3, { closeOnly: true }, "g1"), row("4", "GROUP_HALT_TOGGLED", 9, { tradingHalted: false }, "g1"),
      row("5", "RISK_HALT_TOGGLED", 4, { tradingHalted: false }),
    ], groups, t(20));
    expect(r.map((x) => [x.kind, x.scope, x.active])).toEqual([["GROUP_CLOSE_ONLY", "Standard", true], ["GROUP_HALT", "Standard", false]]);
    expect(r[1].durationSeconds).toBe(8 * 60);
  });
  it("sign out all clients is a point in time; newest first; a row without a readable state is skipped", () => {
    const r = buildIncidents([row("1", "RISK_HALT_TOGGLED", 5, { tradingHalted: true }), row("2", "BROKER_CLIENT_SESSIONS_REVOKED", 7, {}), row("3", "RISK_HALT_TOGGLED", 8, { other: 1 })], groups, t(10));
    expect(r.map((x) => x.kind)).toEqual(["SIGN_OUT_CLIENTS", "HALT"]);
    expect(r[0]).toMatchObject({ durationSeconds: 0, active: false, scope: "All clients" });
  });
});

let dbReachable = false;
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("s3b-incidents.test.ts: DB unreachable, skipping"); } });
const brokers: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.group.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

describe("GET /api/manage/emergency/incidents", () => {
  it("real halt, close-only, group halt and sign-out rows become incidents; access follows the EMG screen", async () => {
    if (!dbReachable) return;
    const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
    const b = await prisma.broker.create({ data: { name: `Inc ${sfx}`, subdomain: `inc-${sfx}` } }); brokers.push(b.id);
    const g = await prisma.group.create({ data: { brokerId: b.id, name: `IncG-${sfx}`, leverage: 100 } });
    const mk = (role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT", perms: string[] = []) => prisma.adminUser.create({ data: { brokerId: b.id, email: `inc-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms as never } });
    const admin = await mk("BROKER_ADMIN"); const plain = await mk("MANAGER"); const dealer = await mk("MANAGER", ["EMERGENCY_CONTROLS"]); const support = await mk("SUPPORT");
    const base = Date.now() - 3600_000;
    const add = (action: string, entityId: string, newValue: object, at: number) => prisma.auditLog.create({ data: { brokerId: b.id, actorAdminId: admin.id, action, entityType: "Broker", entityId, newValue, createdAt: new Date(base + at * 1000) } });
    await add("RISK_HALT_TOGGLED", b.id, { tradingHalted: true }, 0); await add("RISK_HALT_TOGGLED", b.id, { tradingHalted: false }, 600);
    await add("GROUP_CLOSE_ONLY_TOGGLED", g.id, { closeOnly: true }, 700);
    await add("BROKER_CLIENT_SESSIONS_REVOKED", b.id, {}, 800);
    await add("SOMETHING_ELSE", b.id, { tradingHalted: true }, 900);   // never an incident
    const as = (a: { id: string; role: string }) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: b.id } as never);
    const { GET } = await import("@/app/api/manage/emergency/incidents/route");
    as(admin);
    const r = await (await GET()).json();
    expect(r.rows.map((x: { kind: string }) => x.kind)).toEqual(["SIGN_OUT_CLIENTS", "GROUP_CLOSE_ONLY", "HALT"]);
    expect(r.rows[2]).toMatchObject({ scope: "All trading", durationSeconds: 600, active: false, startedBy: admin.email });
    expect(r.rows[1]).toMatchObject({ scope: g.name, active: true });
    as(dealer); expect((await GET()).status).toBe(200);
    as(plain); expect((await GET()).status).toBe(403);
    as(support); expect((await GET()).status).toBe(403);
  });
});

import { parseIncidentReason } from "@/lib/incident-reason";

describe("incident reason (one line, required when a restriction goes on)", () => {
  it("required when switching on: empty and whitespace refused; over 200 characters refused; off is optional", () => {
    expect(parseIncidentReason(undefined, true)).toMatchObject({ ok: false });
    expect(parseIncidentReason("   \n\t ", true)).toMatchObject({ ok: false });
    expect(parseIncidentReason(42, true)).toMatchObject({ ok: false });
    expect(parseIncidentReason("x".repeat(201), true)).toMatchObject({ ok: false });
    expect(parseIncidentReason("x".repeat(200), true)).toEqual({ ok: true, reason: "x".repeat(200) });
    expect(parseIncidentReason("", false)).toEqual({ ok: true, reason: null });
  });
  it("one line: line breaks and runs of spaces collapse", () => {
    expect(parseIncidentReason("  Feed\nwrong   gold  price ", true)).toEqual({ ok: true, reason: "Feed wrong gold price" });
  });
  it("the incident carries the reason it started with and the one it ended with", () => {
    const r = buildIncidents([
      row("1", "RISK_HALT_TOGGLED", 10, { tradingHalted: true, reason: "Gold feed wrong" }),
      row("2", "RISK_HALT_TOGGLED", 20, { tradingHalted: false, reason: "Feed fixed" }),
      row("3", "BROKER_CLIENT_SESSIONS_REVOKED", 30, { reason: "Suspected breach" }),
      row("4", "RISK_CLOSE_ONLY_TOGGLED", 40, { closeOnly: true }),
    ], new Map(), t(60));
    const by = (k: string) => r.find((x) => x.kind === k)!;
    expect(by("HALT")).toMatchObject({ reason: "Gold feed wrong", endReason: "Feed fixed" });
    expect(by("SIGN_OUT_CLIENTS")).toMatchObject({ reason: "Suspected breach" });
    expect(by("CLOSE_ONLY")).toMatchObject({ reason: null, endReason: null });
  });
});

describe("halt routes demand a reason", () => {
  it("broker halt / close-only and group halt: no reason = 400 and nothing changes; with a reason it is stored and shown in the log; resuming needs none", async () => {
    if (!dbReachable) return;
    const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
    const b = await prisma.broker.create({ data: { name: `IncR ${sfx}`, subdomain: `incr-${sfx}` } }); brokers.push(b.id);
    const g = await prisma.group.create({ data: { brokerId: b.id, name: `IncRG-${sfx}`, leverage: 100 } });
    const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `incr-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.id } as never);
    const risk = await import("@/app/api/manage/risk/route");
    const halt = await import("@/app/api/manage/groups/[id]/halt/route");
    const patch = (h: unknown, url: string, body: object, ctx?: unknown) =>
      (h as (r: NextRequest, c?: unknown) => Promise<Response>)(new NextRequest(`https://t.local${url}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
    const gctx = { params: Promise.resolve({ id: g.id }) };
    for (const bad of [{ tradingHalted: true }, { tradingHalted: true, reason: "   " }, { closeOnly: true, reason: "x".repeat(201) }]) {
      const r = await patch(risk.PATCH, "/api/manage/risk", bad);
      expect(r.status).toBe(400);
      expect((await r.json()).code).toBe("REASON_REQUIRED");
    }
    expect((await patch(halt.PATCH, `/api/manage/groups/${g.id}/halt`, { halted: true }, gctx)).status).toBe(400);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: b.id } })).tradingHaltedAt).toBeNull();
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).tradingHaltedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { brokerId: b.id } })).toBe(0);

    expect((await patch(risk.PATCH, "/api/manage/risk", { tradingHalted: true, reason: "  Gold feed\nwrong " })).status).toBe(200);
    expect((await patch(halt.PATCH, `/api/manage/groups/${g.id}/halt`, { closeOnly: true, reason: "Group review" }, gctx)).status).toBe(200);
    expect((await patch(risk.PATCH, "/api/manage/risk", { tradingHalted: false })).status).toBe(200);   // resume: no reason needed

    const { GET } = await import("@/app/api/manage/emergency/incidents/route");
    const rows = (await (await GET()).json()).rows as { kind: string; reason: string | null; active: boolean }[];
    expect(rows.find((x) => x.kind === "HALT")).toMatchObject({ reason: "Gold feed wrong", active: false });
    expect(rows.find((x) => x.kind === "GROUP_CLOSE_ONLY")).toMatchObject({ reason: "Group review", active: true });
  });
});
