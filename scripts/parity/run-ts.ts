// Stage 0 parity harness -- TS side. Seeds every engine/parity/scenarios/*.json into the LOCAL
// scratch database vyx_rust_harness, runs the real production evaluation (lib/risk-monitor.ts
// evaluateAccountRisk, the same function the margin-monitor cron and the price-feed tick path call)
// and writes engine/parity/out/ts/<scenario>.json.
//
// Run from the repo root:
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_rust_harness \
//   DIRECT_URL=postgresql://postgres@127.0.0.1:5499/vyx_rust_harness \
//   npx tsx --conditions=react-server scripts/parity/run-ts.ts [scenario-name-filter]
//
// --conditions=react-server resolves `import "server-only"` to its no-op entry (the same thing
// vitest.config.mts does with its alias), so the libs run unmodified.
//
// Safety: refuses to run unless DATABASE_URL and DIRECT_URL are exactly the scratch DB below, and
// re-checks the connected server's port + database name before the first write. Every other
// outbound path the risk monitor has is pinned local-only here, BEFORE any lib is imported:
//   MARKET_DATA_PRICES=""  -> lib/live-price.ts reads LivePrice from this DB, never the VPS engine
//   GATEWAY_URL=127.0.0.1:9 -> lib/nats.ts publishTradingEvent fails fast (discard port), no gateway
import fs from "node:fs";
import path from "node:path";

const HARNESS_URL = "postgresql://postgres@127.0.0.1:5499/vyx_rust_harness";
for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  if (process.env[name] !== HARNESS_URL) {
    console.error(`[parity] refusing to run: ${name} must be exactly ${HARNESS_URL} (got ${process.env[name] ? "something else" : "unset"}).`);
    process.exit(2);
  }
}
process.env.MARKET_DATA_PRICES = "";
process.env.MARKET_DATA_URL = "";
process.env.TRADING_CORE_URL = "";
process.env.GATEWAY_URL = "http://127.0.0.1:9";
process.env.INTERNAL_SERVICE_SECRET = "";
// Belt and braces: no network at all from this process. Gateway event publishes (lib/nats.ts,
// best-effort by design) are answered 204 locally and counted; anything else is refused loudly.
const suppressedEvents: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1:9/internal/events")) {
    suppressedEvents.push(url);
    return new Response(null, { status: 204 });
  }
  throw new Error(`[parity] unexpected outbound fetch blocked: ${url}`);
}) as typeof fetch;

type Dec = string;
type Scenario = {
  name: string;
  why: string;
  knownDivergence: { id: string; fields: string[]; note?: string }[];
  broker: { negativeBalanceProtection: boolean };
  groups: { key: string; marginCallLevel: Dec; stopOutLevel: Dec }[];
  // coverage: this account is the broker's coverage account (Broker.coverageAccountId), Stage 4.5
  accounts: { key: string; group: string; balance: Dec; credit: Dec; leverage: number; coverage?: boolean }[];
  symbols: { name: string; contractSize: Dec; digits: number; quoteCurrency: string; category?: string; sessionClosedNow?: boolean; hedgedMarginPct?: Dec }[];
  // coverageLeg: this (client) position is hedged by that leg (covered + coveragePositionId); autoHedged: this
  // leg was opened by auto-hedge, so the platform closes it when the client closes (lib/coverage.ts onClose)
  positions: { key: string; account: string; symbol: string; side: "BUY" | "SELL"; volume: Dec; openPrice: Dec; slPrice?: Dec | null; tpPrice?: Dec | null; coverageLeg?: string; autoHedged?: boolean }[];
  prices: { symbol: string; bid: Dec; ask: Dec; ageSeconds: number; updatedAgeSeconds?: number }[];
  // Stage 4.5: mirror rules onto a master account, with their source -> target position links
  mirrors?: { key: string; master: string; fillPriceMode?: "SOURCE_PRICE" | "MARKET"; links: { source: string; target: string }[] }[];
  dbOnly?: boolean;
};

type PositionState = { status: string; volume: string; closePrice: string | null; realizedPnl: string | null };

type AccountOutcome = {
  marginLevelBefore: string | null;
  closedPositionIds: string[];
  closeReasons: string[];
  finalBalance: string;
  finalCredit: string;
  transactions: { type: string; amount: string }[];
  marginCallNotified: boolean;
};

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scenarioDir = path.join(repoRoot, "engine", "parity", "scenarios");
const outDir = path.join(repoRoot, "engine", "parity", "out", "ts");

async function main() {
  const { Prisma } = await import("@prisma/client");
  const { prisma } = await import("@/lib/prisma");
  const { evaluateAccountRisk, accountMarginLevel } = await import("@/lib/risk-monitor");
  const D = (v: string | number) => new Prisma.Decimal(v);

  const [where] = await prisma.$queryRaw<{ db: string; port: number }[]>`SELECT current_database() AS db, inet_server_port() AS port`;
  if (where.db !== "vyx_rust_harness" || Number(where.port) !== 5499) {
    throw new Error(`[parity] connected to ${where.db}:${where.port}, expected vyx_rust_harness:5499 -- aborting before any write`);
  }

  const filter = process.argv[2];
  const files = fs.readdirSync(scenarioDir).filter((f) => f.endsWith(".json") && (!filter || f.includes(filter))).sort();
  fs.mkdirSync(outDir, { recursive: true });
  // PARITY_SEED_ONLY=1 (Stage 1 DB mode, scripts/parity/run-db.sh): seed exactly one scenario and stop, leaving
  // it in the database for the engine's real monitor (`cargo run -p parity -- --db <scenario>`) to evaluate.
  const seedOnly = process.env.PARITY_SEED_ONLY === "1";
  if (seedOnly && files.length !== 1) throw new Error(`[parity] PARITY_SEED_ONLY needs a filter matching exactly one scenario (got ${files.length})`);

  async function wipe() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${t.tablename}"`).join(", ");
    await prisma.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
  }

  // Web-side margin level at the start of the evaluation, before any close: lib/risk-monitor.ts's own
  // accountMarginLevel, i.e. exactly the measure its stop-out / margin-call passes decide on (usable prices
  // only: tickAt freshness, trading sessions, fx rates).
  async function webMarginLevel(accountId: string): Promise<string | null> {
    return (await accountMarginLevel(accountId))?.toString() ?? null;
  }

  for (const file of files) {
    const sc: Scenario = JSON.parse(fs.readFileSync(path.join(scenarioDir, file), "utf8"));
    await wipe();

    const broker = await prisma.broker.create({ data: { name: `Parity ${sc.name}`, subdomain: `parity-${sc.name}`.slice(0, 60), negativeBalanceProtection: sc.broker.negativeBalanceProtection } });
    const groupIds = new Map<string, string>();
    for (const [i, g] of sc.groups.entries()) {
      const row = await prisma.group.create({ data: { brokerId: broker.id, name: g.key, isDefault: i === 0, marginCallLevel: D(g.marginCallLevel), stopOutLevel: D(g.stopOutLevel) } });
      groupIds.set(g.key, row.id);
    }
    for (const [i, a] of sc.accounts.entries()) {
      await prisma.account.create({
        data: {
          id: a.key, brokerId: broker.id, accountNumber: `9${String(i + 1).padStart(7, "0")}`, email: `${a.key}@parity.local`, passwordHash: "x", fullName: `Parity ${a.key}`,
          accountMode: "LIVE", leverage: a.leverage, balance: D(a.balance), credit: D(a.credit), groupId: groupIds.get(a.group)!,
        },
      });
    }
    const symbolIds = new Map<string, string>();
    for (const s of sc.symbols) {
      // Default CRYPTO = continuously traded (lib/risk.ts checkTradingSession), so a result never depends on
      // the weekday/hour the harness runs at. A scenario that tests the session gate sets `category` and
      // `sessionClosedNow`: the BrokerSymbol then gets one configured session on a DIFFERENT weekday, which
      // makes the market closed right now whatever the time (Stage 2 F4).
      const row = await prisma.symbol.create({ data: { name: s.name, baseCurrency: s.name.slice(0, 3), quoteCurrency: s.quoteCurrency, digits: s.digits, contractSize: D(s.contractSize), category: (s.category ?? "CRYPTO") as never } });
      const bs = await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: row.id, ...(s.hedgedMarginPct != null ? { hedgedMarginPct: D(s.hedgedMarginPct) } : {}) } });
      if (s.sessionClosedNow) {
        const otherDay = (new Date().getUTCDay() + 3) % 7;
        await prisma.tradingSession.create({ data: { brokerSymbolId: bs.id, dayOfWeek: otherDay, openTime: "00:00", closeTime: "23:59" } });
      }
      symbolIds.set(s.name, row.id);
    }
    for (const p of sc.positions) {
      const order = await prisma.order.create({
        data: { brokerId: broker.id, accountId: p.account, symbolId: symbolIds.get(p.symbol)!, side: p.side, type: "MARKET", volume: D(p.volume), status: "FILLED", filledPrice: D(p.openPrice), filledAt: new Date(), idempotencyKey: `parity:${p.key}` },
      });
      await prisma.position.create({
        data: {
          id: p.key, brokerId: broker.id, accountId: p.account, symbolId: symbolIds.get(p.symbol)!, originOrderId: order.id, side: p.side, volume: D(p.volume), openPrice: D(p.openPrice),
          slPrice: p.slPrice ? D(p.slPrice) : null, tpPrice: p.tpPrice ? D(p.tpPrice) : null,
        },
      });
    }
    // Stage 4.5: coverage legs and mirror rules (lib/coverage.ts / lib/mirror.ts follow them on every close)
    for (const p of sc.positions) {
      if (p.autoHedged) await prisma.position.update({ where: { id: p.key }, data: { autoHedged: true } });
      if (p.coverageLeg) await prisma.position.update({ where: { id: p.key }, data: { covered: true, coveredAt: new Date(), coveragePositionId: p.coverageLeg } });
    }
    const coverageAccount = sc.accounts.find((a) => a.coverage);
    if (coverageAccount) await prisma.broker.update({ where: { id: broker.id }, data: { coverageAccountId: coverageAccount.key } });
    if (sc.mirrors?.length) {
      const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `parity-admin-${sc.name}@parity.local`.slice(0, 80), passwordHash: "x", role: "BROKER_ADMIN" } });
      for (const m of sc.mirrors) {
        const firstSource = sc.positions.find((p) => p.key === m.links[0]?.source);
        const sourceGroup = groupIds.get(sc.accounts.find((a) => a.key === firstSource?.account)?.group ?? sc.groups[0].key)!;
        const rule = await prisma.mirrorRule.create({
          data: { id: m.key, brokerId: broker.id, sourceType: "GROUP", sourceId: sourceGroup, targetAccountId: m.master, direction: "REVERSE", multiplier: D(1), enabled: true, fillPriceMode: m.fillPriceMode ?? "SOURCE_PRICE", createdById: admin.id },
        });
        for (const l of m.links) await prisma.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId: l.source, targetPositionId: l.target } });
      }
    }

    for (const px of sc.prices) {
      // Raw insert: LivePrice.updatedAt is @updatedAt, so set both timestamps off Postgres's own
      // clock (the one getFreshPrices compares against).
      const updatedAge = px.updatedAgeSeconds ?? px.ageSeconds;
      await prisma.$executeRaw`
        INSERT INTO "LivePrice" (symbol, bid, ask, "tickAt", "updatedAt")
        VALUES (${px.symbol}, ${D(px.bid)}, ${D(px.ask)}, now() - make_interval(secs => ${px.ageSeconds}::double precision), now() - make_interval(secs => ${updatedAge}::double precision))`;
    }

    if (seedOnly) {
      console.log(`[parity:seed] ${sc.name} seeded into vyx_rust_harness`);
      continue;
    }

    const accounts: Record<string, AccountOutcome> = {};
    for (const a of sc.accounts) {
      const marginLevelBefore = await webMarginLevel(a.key);
      const result = await evaluateAccountRisk(a.key);
      if (!result.evaluated) throw new Error(`${sc.name}/${a.key}: evaluateAccountRisk returned evaluated=false`);
      const closed = [...result.slTpClosed, ...result.stopOutClosed];
      const txs = await prisma.transaction.findMany({ where: { accountId: a.key }, orderBy: { createdAt: "asc" } });
      const reasons = closed.map((id) => {
        const note = txs.find((t) => t.referenceId === id && t.type === "TRADE_PNL")?.note ?? "";
        if (note.startsWith("Stop loss")) return "stop_loss";
        if (note.startsWith("Take profit")) return "take_profit";
        if (note.startsWith("Stop-out")) return "stop_out";
        return `unknown:${note}`;
      });
      const rank = (t: (typeof txs)[number]) => {
        const i = closed.indexOf(t.referenceId ?? "");
        // rows of one close share one createdAt (one transaction): order them by kind, the order a close writes them
        const kind = t.type === "TRADE_PNL" ? 0 : t.type === "CREDIT" ? 1 : 2;
        return (i < 0 ? 1e6 : i) * 10 + kind;
      };
      const ordered = [...txs].sort((x, y) => rank(x) - rank(y));
      const acc = await prisma.account.findUniqueOrThrow({ where: { id: a.key } });
      accounts[a.key] = {
        marginLevelBefore,
        closedPositionIds: closed,
        closeReasons: reasons,
        finalBalance: acc.balance.toString(),
        finalCredit: acc.credit.toString(),
        transactions: ordered.map((t) => ({ type: t.type, amount: t.amount.toString() })),
        marginCallNotified: acc.marginCallNotifiedAt != null,
      };
    }
    // Stage 4.5: side effects and every position's end state, the same queries as engine/parity/src/db_mode.rs
    const effectRows = await prisma.$queryRaw<{ k: string; n: bigint }[]>`
      SELECT 'notification:' || type || ':' || coalesce("entityId", '-') || ':' || CASE WHEN "accountId" IS NULL THEN 'staff' ELSE 'trader' END AS k, count(*) AS n FROM "Notification" GROUP BY 1
      UNION ALL
      SELECT 'audit:' || action || ':' || coalesce("entityId", '-') AS k, count(*) AS n FROM "AuditLog" GROUP BY 1`;
    const sideEffects: Record<string, number> = {};
    for (const r of [...effectRows].sort((x, y) => (x.k < y.k ? -1 : 1))) sideEffects[r.k] = Number(r.n);
    const positions: Record<string, PositionState> = {};
    for (const p of await prisma.position.findMany({ orderBy: { id: "asc" } })) {
      positions[p.id] = { status: p.status, volume: p.volume.toString(), closePrice: p.closePrice?.toString() ?? null, realizedPnl: p.realizedPnl?.toString() ?? null };
    }
    const out = { scenario: sc.name, engine: "ts", accounts, sideEffects, positions };
    fs.writeFileSync(path.join(outDir, `${sc.name}.json`), JSON.stringify(out, null, 2) + "\n");
    console.log(`[parity:ts] ${sc.name}: ${Object.entries(accounts).map(([k, v]) => `${k} closed=[${v.closedPositionIds.join(",")}] balance=${v.finalBalance} mc=${v.marginCallNotified}`).join("; ")}`);
  }
  if (!seedOnly) await wipe();
  await prisma.$disconnect();
  console.log(`[parity:ts] ${files.length} scenario(s) written to ${outDir} (${suppressedEvents.length} gateway event publish(es) swallowed locally)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
