// Rust cutover Stage 6: lib/risk-owner.ts against real rows -- the owner lookup in every combination, and the property the
// whole handoff rests on: a flip of Broker.riskAuthority WAITS for every transaction that has checked the owner (the
// FOR SHARE lock) and is seen by every transaction that starts after it commits. So an acting transaction and a flip
// are totally ordered: there is no instant at which both sides can pass their check.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertRiskActorInTx, loadRiskOwners, NotRiskOwnerError, webOwnedAccountIds } from "@/lib/risk-owner";

const D = (v: number | string) => new Prisma.Decimal(v);
const brokers: string[] = [];
let seq = 0;

async function broker(riskAuthority: "WEB" | "RUST", riskAuthorityDemoOnly: boolean) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `owner ${sfx}`, subdomain: `zowner-${sfx}`, riskAuthority, riskAuthorityDemoOnly } });
  brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `ZO-${sfx}` } });
  const acct = async (mode: "DEMO" | "LIVE") => {
    seq++;
    return prisma.account.create({
      data: { brokerId: b.id, groupId: g.id, accountNumber: `7${String(Date.now() % 1000000).padStart(6, "0")}${seq}`.slice(0, 12), email: `zo${seq}-${sfx}@x.local`, passwordHash: "x", fullName: mode, accountMode: mode, balance: D(1000) },
    });
  };
  return { id: b.id, demo: await acct("DEMO"), live: await acct("LIVE") };
}

afterAll(async () => {
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.account.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.$disconnect();
}, 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(25);
  }
  return false;
}

describe("loadRiskOwners / webOwnedAccountIds", () => {
  it("answers the rule for DEMO and LIVE accounts of WEB, RUST demo-only and RUST all brokers", async () => {
    const web = await broker("WEB", true);
    const demoOnly = await broker("RUST", true);
    const all = await broker("RUST", false);
    const ids = [web.demo.id, web.live.id, demoOnly.demo.id, demoOnly.live.id, all.demo.id, all.live.id];
    const o = await loadRiskOwners(prisma, ids);
    expect([...ids.map((id) => o.get(id))]).toEqual(["WEB", "WEB", "RUST", "WEB", "RUST", "RUST"]);
    expect(await webOwnedAccountIds(prisma, ids)).toEqual([web.demo.id, web.live.id, demoOnly.live.id]);
    // an account that does not exist is not in the map and is kept by webOwnedAccountIds (the evaluators treat it as nothing to do)
    expect((await loadRiskOwners(prisma, ["nope"])).has("nope")).toBe(false);
    expect(await webOwnedAccountIds(prisma, ["nope"])).toEqual(["nope"]);
  });
});

describe("assertRiskActorInTx", () => {
  it("passes for the owner and throws NotRiskOwnerError for the other side", async () => {
    const demoOnly = await broker("RUST", true);
    await prisma.$transaction(async (tx) => {
      await assertRiskActorInTx(tx, demoOnly.demo.id, "RUST");
      await assertRiskActorInTx(tx, demoOnly.live.id, "WEB");
    });
    await expect(prisma.$transaction((tx) => assertRiskActorInTx(tx, demoOnly.demo.id, "WEB"))).rejects.toBeInstanceOf(NotRiskOwnerError);
    await expect(prisma.$transaction((tx) => assertRiskActorInTx(tx, demoOnly.live.id, "RUST"))).rejects.toBeInstanceOf(NotRiskOwnerError);
  });

  it("a flip waits for a transaction that already checked, and the next check sees it: the two are totally ordered", async () => {
    const b = await broker("WEB", true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let checked!: () => void;
    const hasChecked = new Promise<void>((r) => (checked = r));
    // the WEB acts: it checks the owner (WEB) and then holds its transaction open
    const acting = prisma.$transaction(
      async (tx) => {
        await assertRiskActorInTx(tx, b.live.id, "WEB");
        checked();
        await gate;
        return "acted";
      },
      { timeout: 30_000 }
    );
    await hasChecked;
    // the flip arrives while it is open
    let flipped = false;
    const flip = prisma.broker.update({ where: { id: b.id }, data: { riskAuthority: "RUST", riskAuthorityDemoOnly: false } }).then(() => (flipped = true));
    const waiting = await waitFor(async () => {
      const r = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE%Broker%' AND query NOT ILIKE '%pg_stat_activity%'`;
      return Number(r[0].n) > 0;
    });
    expect(waiting, "the flip is blocked on the acting transaction's FOR SHARE lock").toBe(true);
    expect(flipped).toBe(false);
    release();
    expect(await acting).toBe("acted");
    await flip;
    expect(flipped).toBe(true);
    // after the flip, the web's check refuses and the engine's passes
    await expect(prisma.$transaction((tx) => assertRiskActorInTx(tx, b.live.id, "WEB"))).rejects.toBeInstanceOf(NotRiskOwnerError);
    await prisma.$transaction((tx) => assertRiskActorInTx(tx, b.live.id, "RUST"));
  }, 60_000);

  it("a flip back to WEB: the engine's in-flight check finishes first, the web's next check passes", async () => {
    const b = await broker("RUST", false);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let checked!: () => void;
    const hasChecked = new Promise<void>((r) => (checked = r));
    const acting = prisma.$transaction(
      async (tx) => {
        await assertRiskActorInTx(tx, b.demo.id, "RUST");
        checked();
        await gate;
      },
      { timeout: 30_000 }
    );
    await hasChecked;
    const flip = prisma.broker.update({ where: { id: b.id }, data: { riskAuthority: "WEB" } });
    await sleep(300);
    release();
    await acting;
    await flip;
    await prisma.$transaction((tx) => assertRiskActorInTx(tx, b.demo.id, "WEB"));
    await expect(prisma.$transaction((tx) => assertRiskActorInTx(tx, b.demo.id, "RUST"))).rejects.toBeInstanceOf(NotRiskOwnerError);
  }, 60_000);

  it("an account mode change waits for the acting transaction too (the account row lock)", async () => {
    const b = await broker("RUST", true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let checked!: () => void;
    const hasChecked = new Promise<void>((r) => (checked = r));
    const acting = prisma.$transaction(
      async (tx) => {
        await assertRiskActorInTx(tx, b.demo.id, "RUST");
        checked();
        await gate;
      },
      { timeout: 30_000 }
    );
    await hasChecked;
    let changed = false;
    const change = prisma.account.update({ where: { id: b.demo.id }, data: { accountMode: "LIVE" } }).then(() => (changed = true));
    await sleep(400);
    expect(changed, "the mode change is blocked while the engine's transaction is open").toBe(false);
    release();
    await acting;
    await change;
    // the DEMO account of a demo-only broker became LIVE: now it is the web's
    await prisma.$transaction((tx) => assertRiskActorInTx(tx, b.demo.id, "WEB"));
  }, 60_000);
});
