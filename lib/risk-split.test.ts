// Rust cutover Stage 6: the WEB side of the risk-authority split, every combination, against real rows on the local scratch DB.
//
//   broker WEB                         -> the web acts on every account
//   broker RUST + demo-only (default)  -> the web acts on its LIVE accounts only
//   broker RUST + all accounts         -> the web acts on none
//
// Each broker holds a DEMO and a LIVE account in each of three situations the risk path acts on: a stop-out (level under the
// stop-out), an SL touch, a margin call (a notice, no close). The web evaluator runs over ALL of them, as the margin-monitor
// route does; what it did to each account is compared with riskOwnerOf and with the risk action trace (VYX_RISK_ACTION_TRACE):
// every web action is on an account the rule gives to WEB, and every account the rule gives to WEB was acted on.
// The handoff (a flip between the prefilter and the write) is in risk-split-stale.test.ts; the engine's half is
// engine/order-management/tests/risk_split_db.rs, and the two together are scripts/load/run.sh --split.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn(async () => {}) };
});

import { prisma } from "@/lib/prisma";
import { evaluateAccountRisk, evaluateAccountsRisk } from "@/lib/risk-monitor";
import { evaluatePendingTriggers, triggerPendingOrder } from "@/lib/pending-trigger";
import { riskOwnerOf, type RiskOwner } from "@/lib/risk-authority";
import { loadRiskOwners } from "@/lib/risk-owner";

const D = (v: number | string) => new Prisma.Decimal(v);
const brokers: string[] = [];
const symbols: string[] = [];
let seq = 0;

type Authority = { riskAuthority: "WEB" | "RUST"; riskAuthorityDemoOnly: boolean };
const COMBINATIONS: { name: string; broker: Authority }[] = [
  { name: "WEB broker", broker: { riskAuthority: "WEB", riskAuthorityDemoOnly: true } },
  { name: "WEB broker, demo-only off (the flag alone changes nothing)", broker: { riskAuthority: "WEB", riskAuthorityDemoOnly: false } },
  { name: "RUST + demo-only", broker: { riskAuthority: "RUST", riskAuthorityDemoOnly: true } },
  { name: "RUST + all accounts", broker: { riskAuthority: "RUST", riskAuthorityDemoOnly: false } },
];

type Acct = { id: string; mode: "DEMO" | "LIVE"; kind: "SO" | "SL" | "MC"; positionId: string };
type World = { brokerId: string; groupId: string; symbolId: string; symbol: string; accounts: Acct[] };

/** A broker with a DEMO and a LIVE account in each of the three situations, the price already at 90. */
async function world(authority: Authority): Promise<World> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `split ${sfx}`, subdomain: `zsplit-${sfx}`, ...authority } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `ZS${sfx.toUpperCase()}`, baseCurrency: "ZSP", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D(90), ask: D(90), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `ZS-${sfx}`, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50), dealingMode: "AUTO", groupType: "DEALING" } });
  const accounts: Acct[] = [];
  for (const mode of ["DEMO", "LIVE"] as const) {
    for (const kind of ["SO", "SL", "MC"] as const) {
      seq++;
      // leverage 1, contract 1: margin = price. SO: equity 20 - 10 = 10 on 90 = 11 % (under 50). MC: 80 - 10 = 70 on 90 = 77.8 % (50..100).
      // SL: a rich account, the stop loss at 95 is touched by a close price of 90
      const balance = kind === "SO" ? 20 : kind === "MC" ? 80 : 100000;
      const a = await prisma.account.create({
        data: { brokerId: b.id, groupId: g.id, accountNumber: `7${String(Date.now() % 1000000).padStart(6, "0")}${seq}`.slice(0, 12), email: `zs${seq}-${sfx}@x.local`, passwordHash: "x", fullName: `${mode} ${kind}`, accountMode: mode, leverage: 1, balance: D(balance) },
      });
      const order = await prisma.order.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `zs-${a.id}` } });
      const p = await prisma.position.create({
        data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100), slPrice: kind === "SL" ? D(95) : null },
      });
      accounts.push({ id: a.id, mode, kind, positionId: p.id });
    }
  }
  return { brokerId: b.id, groupId: g.id, symbolId: sym.id, symbol: sym.name, accounts };
}

const ownerOf = (authority: Authority, mode: "DEMO" | "LIVE"): RiskOwner => riskOwnerOf(authority, mode);

async function stateOf(a: Acct) {
  const position = await prisma.position.findUniqueOrThrow({ where: { id: a.positionId } });
  const account = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
  return { closed: position.status === "CLOSED", marginCallFlag: account.marginCallNotifiedAt != null };
}

let traceFile = "";
function readTrace(): { actor: string; kind: string; accountId: string; ref: string }[] {
  if (!fs.existsSync(traceFile)) return [];
  return fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(() => {
  traceFile = path.join(os.tmpdir(), `risk-split-web-${randomUUID()}.jsonl`);
  process.env.VYX_RISK_ACTION_TRACE = traceFile;
});

afterAll(async () => {
  delete process.env.VYX_RISK_ACTION_TRACE;
  fs.rmSync(traceFile, { force: true });
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.postCloseEffect.deleteMany({ where }).catch(() => {});
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.updateMany({ where, data: { coveragePositionId: null, closePendingOrderId: null } });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60_000);

describe("the web acts on exactly the accounts the rule gives it, in every combination", () => {
  for (const combo of COMBINATIONS) {
    it(`${combo.name}: batch evaluation (the margin-monitor / hook / backstop shape)`, async () => {
      const w = await world(combo.broker);
      const owners = await loadRiskOwners(prisma, w.accounts.map((a) => a.id));
      for (const a of w.accounts) expect(owners.get(a.id), `${a.mode} ${a.kind}`).toBe(ownerOf(combo.broker, a.mode));

      const before = readTrace().length;
      const errors = await evaluateAccountsRisk(w.accounts.map((a) => a.id), "split test");
      expect(errors).toBe(0);

      for (const a of w.accounts) {
        const s = await stateOf(a);
        const webOwns = ownerOf(combo.broker, a.mode) === "WEB";
        if (a.kind === "MC") {
          expect(s.closed, `${a.mode} MC closed`).toBe(false);
          expect(s.marginCallFlag, `${a.mode} MC notice (web owns: ${webOwns})`).toBe(webOwns);
          expect(await prisma.notification.count({ where: { entityId: a.id, type: "MARGIN_CALL" } }), `${a.mode} MC notification rows`).toBe(webOwns ? 2 : 0);
        } else {
          expect(s.closed, `${a.mode} ${a.kind} closed (web owns: ${webOwns})`).toBe(webOwns);
          expect(await prisma.transaction.count({ where: { accountId: a.id, type: "TRADE_PNL" } }), `${a.mode} ${a.kind} TRADE_PNL rows`).toBe(webOwns ? 1 : 0);
        }
      }

      // every WEB action is on an account the rule gives to WEB; every account the rule gives to WEB was acted on
      const mine = readTrace().slice(before).filter((t) => w.accounts.some((a) => a.id === t.accountId));
      expect(mine.every((t) => t.actor === "WEB")).toBe(true);
      const acted = new Set(mine.map((t) => t.accountId));
      for (const a of w.accounts) expect(acted.has(a.id), `${a.mode} ${a.kind} acted on`).toBe(ownerOf(combo.broker, a.mode) === "WEB");
    }, 60_000);

    it(`${combo.name}: the single-account entry (evaluateAccountRisk) answers the same`, async () => {
      const w = await world(combo.broker);
      for (const a of w.accounts) {
        const r = await evaluateAccountRisk(a.id);
        const webOwns = ownerOf(combo.broker, a.mode) === "WEB";
        // an account the engine owns is not evaluated at all, not even the "nothing to do" evaluation
        expect(r.evaluated, `${a.mode} ${a.kind} evaluated`).toBe(webOwns);
        expect(r.slTpClosed.length + r.stopOutClosed.length, `${a.mode} ${a.kind} closes`).toBe(webOwns && a.kind !== "MC" ? 1 : 0);
      }
    }, 60_000);
  }
});

describe("resting orders: the web's sweeps skip engine-owned accounts, the RUST scope fills only those", () => {
  it("RUST + demo-only: the WEB scope fills the LIVE account's order, the RUST scope the DEMO account's, never the other way", async () => {
    const authority: Authority = { riskAuthority: "RUST", riskAuthorityDemoOnly: true };
    const w = await world(authority);
    const demo = w.accounts.find((a) => a.mode === "DEMO" && a.kind === "SL")!;
    const live = w.accounts.find((a) => a.mode === "LIVE" && a.kind === "SL")!;
    // a BUY LIMIT at 95 on a 90 / 90 market: reached, fillable (rich accounts)
    const mk = (accountId: string) =>
      prisma.order.create({ data: { brokerId: w.brokerId, accountId, symbolId: w.symbolId, side: "BUY", type: "LIMIT", volume: D(1), requestedPrice: D(95), idempotencyKey: `zs-pend-${randomUUID()}`, status: "PENDING" } });
    const [oDemo, oLive] = [await mk(demo.id), await mk(live.id)];

    const web = await evaluatePendingTriggers([w.symbol], "WEB");
    expect(web.checked).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: oLive.id } })).status).toBe("FILLED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: oDemo.id } })).status, "the engine's account is not the web's").toBe("PENDING");

    const rust = await evaluatePendingTriggers([w.symbol], "RUST");
    expect(rust.checked).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: oDemo.id } })).status).toBe("FILLED");
    // the scopes are disjoint: a second pass of either finds nothing left
    expect((await evaluatePendingTriggers([w.symbol], "WEB")).checked).toBe(0);
    expect((await evaluatePendingTriggers([w.symbol], "RUST")).checked).toBe(0);
  }, 60_000);

  it("a server trigger run as the wrong side claims nothing (the claim re-checks the owner inside its transaction)", async () => {
    const authority: Authority = { riskAuthority: "RUST", riskAuthorityDemoOnly: false };
    const w = await world(authority);
    const demo = w.accounts.find((a) => a.mode === "DEMO" && a.kind === "SL")!;
    const o = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: demo.id, symbolId: w.symbolId, side: "BUY", type: "LIMIT", volume: D(1), requestedPrice: D(95), idempotencyKey: `zs-pend-${randomUUID()}`, status: "PENDING" } });
    const asWeb = await triggerPendingOrder(o.id, "90", "server", "WEB");
    expect(asWeb.kind).toBe("skipped");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PENDING");
    const asRust = await triggerPendingOrder(o.id, "90", "server", "RUST");
    expect(asRust.kind).toBe("filled");
  }, 60_000);
});
