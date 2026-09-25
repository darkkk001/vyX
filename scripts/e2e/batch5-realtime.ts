// Batch 5 local end-to-end proof: scratch DB + local NATS + local gateway (:8090) + local web (:3100).
// Backoffice writes go through the real admin API; the trader side listens on the real gateway WebSocket.
// Run (local only; refuses any DB but the scratch one): nats-server -p 4299; gateway PORT=8090 NATS_URL=nats://127.0.0.1:4299
// REDIS_URL=redis://127.0.0.1:6379/9 on the scratch DB; next dev -p 3100 ROOT_DOMAIN=localhost:3100 GATEWAY_URL=http://127.0.0.1:8090; then
// NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json scripts/e2e/batch5-realtime.ts
import http from "node:http";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import WebSocket from "../../services/api-gateway/node_modules/ws/index.js";
import { Prisma, PrismaClient } from "@prisma/client";
import { effectiveAsk, spreadRuleFromPrice } from "@/lib/trade-api";
import { runSwapRollover } from "@/lib/swap-rollover";

if (!process.env.DATABASE_URL?.includes("127.0.0.1:5499")) throw new Error("scratch DB only");
const prisma = new PrismaClient();
const D = (v: string | number) => new Prisma.Decimal(v);
const sfx = randomUUID().replace(/-/g, "").slice(0, 8);
const HOST = `e2eb5${sfx}.localhost:3100`;
const results: { check: string; ok: boolean; detail: string }[] = [];
const rec = (check: string, ok: boolean, detail: string) => { results.push({ check, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${check}  -- ${detail}`); };

function req(method: string, path: string, body: unknown, cookie: string): Promise<{ status: number; json: any; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: 3100, method, path, headers: { host: HOST, "content-type": "application/json", cookie, ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(buf); } catch { json = buf.slice(0, 200); }
        resolve({ status: res.statusCode ?? 0, json, setCookie: (res.headers["set-cookie"] as string[]) ?? [] });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const cookieOf = (sc: string[]) => sc.map((c) => c.split(";")[0]).join("; ");

type Ev = { at: number; msg: any };
function stream(url: string, headers: Record<string, string>) {
  const events: Ev[] = [];
  const ws = new WebSocket(url, { headers });
  ws.on("message", (d) => { try { events.push({ at: Date.now(), msg: JSON.parse(String(d)) }); } catch {} });
  const open = new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); ws.on("unexpected-response", (_q, r) => rej(new Error(`ws ${r.statusCode}`))); });
  async function waitFor(pred: (m: any) => boolean, since: number, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const e = events.find((x) => x.at >= since && pred(x.msg));
      if (e) return e;
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  }
  return { ws, open, waitFor, events };
}

async function main() {
  // ---- seed (scratch DB only)
  const broker = await prisma.broker.create({ data: { name: `E2E B5 ${sfx}`, subdomain: `e2eb5${sfx}`, pricingEngineEnabled: true, dealingModeAt: null } });
  const sym = await prisma.symbol.create({ data: { name: `XE2E${sfx.toUpperCase()}`, baseCurrency: "XAU", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  const bs = await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D("4456.35"), ask: D("4456.53"), tickAt: new Date() } });
  const tickTimer = setInterval(() => { prisma.livePrice.update({ where: { symbol: sym.name }, data: { tickAt: new Date() } }).catch(() => {}); }, 1000);
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `Standard-${sfx}`, leverage: 100, dealingMode: "AUTO", isDefault: true } });
  const pw = await bcrypt.hash("E2e-pass-123", 10);
  const accNo = `8${Date.now().toString().slice(-7)}`;
  const acc = await prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: accNo, email: `e2e-${sfx}@test.local`, passwordHash: pw, fullName: "E2E Trader", accountMode: "LIVE", balance: D(1000000), leverage: 100 } });
  await prisma.adminUser.create({ data: { brokerId: broker.id, email: `e2e-admin-${sfx}@test.local`, passwordHash: pw, role: "BROKER_ADMIN" } });

  try {
    // ---- sign in both sides, open both live streams
    const tl = await req("POST", "/api/trade/login", { accountNumber: accNo, password: "E2e-pass-123" }, "");
    if (tl.status !== 200) throw new Error(`trader login ${tl.status} ${JSON.stringify(tl.json)}`);
    const traderCookie = cookieOf(tl.setCookie);
    const al = await req("POST", "/api/manage/login", { email: `e2e-admin-${sfx}@test.local`, password: "E2e-pass-123" }, "");
    if (al.status !== 200) throw new Error(`admin login ${al.status} ${JSON.stringify(al.json)}`);
    const adminCookie = cookieOf(al.setCookie);
    const ticket = (await req("POST", "/api/trade/ws-ticket", {}, traderCookie)).json.ticket;
    const trader = stream(`ws://127.0.0.1:8090/v1/trading/stream?ticket=${encodeURIComponent(ticket)}`, {});
    const admin = stream(`ws://127.0.0.1:8090/v1/events/stream`, { cookie: adminCookie });
    await Promise.all([trader.open, admin.open]);
    await new Promise((r) => setTimeout(r, 300));

    const prices = async () => (await req("GET", "/api/trade/prices", undefined, traderCookie)).json as any[];
    const buy = async (price: number, volume = "0.01") => req("POST", "/api/trade/orders", { symbol: sym.name, side: "BUY", type: "MARKET", volume, price: price.toFixed(2), idempotencyKey: randomUUID() }, traderCookie);
    async function change(label: string, method: string, path: string, body: unknown, scope: string) {
      const t0 = Date.now();
      const r = await req(method, path, body, adminCookie);
      const te = await trader.waitFor((m) => m.type === "ConfigChanged" && m.broker_id === broker.id && m.scope === scope, t0);
      const ae = await admin.waitFor((m) => m.type === "ConfigChanged" && m.broker_id === broker.id && m.scope === scope, t0);
      rec(`${label}: write accepted`, r.status === 200, `HTTP ${r.status}${r.status !== 200 ? " " + JSON.stringify(r.json) : ""}`);
      rec(`${label}: trader stream got ConfigChanged(${scope}) <= 1 s`, !!te && te.at - t0 <= 1000, te ? `${te.at - t0} ms from the click` : "not received in 3 s");
      rec(`${label}: backoffice stream got ConfigChanged(${scope}) <= 1 s`, !!ae && ae.at - t0 <= 1000, ae ? `${ae.at - t0} ms from the click` : "not received in 3 s");
    }
    async function quoteAndFill(label: string, expectBuy: number, expectPoints: number) {
      const row = (await prices()).find((p) => p.symbol === sym.name);
      const quoted = effectiveAsk({ [sym.name]: spreadRuleFromPrice(row) }, sym.name, Number(row.ask), Number(row.bid));
      const pts = Math.round((quoted - Number(row.bid)) * 100);
      rec(`${label}: quote`, Math.abs(quoted - expectBuy) < 1e-9 && pts === expectPoints, `buy ${quoted.toFixed(2)}, spread ${pts} points (rule ${row.spreadRule}${row.targetSpread ? " " + row.targetSpread : ""})`);
      const o = await buy(quoted);
      const fill = o.status === 201 ? Number((await prisma.position.findUniqueOrThrow({ where: { id: o.json.position.id } })).openPrice) : NaN;
      rec(`${label}: test fill = quote`, Math.abs(fill - quoted) < 1e-9, `fill ${fill} (HTTP ${o.status})`);
      return o;
    }

    const pricingPath = `/api/manage/groups/${group.id}/pricing`;
    // 1. markup (the Standard XAUUSD markup path)
    await change("markup 2 pips", "PATCH", pricingPath, { symbolId: sym.id, spreadMarkup: "2" }, "pricing");
    await quoteAndFill("markup 2 pips", 4456.73, 38);
    // 1b. target spread mode
    await change("target spread 3 pips", "PATCH", pricingPath, { symbolId: sym.id, targetTotalSpreadPips: "3" }, "pricing");
    await quoteAndFill("target spread 3 pips", 4456.65, 30);
    // 2. commission
    await change("commission 7/lot", "PATCH", pricingPath, { symbolId: sym.id, targetTotalSpreadPips: "3", commissionPerLot: "7" }, "pricing");
    const o = await quoteAndFill("commission 7/lot", 4456.65, 30);
    const com = await prisma.transaction.findFirst({ where: { accountId: acc.id, type: "COMMISSION" }, orderBy: { createdAt: "desc" } });
    rec("commission 7/lot: next fill charges it", !!com && Number(com.amount) === -0.07, `commission tx ${com?.amount?.toString()} on 0.01 lot (${o.status})`);
    // 3. swap
    await change("swap long -12.5", "PATCH", pricingPath, { symbolId: sym.id, targetTotalSpreadPips: "3", commissionPerLot: "7", swapLong: "-12.5", swapShort: "1" }, "pricing");
    await runSwapRollover(prisma as never, { isoWeekdayOverride: 2, accountIdsOverride: [acc.id] });
    const swaps = await prisma.transaction.findMany({ where: { accountId: acc.id, type: "SWAP" } });
    const openVol = (await prisma.position.findMany({ where: { accountId: acc.id, status: "OPEN" } })).reduce((a, p) => a + Number(p.volume), 0);
    const swapSum = swaps.reduce((a, t) => a + Number(t.amount), 0);
    rec("swap long -12.5: next rollover uses it", swaps.length > 0 && Math.abs(swapSum - -12.5 * openVol) < 1e-9, `swap booked ${swapSum} = -12.5 x ${openVol.toFixed(2)} open lots`);
    // 4. symbol disable
    const symBody = { symbolId: sym.id, enabled: false, minLot: "0.01", maxLot: "100", lotStep: "0.01", tradingMode: "BOTH", spreadMarkup: "0", commissionPerLot: "0", swapLong: "0", swapShort: "0" };
    await change("symbol disable", "PATCH", "/api/manage/symbols", symBody, "symbols");
    const listed = (await prices()).some((p) => p.symbol === sym.name);
    rec("symbol disable: gone from the quote list", !listed, listed ? "still listed" : "not listed");
    const od = await buy(4456.65);
    rec("symbol disable: test order refused", od.status >= 400, `HTTP ${od.status} ${JSON.stringify(od.json).slice(0, 120)}`);
    await change("symbol re-enable", "PATCH", "/api/manage/symbols", { ...symBody, enabled: true }, "symbols");
    // 5. trading halt (group)
    await change("trading halt", "PATCH", `/api/manage/groups/${group.id}/halt`, { halted: true }, "groups");
    const me = (await req("GET", "/api/trade/me", undefined, traderCookie)).json;
    rec("trading halt: /me tradingState", me.tradingState === "halted", `tradingState ${me.tradingState}`);
    const oh = await buy(4456.65);
    rec("trading halt: test order refused", oh.status >= 400, `HTTP ${oh.status} ${JSON.stringify(oh.json).slice(0, 120)}`);
    await change("trading halt lifted", "PATCH", `/api/manage/groups/${group.id}/halt`, { halted: false }, "groups");
    const me2 = (await req("GET", "/api/trade/me", undefined, traderCookie)).json;
    rec("trading halt lifted: /me tradingState", me2.tradingState === "open", `tradingState ${me2.tradingState}`);

    trader.ws.close();
    admin.ws.close();
  } finally {
    clearInterval(tickTimer);
    console.log(`\nfixture broker ${broker.id} (${HOST}), account ${accNo}, symbol ${sym.name}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${results.length - failed}/${results.length} checks passed`);
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
