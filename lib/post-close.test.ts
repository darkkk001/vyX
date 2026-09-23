import "dotenv/config";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { drainPostCloseBackstop, PostCloseCrash, recordPostCloseFailure, runPostClose, type PostCloseResult } from "@/lib/post-close";
import { POST as postCloseRoute } from "@/app/api/internal/post-close/route";

// Rust cutover Stage 3 gate (docs/RUST-CUTOVER-PLAN.md §3.6). The engine's REAL monitor (order_management::monitor::
// evaluate_account, via `parity --evaluate-accounts`) closes positions on the harness DB and queues their
// PostCloseEffect rows; lib/post-close.ts then runs them, clean and under every fault the plan lists. Every write
// must happen exactly once.
//
// Needs the scratch harness DB (the engine binary refuses any other) and a built parity binary:
//   (cd engine && cargo build -p parity)
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_rust_harness DIRECT_URL=<same> POST_CLOSE_GATE=1 npx vitest run lib/post-close.test.ts
// Without them the file skips, unless POST_CLOSE_GATE=1, which turns a missing piece into a failure.

const HARNESS_URL = "postgresql://postgres@127.0.0.1:5499/vyx_rust_harness";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PARITY_BIN = path.join(REPO_ROOT, "engine", "target", "debug", process.platform === "win32" ? "parity.exe" : "parity");
const REQUIRED = process.env.POST_CLOSE_GATE === "1";
const D = (v: string | number) => new Prisma.Decimal(v);

let ready = false;
const brokers: string[] = [];
// every trading event the runner publishes, captured here instead of reaching any gateway
const published: { subject: string; payload: Record<string, unknown> }[] = [];

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    published.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200 });
  });
  const reasons: string[] = [];
  if (process.env.DATABASE_URL !== HARNESS_URL) reasons.push(`DATABASE_URL is not ${HARNESS_URL}`);
  if (!existsSync(PARITY_BIN)) reasons.push(`no parity binary at ${PARITY_BIN} (cd engine && cargo build -p parity)`);
  if (reasons.length === 0) {
    try {
      await prisma.$queryRaw`SELECT 1 FROM "PostCloseEffect" LIMIT 1`;
    } catch {
      reasons.push("PostCloseEffect table missing (prisma migrate deploy on the harness DB)");
    }
  }
  if (reasons.length > 0) {
    if (REQUIRED) throw new Error(`post-close gate cannot run: ${reasons.join("; ")}`);
    console.warn(`lib/post-close.test.ts skipped: ${reasons.join("; ")}`);
    return;
  }
  ready = true;
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const brokerId of brokers) await cleanup(brokerId);
  await prisma.$disconnect();
});

async function cleanup(brokerId: string) {
  const where = { brokerId };
  const steps: (() => Promise<unknown>)[] = [
    () => prisma.notification.deleteMany({ where }),
    () => prisma.auditLog.deleteMany({ where }),
    () => prisma.postCloseEffect.deleteMany({ where }),
    () => prisma.mirrorLink.deleteMany({ where: { rule: { brokerId } } }),
    () => prisma.mirrorRule.deleteMany({ where }),
    () => prisma.transaction.deleteMany({ where }),
    () => prisma.position.updateMany({ where, data: { closePendingOrderId: null, coveragePositionId: null } }),
    () => prisma.order.updateMany({ where, data: { closesPositionId: null } }),
    () => prisma.position.deleteMany({ where }),
    () => prisma.order.deleteMany({ where }),
    () => prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: null } }),
    () => prisma.account.deleteMany({ where }),
    () => prisma.group.deleteMany({ where }),
    () => prisma.adminUser.deleteMany({ where }),
    () => prisma.broker.delete({ where: { id: brokerId } }),
  ];
  for (const step of steps) await step().catch((err) => console.warn("post-close cleanup:", String(err).slice(0, 200)));
}

type World = {
  brokerId: string;
  symbolId: string;
  symbolName: string;
  groupId: string;
  client: string; // stop-out account
  mc: string; // margin-call account
  master: string; // the mirror target's account
  coverage: string;
  p1: string; // client position: stopped out by the engine
  target: string; // its mirror target
  leg: string; // its auto-hedged coverage leg
  queued: string; // the close the client had queued for p1
  mcPos: string;
};

async function position(w: Pick<World, "brokerId" | "symbolId">, accountId: string, side: "BUY" | "SELL", volume: string, openPrice: string, extra?: Partial<Prisma.PositionUncheckedCreateInput>) {
  const order = await prisma.order.create({
    data: { brokerId: w.brokerId, accountId, symbolId: w.symbolId, side, type: "MARKET", volume: D(volume), status: "FILLED", filledPrice: D(openPrice), filledAt: new Date(), idempotencyKey: `pcgate:${randomUUID()}` },
  });
  const p = await prisma.position.create({
    data: { brokerId: w.brokerId, accountId, symbolId: w.symbolId, originOrderId: order.id, side, volume: D(volume), openPrice: D(openPrice), status: "OPEN", bookType: "B_BOOK", ...extra },
  });
  return p.id;
}

// Contract 100000, bid 1.10000 / ask 1.10020, stop-out 50 % / margin call 100 %:
// - client: balance 100, BUY 1 @ 1.20000 -> equity -9900 on 1100 margin (-900 %): the engine stops it out;
//   it has a mirror target (SELL 1, SOURCE_PRICE), an auto-hedged coverage leg (BUY 1) and a queued close;
// - mc: balance 1500, BUY 1 @ 1.10500 -> equity 1000 on 1100 margin (90.91 %): margin call, no close.
async function seedWorld(): Promise<World> {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `PostClose Gate ${s}`, subdomain: `pcgate-${s}`, negativeBalanceProtection: true } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `pcgate-admin-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `PC${s.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", contractSize: D(100000) } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("1.10000"), ask: D("1.10020"), tickAt: new Date() } });
  const group = await prisma.group.create({
    data: { brokerId: broker.id, name: `PC Clients ${s}`, dealingMode: "AUTO", groupType: "DEALING", stopOutLevel: D(50), marginCallLevel: D(100) },
  });
  const account = (prefix: string, balance: number, groupId: string) =>
    prisma.account.create({
      data: { brokerId: broker.id, groupId, accountNumber: `${prefix}${s.slice(0, 7)}`, email: `pcgate-${prefix}-${s}@test.local`, passwordHash: "x", fullName: `PC ${prefix}`, accountMode: "LIVE", balance: D(balance), leverage: 100 },
    });
  const client = await account("1", 100, group.id);
  const mc = await account("2", 1500, group.id);
  const master = await account("3", 100000, group.id);
  const covGroup = await prisma.group.create({ data: { brokerId: broker.id, name: `PC Coverage ${s}`, category: "COVERAGE", groupType: "COVERAGE", leverage: 500 } });
  const coverage = await account("4", 0, covGroup.id);
  await prisma.broker.update({ where: { id: broker.id }, data: { coverageAccountId: coverage.id } });

  const w0 = { brokerId: broker.id, symbolId: symbol.id };
  const leg = await position(w0, coverage.id, "BUY", "1", "1.20020", { bookType: "A_BOOK", autoHedged: true });
  const p1 = await position(w0, client.id, "BUY", "1", "1.20000", { covered: true, coveredAt: new Date(), coveragePositionId: leg });
  const target = await position(w0, master.id, "SELL", "1", "1.20000");
  const mcPos = await position(w0, mc.id, "BUY", "1", "1.10500");
  const rule = await prisma.mirrorRule.create({
    data: { brokerId: broker.id, sourceType: "GROUP", sourceId: group.id, targetAccountId: master.id, direction: "REVERSE", multiplier: D(1), enabled: true, fillPriceMode: "SOURCE_PRICE", createdById: admin.id },
  });
  await prisma.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId: p1, targetPositionId: target } });
  const queued = await prisma.order.create({
    data: { brokerId: broker.id, accountId: client.id, symbolId: symbol.id, side: "BUY", type: "MARKET", volume: D(1), status: "PENDING", closesPositionId: p1, closeVolume: D(1), idempotencyKey: `pcgate:q:${randomUUID()}` },
  });
  await prisma.position.update({ where: { id: p1 }, data: { closePendingOrderId: queued.id } });

  return { brokerId: broker.id, symbolId: symbol.id, symbolName: symbol.name, groupId: group.id, client: client.id, mc: mc.id, master: master.id, coverage: coverage.id, p1, target, leg, queued: queued.id, mcPos };
}

/** One real engine monitor pass per account (scratch harness DB only; the binary refuses anything else). */
function engineEvaluate(...accountIds: string[]) {
  execFileSync(PARITY_BIN, ["--evaluate-accounts", accountIds.join(",")], { stdio: "pipe", timeout: 60000 });
}

async function rows(brokerId: string) {
  return prisma.postCloseEffect.findMany({ where: { brokerId }, orderBy: { createdAt: "asc" } });
}

async function closeRow(w: World) {
  return prisma.postCloseEffect.findFirstOrThrow({ where: { brokerId: w.brokerId, kind: "POSITION_CLOSED", positionId: w.p1 } });
}

const count = {
  audit: (entityId: string, action: string) => prisma.auditLog.count({ where: { entityId, action } }),
  notes: (entityId: string, type: string) => prisma.notification.count({ where: { entityId, type } }),
  pnl: (referenceId: string) => prisma.transaction.count({ where: { referenceId, type: "TRADE_PNL" } }),
};

/** Everything the stop-out of p1 must leave behind, each exactly once. */
async function expectStopOutFollowUpExactlyOnce(w: World) {
  const row = await closeRow(w);
  expect(row.status).toBe("DONE");
  expect([...row.doneSteps].sort()).toEqual(["activity", "cancel_pending_close", "coverage", "mirror", "notify_stop_out"]);

  const queued = await prisma.order.findUniqueOrThrow({ where: { id: w.queued } });
  expect(queued.status).toBe("CANCELLED");
  expect((await prisma.position.findUniqueOrThrow({ where: { id: w.p1 } })).closePendingOrderId).toBeNull();
  expect(await count.audit(w.queued, "DEALING_CLOSE_SUPERSEDED")).toBe(1);

  const target = await prisma.position.findUniqueOrThrow({ where: { id: w.target } });
  expect(target.status).toBe("CLOSED");
  expect(target.closePrice?.toString()).toBe("1.1"); // SOURCE_PRICE: the engine's close price
  expect(await count.pnl(w.target)).toBe(1);
  expect(await count.audit(w.target, "MIRROR_CLOSED")).toBe(1);
  expect((await prisma.account.findUniqueOrThrow({ where: { id: w.master } })).balance.toString()).toBe("110000");

  expect(await count.notes(w.p1, "STOP_OUT")).toBe(1);

  const leg = await prisma.position.findUniqueOrThrow({ where: { id: w.leg } });
  expect(leg.status).toBe("CLOSED");
  expect(await count.pnl(w.leg)).toBe(1);
  expect(await count.audit(w.leg, "POSITION_COVERAGE_AUTO_CLOSED")).toBe(1);

  // the source's own close is the engine's: one TRADE_PNL, never touched again by the follow-up
  expect(await count.pnl(w.p1)).toBe(1);

  const events = (row.pendingEvents as { type: string; payload: Record<string, unknown> }[]).map((e) => `${e.type}:${e.payload.position_id ?? e.payload.order_id}`);
  for (const expected of [`OrderCancelled:${w.queued}`, `PositionClosed:${w.target}`, `PositionClosed:${w.leg}`, `PositionClosed:${w.p1}`, `DealerActivity:${w.p1}`]) {
    expect(events.filter((e) => e === expected).length, expected).toBe(1);
  }
}

async function runUntilDone(id: string, opts?: Parameters<typeof runPostClose>[1]): Promise<PostCloseResult[]> {
  const results: PostCloseResult[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await runPostClose(id, i === 0 ? opts : undefined);
    results.push(r);
    if (r.status === "done" || r.status === "gone") return results;
    if (r.status === "retry" || r.status === "error") await recordPostCloseFailure(id, r.error ?? r.status);
  }
  throw new Error(`row ${id} never finished: ${JSON.stringify(results)}`);
}

describe("Stage 3 gate: engine stop-out with a mirror target, an auto-hedged leg and a queued close", () => {
  it("the engine queues one row per close, in the close's own transaction, with what the web needs", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client, w.mc);

    const all = await rows(w.brokerId);
    expect(all.map((r) => r.kind).sort()).toEqual(["MARGIN_CALL", "POSITION_CLOSED"]);
    const close = await closeRow(w);
    const pnlRow = await prisma.transaction.findFirstOrThrow({ where: { referenceId: w.p1, type: "TRADE_PNL" } });
    expect(close.dedupeKey).toBe(`close:${w.p1}:${pnlRow.id}`);
    expect(close.reason).toBe("stop_out");
    expect(close.accountId).toBe(w.client);
    expect(close.payload).toEqual({ closedLots: "1", sourceVolumeBeforeClose: "1", closePrice: "1.1", realizedPnl: "-10000", marginLevel: "-900.00", stopOutLevel: "50" });
    const mcRow = all.find((r) => r.kind === "MARGIN_CALL")!;
    expect(mcRow.accountId).toBe(w.mc);
    expect(mcRow.payload).toEqual({ marginLevel: "90.91", marginCallLevel: "100" });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: w.mc } })).marginCallNotifiedAt).not.toBeNull();
    // nothing ran yet: the web side is untouched until the row is delivered
    expect((await prisma.order.findUniqueOrThrow({ where: { id: w.queued } })).status).toBe("PENDING");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: w.target } })).status).toBe("OPEN");
  });

  it("(i) clean: every follow-up happens exactly once, and the margin call notifies trader + staff once", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client, w.mc);
    for (const r of await rows(w.brokerId)) expect(await runPostClose(r.id)).toEqual({ status: "done" });
    await expectStopOutFollowUpExactlyOnce(w);
    expect(await count.notes(w.mc, "MARGIN_CALL")).toBe(2);
    expect(await prisma.notification.count({ where: { entityId: w.mc, type: "MARGIN_CALL", accountId: w.mc } })).toBe(1);
    // a replay of a finished row is a no-op
    for (const r of await rows(w.brokerId)) expect((await runPostClose(r.id)).status).toBe("gone");
    await expectStopOutFollowUpExactlyOnce(w);
    expect(await count.notes(w.mc, "MARGIN_CALL")).toBe(2);
  });

  const boundaries = ["cancel_pending_close", "mirror", "notify_stop_out", "coverage", "activity"].flatMap((s) => [`before:${s}`, `after:${s}`]).concat(["before:publish"]);
  it.each(boundaries)("(ii) a 500 once at %s, then the retry: still exactly once", async (point) => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    let fired = false;
    const results = await runUntilDone(row.id, {
      fault: (p) => {
        if (p === point && !fired) {
          fired = true;
          throw new Error(`injected 500 at ${p}`);
        }
      },
    });
    expect(fired).toBe(true);
    expect(results.map((r) => r.status)).toEqual(["error", "done"]);
    const after = await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.attempts).toBe(1);
    await expectStopOutFollowUpExactlyOnce(w);
  });

  it("(iii) the runner dies between the mirror close and the stop-out notice: the lease holds, then a retry finishes once", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    await expect(runPostClose(row.id, { fault: (p) => { if (p === "after:mirror") throw new PostCloseCrash("killed"); } })).rejects.toBeInstanceOf(PostCloseCrash);
    const mid = await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(mid.doneSteps).toEqual(["cancel_pending_close", "mirror"]);
    expect(await count.notes(w.p1, "STOP_OUT")).toBe(0);
    // another caller inside the lease window leaves it alone
    expect((await runPostClose(row.id)).status).toBe("busy");
    // ...60 s later the lease has lapsed
    await prisma.postCloseEffect.update({ where: { id: row.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect((await runPostClose(row.id)).status).toBe("done");
    await expectStopOutFollowUpExactlyOnce(w);
  });

  it("(iv) two dispatchers at once: one runs it, the other is turned away", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    const statuses = (await Promise.all([runPostClose(row.id), runPostClose(row.id)])).map((r) => r.status).sort();
    expect(statuses.filter((s) => s === "done")).toHaveLength(1);
    expect(statuses.every((s) => ["done", "busy", "gone"].includes(s))).toBe(true);
    await expectStopOutFollowUpExactlyOnce(w);
  });

  it("(iv-b) even with the lease bypassed, three concurrent runners write everything exactly once (the step markers alone)", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    const results = await Promise.all([1, 2, 3].map(() => runPostClose(row.id, { ignoreLease: true })));
    expect(results.every((r) => r.status === "done" || r.status === "gone")).toBe(true);
    await expectStopOutFollowUpExactlyOnce(w);
  });
});

describe("Stage 3 gate: partial replay", () => {
  it("a 0.5-of-1.0 close replayed through a crash, a 500 and 3 more runs closes the mirror target exactly once (0.5 lots)", async () => {
    if (!ready) return;
    const w = await seedWorld();
    // the source after a partial close (0.5 of 1.0 left), and its outbox row as a partial would carry it
    await prisma.position.update({ where: { id: w.p1 }, data: { volume: D("0.5"), closePendingOrderId: null, covered: false, coveragePositionId: null } });
    const row = await prisma.postCloseEffect.create({
      data: {
        kind: "POSITION_CLOSED", dedupeKey: `test:partial:${w.p1}`, brokerId: w.brokerId, accountId: w.client, positionId: w.p1, reason: "stop_loss",
        payload: { closedLots: "0.5", sourceVolumeBeforeClose: "1", closePrice: "1.1", realizedPnl: "-5000" },
      },
    });
    await expect(runPostClose(row.id, { fault: (p) => { if (p === "after:mirror") throw new PostCloseCrash("killed"); } })).rejects.toBeInstanceOf(PostCloseCrash);
    await prisma.postCloseEffect.update({ where: { id: row.id }, data: { leaseUntil: null } });
    expect((await runPostClose(row.id, { fault: (p) => { if (p === "before:coverage") throw new Error("injected 500"); } })).status).toBe("error");
    expect((await runPostClose(row.id)).status).toBe("done");
    for (let i = 0; i < 3; i++) expect((await runPostClose(row.id)).status).toBe("gone");

    const target = await prisma.position.findUniqueOrThrow({ where: { id: w.target } });
    expect(target.status).toBe("OPEN");
    expect(target.volume.toString()).toBe("0.5"); // not 0.25: the proportion was applied once
    expect(await count.audit(w.target, "MIRROR_CLOSED")).toBe(1);
    expect(await count.pnl(w.target)).toBe(1);
    // a partial keeps the source's queued close alone (none here) and reports partial activity
    const events = (await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } })).pendingEvents as { type: string; payload: { values?: { partial?: boolean }; position_id?: string } }[];
    expect(events.find((e) => e.type === "DealerActivity" && e.payload.position_id === w.p1)?.payload.values?.partial).toBe(true);
  });
});

describe("Stage 3 gate: margin call set / stay / clear / fire again", () => {
  it("one notice per episode, driven by the engine's edge on marginCallNotifiedAt", async () => {
    if (!ready) return;
    const w = await seedWorld();
    const setPrice = (bid: string, ask: string) => prisma.livePrice.update({ where: { symbol: w.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
    const mcRows = () => prisma.postCloseEffect.findMany({ where: { brokerId: w.brokerId, kind: "MARGIN_CALL" } });
    const notified = async () => (await prisma.account.findUniqueOrThrow({ where: { id: w.mc } })).marginCallNotifiedAt;

    engineEvaluate(w.mc); // 90.91 %: in
    expect(await mcRows()).toHaveLength(1);
    expect(await notified()).not.toBeNull();
    await setPrice("1.10000", "1.10020");
    engineEvaluate(w.mc); // still in: nothing new
    expect(await mcRows()).toHaveLength(1);
    await setPrice("1.11000", "1.11020"); // equity 2000 on 1110 margin = 180 %: out
    engineEvaluate(w.mc);
    expect(await notified()).toBeNull();
    expect(await mcRows()).toHaveLength(1);
    await setPrice("1.10000", "1.10020"); // back in: a new episode
    engineEvaluate(w.mc);
    expect(await notified()).not.toBeNull();
    const all = await mcRows();
    expect(all).toHaveLength(2);

    for (const r of all) {
      expect((await runPostClose(r.id)).status).toBe("done");
      expect((await runPostClose(r.id)).status).toBe("gone");
    }
    expect(await count.notes(w.mc, "MARGIN_CALL")).toBe(4); // trader + staff, twice
    const body = (await prisma.notification.findFirstOrThrow({ where: { entityId: w.mc, type: "MARGIN_CALL" } })).body;
    expect(body).toMatch(/margin level is 90\.91%, at or below the 100% margin-call level/);
  });
});

describe("Stage 3 gate: giving up", () => {
  it("DEAD after the last attempt, with exactly one OUTBOX_DEAD alert", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    await prisma.postCloseEffect.update({ where: { id: row.id }, data: { attempts: 48 } });
    expect(await recordPostCloseFailure(row.id, "HTTP 500: boom")).toBe("retry"); // attempt 49
    expect(await recordPostCloseFailure(row.id, "HTTP 500: boom")).toBe("dead"); // attempt 50
    expect(await recordPostCloseFailure(row.id, "HTTP 500: boom")).toBe("gone"); // a late caller changes nothing
    expect((await runPostClose(row.id)).status).toBe("gone");
    const dead = await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(dead.status).toBe("DEAD");
    expect(await count.notes(w.p1, "OUTBOX_DEAD")).toBe(1);
  });

  it("a row older than 24 h goes DEAD on its next failure", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    await prisma.postCloseEffect.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    expect(await recordPostCloseFailure(row.id, "no answer")).toBe("dead");
    expect(await count.notes(w.p1, "OUTBOX_DEAD")).toBe(1);
  });

  it("backoff: 2 s, 10 s, 30 s, 2 min, 10 min, then 30 min", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = Date.now();
      await recordPostCloseFailure(row.id, "x");
      const r = await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } });
      waits.push(Math.round((r.nextAttemptAt.getTime() - before) / 1000));
    }
    expect(waits.map((s, i) => Math.abs(s - [2, 10, 30, 120, 600, 1800, 1800][i]) <= 2)).toEqual(Array(7).fill(true));
  });
});

describe("Stage 3 gate: an auto-hedged leg without a live price", () => {
  it("is retried about a minute, then COVERAGE_CLOSE_FAILED goes out once and the leg stays open", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    await prisma.livePrice.delete({ where: { symbol: w.symbolName } });
    const row = await closeRow(w);
    const results = await runUntilDone(row.id);
    expect(results.map((r) => r.status)).toEqual(["retry", "retry", "retry", "done"]);
    expect(await count.notes(w.leg, "COVERAGE_CLOSE_FAILED")).toBe(1);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: w.leg } })).status).toBe("OPEN");
    // everything else still happened, once
    expect(await count.audit(w.target, "MIRROR_CLOSED")).toBe(1);
    expect(await count.notes(w.p1, "STOP_OUT")).toBe(1);
  });

  it("closes the leg once the price is back, with no failure alert", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    await prisma.livePrice.delete({ where: { symbol: w.symbolName } });
    const row = await closeRow(w);
    const first = await runPostClose(row.id);
    expect(first.status).toBe("retry");
    await recordPostCloseFailure(row.id, first.error!);
    await prisma.livePrice.create({ data: { symbol: w.symbolName, bid: D("1.10000"), ask: D("1.10020"), tickAt: new Date() } });
    expect((await runPostClose(row.id)).status).toBe("done");
    await expectStopOutFollowUpExactlyOnce(w);
    expect(await count.notes(w.leg, "COVERAGE_CLOSE_FAILED")).toBe(0);
  });
});

describe("Stage 3: the web cron backstop and the route", () => {
  it("the margin-monitor backstop runs a row the dispatcher left for over 2 minutes", async () => {
    if (!ready) return;
    const w = await seedWorld();
    engineEvaluate(w.client);
    const row = await closeRow(w);
    await prisma.postCloseEffect.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    await drainPostCloseBackstop();
    await expectStopOutFollowUpExactlyOnce(w);
  });

  it("POST /api/internal/post-close: bearer secret (constant-time), 400 on a bad body, 200 done, then 200 gone", async () => {
    if (!ready) return;
    vi.stubEnv("POST_CLOSE_SECRET", "gate-secret");
    try {
      const w = await seedWorld();
      engineEvaluate(w.client);
      const row = await closeRow(w);
      const call = (auth: string | null, body: unknown) =>
        postCloseRoute(new NextRequest("http://localhost/api/internal/post-close", { method: "POST", headers: auth ? { authorization: auth } : {}, body: JSON.stringify(body) }));
      expect((await call(null, { id: row.id })).status).toBe(401);
      expect((await call("Bearer wrong", { id: row.id })).status).toBe(401);
      expect((await call("Bearer gate-secret", { nope: 1 })).status).toBe(400);
      const ok = await call("Bearer gate-secret", { id: row.id });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: "done" });
      const again = await call("Bearer gate-secret", { id: row.id });
      expect(await again.json()).toEqual({ status: "gone" });
      await expectStopOutFollowUpExactlyOnce(w);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the route answers 503 while an auto-hedged leg waits for a price (the dispatcher backs off)", async () => {
    if (!ready) return;
    vi.stubEnv("POST_CLOSE_SECRET", "gate-secret");
    try {
      const w = await seedWorld();
      engineEvaluate(w.client);
      await prisma.livePrice.delete({ where: { symbol: w.symbolName } });
      const row = await closeRow(w);
      const res = await postCloseRoute(new NextRequest("http://localhost/api/internal/post-close", { method: "POST", headers: { authorization: "Bearer gate-secret" }, body: JSON.stringify({ id: row.id }) }));
      expect(res.status).toBe(503);
      expect((await res.json()).status).toBe("retry");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
