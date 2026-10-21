// QoreBridge M5 end to end, on a LOCAL scratch database only (refuses anything but 127.0.0.1):
//
//   seed <runDir>   test broker (no real account anywhere), an A-book group routed to a filling LP, an A-book group
//                   routed to a rejecting LP, a B-book group, one LIVE test account per group, a staff user; writes
//                   <runDir>/state.json, qorebridge.toml, intake-schema.toml, sim-fill.toml, sim-reject.toml.
//   run <runDir>    with the web app, the gateway, NATS, both qb-sim LPs and the qorebridge binary running: places
//                   real orders over HTTP and checks every hop (intent in the fill transaction, NATS wake-up, LP
//                   fill, result row, intent DONE, the backoffice API, the escalation notice, B-book untouched).
//                   Writes <runDir>/report.json; exits non-zero on any failed check.
//
// npx tsx scripts/qorebridge/m5-e2e.ts seed|run <runDir>
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import bcrypt from "bcryptjs";
import { connect, StringCodec } from "nats";
import { Prisma, PrismaClient } from "@prisma/client";

for (const v of ["DATABASE_URL", "DIRECT_URL"]) {
  const u = process.env[v] ?? "";
  if (!/^postgres(ql)?:\/\/[^@]*@127\.0\.0\.1:\d+\//.test(u)) {
    console.error(`m5-e2e: ${v} must point at a local scratch database (127.0.0.1), got ${u ? u.replace(/:[^:@/]*@/, ":***@") : "nothing"}`);
    process.exit(2);
  }
}

const prisma = new PrismaClient();
const D = (v: string | number) => new Prisma.Decimal(v);
const PASSWORD = "m5-e2e-only";
const SIM_PRICE = "2400";
// the test broker answers on this host as its custom domain (Node cannot resolve <sub>.localhost on Windows); one
// E2E broker at a time owns it, an earlier run's broker gives it up at seed
const HOST = process.env.M5_HOST ?? "127.0.0.1";

type State = {
  web: string; // e.g. http://m5e2exxxx.localhost:3100
  brokerId: string;
  subdomain: string;
  symbol: string;
  lpFill: string;
  lpReject: string;
  accounts: { aBook: string; aReject: string; bBook: string };
  staffEmail: string;
};

async function seed(dir: string) {
  mkdirSync(dir, { recursive: true });
  const port = Number(process.env.M5_WEB_PORT ?? 3100);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const subdomain = `m5e2e${suffix}`;
  await prisma.broker.updateMany({ where: { customDomain: HOST }, data: { customDomain: null } });
  const broker = await prisma.broker.create({
    data: { name: `M5 E2E ${suffix}`, subdomain, customDomain: HOST, dealingModeAt: null, dealingDeskAutoFillAt: new Date(), requireAdmin2fa: false },
  });
  const staffEmail = `m5-staff-${suffix}@test.local`;
  await prisma.adminUser.create({ data: { brokerId: broker.id, email: staffEmail, passwordHash: await bcrypt.hash(PASSWORD, 10), role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
  await prisma.brokerSymbol.upsert({
    where: { brokerId_symbolId: { brokerId: broker.id, symbolId: symbol.id } },
    create: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true },
    update: {},
  });
  const group = (name: string, category: "A_BOOK" | "B_BOOK") =>
    prisma.group.create({ data: { brokerId: broker.id, name, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category, modeRestriction: category === "A_BOOK" ? "LIVE_ONLY" : "ANY", dealingMode: "AUTO", isClientSelectable: false } });
  const gA = await group("M5 A-Book Test", "A_BOOK");
  const gR = await group("M5 A-Book Reject Test", "A_BOOK");
  const gB = await group("M5 B-Book Test", "B_BOOK");
  const hash = await bcrypt.hash(PASSWORD, 10);
  // test accounts placed directly: the sign-up / placement guard keeps real clients out of A_BOOK groups
  const account = (groupId: string, n: string) =>
    prisma.account.create({ data: { groupId, brokerId: broker.id, accountNumber: `9${suffix.slice(0, 5)}${n}`, email: `m5-${suffix}-${n}@test.local`, passwordHash: hash, fullName: `M5 Test ${n}`, accountMode: "LIVE", leverage: 100, balance: D(100000) } });
  const aBook = await account(gA.id, "1");
  const aReject = await account(gR.id, "2");
  const bBook = await account(gB.id, "3");
  const lpFill = await prisma.liquidityProvider.create({ data: { brokerId: broker.id, name: "QB Sim LP", protocol: "FIX 4.4", status: "CONNECTED" } });
  const lpReject = await prisma.liquidityProvider.create({ data: { brokerId: broker.id, name: "QB Sim LP (rejects)", protocol: "FIX 4.4", status: "CONNECTED" } });
  await prisma.lpRoutingRule.create({ data: { brokerId: broker.id, liquidityProviderId: lpFill.id, groupId: gA.id, priority: 1 } });
  await prisma.lpRoutingRule.create({ data: { brokerId: broker.id, liquidityProviderId: lpReject.id, groupId: gR.id, priority: 1 } });

  const state: State = {
    web: `http://${HOST}:${port}`,
    brokerId: broker.id,
    subdomain,
    symbol: symbol.name,
    lpFill: lpFill.id,
    lpReject: lpReject.id,
    accounts: { aBook: aBook.accountNumber, aReject: aReject.accountNumber, bBook: bBook.accountNumber },
    staffEmail,
  };
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
  writeFileSync(path.join(dir, "lp.pw"), "m5-sim-only\n");
  const sim = (port: number, scenario: string) => `listen = "127.0.0.1:${port}"
comp_id = "QBSIM"

[sessions.QBM5]
username = "m5"
password = "m5-sim-only"
scenario = ${scenario}

[symbols.XAUUSD]
price = ${SIM_PRICE}.00
point = 0.01
`;
  writeFileSync(path.join(dir, "sim-fill.toml"), sim(19961, `{ kind = "slippage", points = 7 }`));
  writeFileSync(path.join(dir, "sim-reject.toml"), sim(19962, `{ kind = "reject", text = "no liquidity" }`));
  writeFileSync(path.join(dir, "intake-schema.toml"), readFileSync(process.env.M5_SCHEMA_FILE ?? "C:/vyx/qorebridge/config/intake-schema.vyxtrader.toml", "utf8"));
  const lp = (id: string, port: number) => `[[lp]]
id = "${id}"
host = "127.0.0.1"
port = ${port}
sender_comp_id = "QBM5"
target_comp_id = "QBSIM"
username = "m5"
password_file = "lp.pw"
tls = "off"
heartbeat_secs = 10
ack_timeout_ms = 1000
order_ttl_secs = 3
max_attempts = 2
`;
  const db = process.env.DATABASE_URL!;
  writeFileSync(
    path.join(dir, "qorebridge.toml"),
    `[instance]
name = "m5-e2e"
data_dir = "data"
[api]
bind = "127.0.0.1:18097"
[log]
dir = "logs"
level = "info"
[database]
url = "${db}"
[nats]
url = "${process.env.NATS_URL ?? "nats://127.0.0.1:14222"}"
[intake]
broker_id = "${broker.id}"
poll_ms = 1000
schema_file = "intake-schema.toml"

${lp(lpFill.id, 19961)}
${lp(lpReject.id, 19962)}`
  );
  console.log(JSON.stringify(state, null, 2));
}

// --- run -----------------------------------------------------------------------------------------------------------

// the parts of the answers the checks read (anything else is ignored; a non-JSON body arrives as its text)
type OrderAnswer = { position?: { id: string } };
type HedgeRow = { id: string; kind: string; side: string; volume: string; outcome: string; lpPrice: string | null; slippage: string | null; providers: string[] };
type HedgesAnswer = { hedges?: HedgeRow[]; unhedged?: boolean; exposure?: unknown };

function request<T = unknown>(state: State, method: string, p: string, body?: unknown, cookie?: string): Promise<{ status: number; json: T | undefined; cookie: string }> {
  const u = new URL(state.web + p);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method, headers: { host: u.host, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          const set = (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
          let json: T | undefined;
          try {
            json = JSON.parse(text) as T;
          } catch {
            json = text.slice(0, 300) as T;
          }
          resolve({ status: res.statusCode ?? 0, json, cookie: set });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
}

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) {
      console.log(`  timed out waiting for ${what}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function freshPrice(symbol: string) {
  await prisma.livePrice.upsert({
    where: { symbol },
    create: { symbol, bid: D("2399.90"), ask: D("2400.10"), tickAt: new Date() },
    update: { bid: D("2399.90"), ask: D("2400.10"), tickAt: new Date() },
  });
}

async function run(dir: string) {
  const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as State;
  const nc = await connect({ servers: process.env.NATS_URL ?? "nats://127.0.0.1:14222" });
  try {
    await runChecks(dir, state, nc);
  } finally {
    // an open subscription keeps the process alive: always close it, failed run or not
    await nc.drain();
  }
}

async function runChecks(dir: string, state: State, nc: Awaited<ReturnType<typeof connect>>) {
  const sc = StringCodec();
  const seen: { subject: string; at: number; data: string }[] = [];
  for (const s of [`bridge.intent.${state.brokerId}`, `bridge.result.${state.brokerId}`]) {
    const sub = nc.subscribe(s);
    void (async () => {
      for await (const m of sub) seen.push({ subject: m.subject, at: Date.now(), data: sc.decode(m.data) });
    })();
  }

  const login = async (accountNumber: string) => {
    const r = await request(state, "POST", "/api/trade/login", { accountNumber, password: PASSWORD, accountMode: "LIVE" });
    // the web app caches host -> broker for 5 minutes: after a new seed, restart it (or wait) before this step
    if (r.status !== 200) throw new Error(`trader login ${accountNumber}: ${r.status} ${JSON.stringify(r.json)} (restart the web app after a new seed)`);
    return r.cookie;
  };
  const order = async (cookie: string, side: "BUY" | "SELL", volume: string) => {
    await freshPrice(state.symbol);
    return request<OrderAnswer>(state, "POST", "/api/trade/orders", { symbol: state.symbol, side, type: "MARKET", volume, price: side === "BUY" ? "2400.10" : "2399.90", idempotencyKey: `m5:${randomUUID()}` }, cookie);
  };
  const intentsOf = (positionId: string) => prisma.hedgeIntent.findMany({ where: { positionId }, orderBy: { seq: "asc" } });

  // 1. A-book order: filled for the client at once, intent in the same transaction
  const aCookie = await login(state.accounts.aBook);
  const t0 = Date.now();
  const o1 = await order(aCookie, "BUY", "0.10");
  const orderMs = Date.now() - t0;
  check("A-book market order fills for the client (no LP in the way)", o1.status === 201, { status: o1.status, ms: orderMs });
  const posId = o1.json?.position?.id ?? "";
  const [open] = await intentsOf(posId);
  check("OPEN intent written with the fill (same transaction, visible at once)", !!open && open.kind === "OPEN" && open.side === "BUY" && open.volume.toString() === "0.1", open && { id: open.id, status: open.status });
  const nudged = await waitFor("bridge.intent nudge", async () => seen.find((s) => s.subject === `bridge.intent.${state.brokerId}`));
  check("NATS bridge.intent.<broker> nudge published after commit (via the gateway)", !!nudged, nudged && { msAfterOrder: nudged.at - t0 });
  const done = await waitFor("OPEN intent DONE", async () => {
    const i = await prisma.hedgeIntent.findUnique({ where: { id: open.id } });
    return i?.status === "DONE" ? i : null;
  });
  const doneMs = Date.now() - t0;
  const legs1 = await prisma.hedgeResult.findMany({ where: { intentId: open.id } });
  check("QoreBridge hedged it at the LP: result FILLED, intent DONE", !!done && legs1.length === 1 && legs1[0].status === "FILLED" && legs1[0].filledVolume.toString() === "0.1", {
    msFromOrder: doneMs,
    leg: legs1[0] && { lp: legs1[0].liquidityProviderId === state.lpFill ? "QB Sim LP" : legs1[0].liquidityProviderId, avgPrice: legs1[0].avgPrice.toString(), lpOrderIds: legs1[0].lpOrderIds },
  });
  const resultNudge = await waitFor("bridge.result nudge", async () => seen.find((s) => s.subject === `bridge.result.${state.brokerId}`), 5000);
  check("NATS bridge.result.<broker> published after the result commit", !!resultNudge, resultNudge && JSON.parse(resultNudge.data).type);

  // 2. close: hedge-reduce
  await freshPrice(state.symbol);
  const c1 = await request(state, "POST", `/api/trade/positions/${posId}/close`, { closePrice: "2399.90", maxSlippagePips: "500" }, aCookie);
  check("client close succeeds", c1.status === 200, { status: c1.status });
  const close = await waitFor("CLOSE intent DONE", async () => {
    const all = await intentsOf(posId);
    const c = all.find((i) => i.kind === "CLOSE");
    return c && c.status === "DONE" ? c : null;
  });
  const legs2 = close ? await prisma.hedgeResult.findMany({ where: { intentId: close.id } }) : [];
  check("CLOSE intent (SELL 0.1) hedged at the LP", !!close && close.side === "SELL" && legs2[0]?.status === "FILLED", close && { side: close.side, volume: close.volume.toString() });

  // 3. B-book: same flow, nothing for the bridge
  const bCookie = await login(state.accounts.bBook);
  const ob = await order(bCookie, "BUY", "0.10");
  const bPos = ob.json?.position?.id ?? "";
  await request(state, "POST", `/api/trade/positions/${bPos}/close`, { closePrice: "2399.90", maxSlippagePips: "500" }, bCookie);
  const bIntents = await prisma.hedgeIntent.count({ where: { positionId: bPos } });
  const bDeals = await prisma.deal.count({ where: { positionId: bPos } });
  check("B-book order + close: zero hedge intents, deals as always (IN + OUT)", ob.status === 201 && bIntents === 0 && bDeals === 2, { order: ob.status, intents: bIntents, deals: bDeals });

  // 4. escalation: the rejecting LP
  const rCookie = await login(state.accounts.aReject);
  const or = await order(rCookie, "BUY", "0.20");
  const rPos = or.json?.position?.id ?? "";
  check("A-book order on the rejecting LP's group still fills for the client", or.status === 201, { status: or.status });
  const esc = await waitFor(
    "escalated result",
    async () => {
      const [i] = await intentsOf(rPos);
      if (!i || i.status !== "DONE") return null;
      const [l] = await prisma.hedgeResult.findMany({ where: { intentId: i.id } });
      return l?.status === "ESCALATED" ? l : null;
    },
    30000
  );
  check("LP rejects every retry: leg ESCALATED, intent DONE (the client stays filled)", !!esc, esc && { attempts: esc.attempts, reason: esc.reason });
  const notice = await prisma.notification.findFirst({ where: { brokerId: state.brokerId, type: "HEDGE_ESCALATED" } });
  check("dealer notification fired, in plain words", !!notice && !/FIX|ClOrdID|qb-|bridge/i.test(notice.body), notice && { title: notice.title, body: notice.body });

  // 5. the backoffice view
  const staff = await request(state, "POST", "/api/manage/login", { email: state.staffEmail, password: PASSWORD });
  check("staff login", staff.status === 200, { status: staff.status, body: staff.status === 200 ? undefined : staff.json });
  const view = await request<HedgesAnswer>(state, "GET", "/api/manage/hedges", undefined, staff.cookie);
  const hedges: HedgeRow[] = view.json?.hedges ?? [];
  const outcome = (id: string | undefined) => hedges.find((h) => h.id === id)?.outcome;
  check("backoffice API lists the hedges with plain outcomes", view.status === 200 && outcome(open?.id) === "HEDGED" && outcome(close?.id) === "HEDGED" && hedges.some((h) => h.outcome === "NOT_HEDGED"), {
    status: view.status,
    outcomes: hedges.map((h) => `${h.kind} ${h.side} ${h.volume} ${h.outcome}${h.lpPrice ? ` @${h.lpPrice} slip ${h.slippage}` : ""} [${h.providers.join(",")}]`),
  });
  check("UNHEDGED EXPOSURE on: the rejected 0.2 lots", view.json?.unhedged === true && JSON.stringify(view.json?.exposure ?? []).includes('"unhedgedLots":"0.2"'), view.json?.exposure);

  const failed = checks.filter((c) => !c.ok);
  writeFileSync(path.join(dir, "report.json"), JSON.stringify({ at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks, natsSeen: seen }, null, 2));
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

const [cmd, dir] = process.argv.slice(2);
(cmd === "seed" ? seed(dir) : cmd === "run" ? run(dir) : Promise.reject(new Error("usage: m5-e2e.ts seed|run <runDir>")))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
