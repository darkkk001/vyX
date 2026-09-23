// Stage 4 load harness -- deterministic synthetic book (docs/RUST-CUTOVER-PLAN.md §4.1, §4.7).
//
//   npx tsx scripts/load/generate.ts --seed 1 --accounts 100 --out engine/parity/out/load/world-1-100.json
//
// One integer seed -> one JSON world, byte-identical every time: every id, ticket, price and balance comes from the
// seeded PRNG below, so the web run and the engine run seed the SAME book and can be compared id by id.
// Accounts are evaluated in id order by both runners, so ids encode the intended order.
//
// The world is post-shock: prices are already the shocked ones, nothing has been evaluated yet.
import fs from "node:fs";
import path from "node:path";

export type World = {
  seed: number;
  brokers: { id: string; nbp: boolean; coverageAccount?: string }[];
  groups: { id: string; broker: string; marginCallLevel: string; stopOutLevel: string }[];
  accounts: { id: string; broker: string; group: string; balance: string; credit: string; leverage: number; currency: string; role: string }[];
  symbols: { name: string; contractSize: string; digits: number; quoteCurrency: string; sessionClosedNow?: boolean }[];
  positions: {
    id: string; account: string; symbol: string; side: "BUY" | "SELL"; volume: string; openPrice: string;
    slPrice?: string; tpPrice?: string; autoHedged?: boolean; coverageLeg?: string; queuedClose?: boolean;
  }[];
  mirrors: { id: string; broker: string; master: string; fillPriceMode: "SOURCE_PRICE" | "MARKET"; links: { source: string; target: string }[] }[];
  prices: { symbol: string; bid: string; ask: string; ageSeconds: number }[];
  // named topologies (§4.7): the accounts in each, so a failure can be attributed; `anomaly` = data the product
  // never creates (a circular mirror, coverage-of-coverage): must terminate and stay exactly-once, web-identical not required
  topologies: { name: string; accounts: string[]; anomaly?: boolean }[];
};

// mulberry32: tiny, deterministic, good enough for test data
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICES: Record<string, { bid: number; ask: number; contract: number; digits: number; quote: string; age: number; sessionClosedNow?: boolean }> = {
  EURUSD: { bid: 1.1, ask: 1.1002, contract: 100000, digits: 5, quote: "USD", age: 0 },
  XAUUSD: { bid: 2000, ask: 2000.5, contract: 100, digits: 2, quote: "USD", age: 0 },
  USDJPY: { bid: 150, ask: 150.02, contract: 100000, digits: 3, quote: "JPY", age: 0 },
  SESSX: { bid: 1.25, ask: 1.2502, contract: 100000, digits: 5, quote: "USD", age: 0, sessionClosedNow: true },
  STALEX: { bid: 0.9, ask: 0.9002, contract: 100000, digits: 5, quote: "USD", age: 120 },
};

// account-currency value of 1 unit of quote currency (approximate: only used to BAND the book, both engines then
// compute exactly)
function fx(quote: string, account: string): number {
  if (quote === account) return 1;
  if (quote === "JPY" && account === "USD") return 1 / 150.01;
  if (quote === "USD" && account === "EUR") return 1 / 1.1001;
  throw new Error(`no fx for ${quote}->${account}`);
}

export function generate(seed: number, clients: number): World {
  const rnd = prng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const w: World = { seed, brokers: [], groups: [], accounts: [], symbols: [], positions: [], mirrors: [], prices: [], topologies: [] };
  for (const [name, p] of Object.entries(PRICES)) {
    w.symbols.push({ name, contractSize: String(p.contract), digits: p.digits, quoteCurrency: p.quote, sessionClosedNow: p.sessionClosedNow });
    w.prices.push({ symbol: name, bid: p.bid.toFixed(p.digits), ask: p.ask.toFixed(p.digits), ageSeconds: p.age });
  }
  let posSeq = 0;
  const pid = (tag: string) => `p${String(++posSeq).padStart(6, "0")}-${tag}`;

  // ---------------------------------------------------------------- bulk: two brokers (NBP on / off)
  const levels = [["100", "50"], ["80", "30"], ["50", "20"], ["120", "60"]];
  for (const nbp of [true, false]) {
    const b = `b-bulk-${nbp ? "nbp" : "raw"}`;
    w.brokers.push({ id: b, nbp, coverageAccount: `${b}-z-coverage` });
    levels.forEach(([mc, so], i) => w.groups.push({ id: `${b}-g${i}`, broker: b, marginCallLevel: mc, stopOutLevel: so }));
  }
  const bulkBrokers = w.brokers.map((b) => b.id);
  for (const b of bulkBrokers) {
    // masters and the coverage account: well funded, ids spread through the order (m-* sorts before the clients' a-*
    // for one master, after them for the other) so both orders occur
    w.accounts.push({ id: `${b}-a0000-master1`, broker: b, group: `${b}-g0`, balance: "10000000", credit: "0", leverage: 100, currency: "USD", role: "master" });
    w.accounts.push({ id: `${b}-z-master2`, broker: b, group: `${b}-g0`, balance: "10000000", credit: "0", leverage: 100, currency: "USD", role: "master" });
    w.accounts.push({ id: `${b}-z-coverage`, broker: b, group: `${b}-g0`, balance: "10000000", credit: "0", leverage: 500, currency: "USD", role: "coverage" });
    for (const m of ["1", "2"]) {
      w.mirrors.push({ id: `${b}-rule${m}`, broker: b, master: m === "1" ? `${b}-a0000-master1` : `${b}-z-master2`, fillPriceMode: m === "1" ? "SOURCE_PRICE" : "MARKET", links: [] });
    }
  }
  for (let i = 0; i < clients; i++) {
    const b = bulkBrokers[i % bulkBrokers.length];
    const gi = Math.floor(rnd() * levels.length);
    const [mcS, soS] = levels[gi];
    const [mc, so] = [Number(mcS), Number(soS)];
    const r = rnd();
    const cls = r < 0.35 ? "stopout" : r < 0.5 ? "margincall" : r < 0.65 ? "sltp" : r < 0.7 ? "session" : r < 0.75 ? "stale" : "healthy";
    const currency = rnd() < 0.1 ? "EUR" : "USD";
    const leverage = pick([50, 100, 200, 500]);
    const id = `${b}-a${String(i + 1).padStart(5, "0")}`;
    const symbolsFor = cls === "session" ? ["SESSX"] : cls === "stale" ? ["STALEX"] : currency === "EUR" ? ["EURUSD", "XAUUSD"] : ["EURUSD", "XAUUSD", "USDJPY"];
    const n = 1 + Math.floor(rnd() * 6);
    let pnl = 0;
    let margin = 0;
    const mine: World["positions"] = [];
    for (let k = 0; k < n; k++) {
      const sym = pick(symbolsFor);
      const px = PRICES[sym];
      const side: "BUY" | "SELL" = rnd() < 0.5 ? "BUY" : "SELL";
      const volume = pick([0.1, 0.2, 0.5, 1, 2]);
      const close = side === "BUY" ? px.bid : px.ask;
      // mostly losing, some winning: open 3 % adverse .. 1 % favourable
      const move = between(-0.03, 0.01);
      const open = Number((side === "BUY" ? close * (1 - move) : close * (1 + move)).toFixed(px.digits));
      const f = fx(px.quote, currency);
      const p = (side === "BUY" ? close - open : open - close) * px.contract * volume * f;
      pnl += p;
      margin += (volume * px.contract * close * f) / leverage;
      const pos: World["positions"][number] = { id: pid("x"), account: id, symbol: sym, side, volume: volume.toFixed(2), openPrice: open.toFixed(px.digits) };
      if (cls === "sltp" && k < 2) {
        // crossed now: a BUY's SL at/above the bid or TP at/below it (mirror for a SELL)
        const level = side === "BUY" ? close * (1 + 0.0005) : close * (1 - 0.0005);
        if (rnd() < 0.5) pos.slPrice = level.toFixed(px.digits);
        else pos.tpPrice = (side === "BUY" ? close * (1 - 0.0005) : close * (1 + 0.0005)).toFixed(px.digits);
      }
      mine.push(pos);
      // a deliberate tie: an identical twin (same floating P&L -> the "worst first" tie-break decides)
      if (k === 0 && rnd() < 0.1) {
        mine.push({ ...pos, id: pid("tie") });
        pnl += p;
        margin += (volume * px.contract * close * f) / leverage;
      }
    }
    const targetLevel =
      cls === "stopout" ? so * between(0.1, 0.9) : cls === "margincall" ? between(so * 1.1, mc * 0.95) : between(mc * 2, mc * 6);
    const equity = (targetLevel / 100) * margin;
    const credit = rnd() < 0.2 ? Math.max(0, equity * 0.3) : 0;
    const balance = Math.max(0, equity - pnl - credit);
    w.accounts.push({ id, broker: b, group: `${b}-g${gi}`, balance: balance.toFixed(2), credit: credit.toFixed(2), leverage, currency, role: cls });
    for (const pos of mine) {
      w.positions.push(pos);
      if (rnd() < 0.05) pos.queuedClose = true;
      const px = PRICES[pos.symbol];
      if (currency === "USD" && px.quote === "USD" && rnd() < 0.1) {
        // mirrored (reverse) onto a master
        const ruleId = `${b}-rule${rnd() < 0.5 ? "1" : "2"}`;
        const rule = w.mirrors.find((m) => m.id === ruleId)!;
        const target = pid("mt");
        w.positions.push({ id: target, account: rule.master, symbol: pos.symbol, side: pos.side === "BUY" ? "SELL" : "BUY", volume: pos.volume, openPrice: pos.openPrice });
        rule.links.push({ source: pos.id, target });
      }
      if (rnd() < 0.2) {
        // hedged on the broker's coverage account: same side, same size; auto-hedged (the platform follows the
        // client's close) or dealer-booked (left to the desk)
        const leg = pid("leg");
        w.positions.push({ id: leg, account: `${b}-z-coverage`, symbol: pos.symbol, side: pos.side, volume: pos.volume, openPrice: pos.openPrice, autoHedged: rnd() < 0.7 });
        pos.coverageLeg = leg;
      }
    }
  }

  // ---------------------------------------------------------------- cascade topologies (§4.7), one broker each
  // Numbers on EURUSD (bid 1.10000 / ask 1.10020, contract 100000, leverage 100: 1 lot = 1100 margin), group 100/50.
  const topo = (name: string, order: string[], build: (b: string, acc: (key: string, balance: number, role?: string) => string) => void, anomaly = false) => {
    const b = `t-${name}`;
    w.brokers.push({ id: b, nbp: true });
    w.groups.push({ id: `${b}-g`, broker: b, marginCallLevel: "100", stopOutLevel: "50" });
    const ids: string[] = [];
    // ids encode the evaluation order given in `order`
    const acc = (key: string, balance: number, role = "topology") => {
      const id = `${b}-${String(order.indexOf(key)).padStart(2, "0")}-${key}`;
      if (order.indexOf(key) < 0) throw new Error(`${name}: ${key} not in order`);
      w.accounts.push({ id, broker: b, group: `${b}-g`, balance: balance.toFixed(2), credit: "0", leverage: 100, currency: "USD", role });
      ids.push(id);
      return id;
    };
    build(b, acc);
    w.topologies.push({ name, accounts: ids.sort(), anomaly });
  };
  const P = (account: string, side: "BUY" | "SELL", open: string, tag: string, extra: Partial<World["positions"][number]> = {}) => {
    const id = pid(tag);
    w.positions.push({ id, account, symbol: "EURUSD", side, volume: "1.00", openPrice: open, ...extra });
    return id;
  };
  const mirror = (b: string, master: string, links: { source: string; target: string }[]) =>
    w.mirrors.push({ id: `${b}-r${w.mirrors.length}`, broker: b, master, fillPriceMode: "SOURCE_PRICE", links });

  // Mirror depth 2 / 3: client C stops out -> t1 on A closes at the source price -> A (already under stop-out) stops
  // out its own a1 -> mirrored onto B (b1) -> B, also under stop-out, differs on WHICH closes first: web closes b1 by
  // mirror (+2000) BEFORE B's own stop-out of b2 (-3000), so NBP floors B at 0; closing b2 first leaves B at +2000.
  // Depth 3 adds D, mirrored from B's b2 the same way.
  const mirrorChain = (name: string, order: string[], depth3: boolean) =>
    topo(name, order, (b, acc) => {
      const C = acc("C", 100);
      const A = acc("A", 1000);
      const B = acc("B", 100);
      const pc = P(C, "BUY", "1.20000", "c");
      const t1 = P(A, "SELL", "1.05000", "t1");
      const a1 = P(A, "BUY", "1.12000", "a1");
      const b1 = P(B, "SELL", "1.12000", "b1");
      const b2 = P(B, "BUY", "1.13000", "b2");
      mirror(b, A, [{ source: pc, target: t1 }]);
      mirror(b, B, [{ source: a1, target: b1 }]);
      if (depth3) {
        const D = acc("D", 100);
        const dt = P(D, "SELL", "1.13000", "dt");
        P(D, "BUY", "1.14000", "d2");
        mirror(b, D, [{ source: b2, target: dt }]);
      }
    });
  mirrorChain("mirror-d2", ["C", "A", "B"], false);
  mirrorChain("mirror-d2-rev", ["B", "A", "C"], false);
  mirrorChain("mirror-d3", ["C", "A", "B", "D"], true);
  mirrorChain("mirror-d3-rev", ["D", "B", "A", "C"], true);

  // Coverage cascade: X stops out -> its auto-hedged leg lx on the coverage account CV closes -> CV (still under
  // stop-out) stops out ly, the leg hedging Y -> Y is released while open, with a COVERAGE_STOP_OUT to the desk; Y then
  // stops out unhedged. Evaluated the other way, Y's own stop-out would auto-close ly instead (other audit / notices).
  const coverageChain = (name: string, order: string[]) =>
    topo(name, order, (b, acc) => {
      const X = acc("X", 100);
      const CV = acc("CV", 12500, "coverage");
      const Y = acc("Y", 100);
      w.brokers.find((x) => x.id === b)!.coverageAccount = CV;
      const lx = P(CV, "BUY", "1.20020", "lx", { autoHedged: true });
      const ly = P(CV, "BUY", "1.12000", "ly", { autoHedged: true });
      P(X, "BUY", "1.20000", "x", { coverageLeg: lx });
      P(Y, "BUY", "1.20000", "y", { coverageLeg: ly });
    });
  coverageChain("coverage-chain", ["X", "CV", "Y"]);
  coverageChain("coverage-chain-rev", ["Y", "CV", "X"]);

  // Fan-in: many clients stopped out by the same shock, all mirrored onto ONE master and hedged on ONE coverage account
  // (both under stop-out themselves); the master / coverage account come last, after every follow-up on the web.
  const fan = Math.max(10, Math.min(200, Math.floor(clients / 5)));
  const fanOrder = [...Array.from({ length: fan }, (_, i) => `c${String(i).padStart(3, "0")}`), "M", "CV"];
  topo("fan-in", fanOrder, (b, acc) => {
    const M = acc("M", 1000 * fan);
    const CV = acc("CV", 1000 * fan, "coverage");
    w.brokers.find((x) => x.id === b)!.coverageAccount = CV;
    const links: { source: string; target: string }[] = [];
    for (let i = 0; i < fan; i++) {
      const c = acc(`c${String(i).padStart(3, "0")}`, 100);
      const leg = P(CV, "BUY", "1.20020", "fl", { autoHedged: true });
      const p = P(c, "BUY", "1.20000", "fc", { coverageLeg: leg });
      links.push({ source: p, target: P(M, "SELL", "1.05000", "ft") });
    }
    P(M, "BUY", "1.30000", "fm");
    P(CV, "BUY", "1.30000", "fcv");
    mirror(b, M, links);
  });

  // Anomalies: a circular mirror (A's a1 onto B, B's b1 onto A), and a coverage leg hedged by another leg.
  topo("circular", ["A", "B"], (b, acc) => {
    const A = acc("A", 100);
    const B = acc("B", 100);
    const a1 = P(A, "BUY", "1.20000", "ca1");
    const a2 = P(A, "SELL", "1.00000", "ca2");
    const b1 = P(B, "SELL", "1.00000", "cb1");
    const b2 = P(B, "BUY", "1.20000", "cb2");
    mirror(b, B, [{ source: a1, target: b1 }]);
    mirror(b, A, [{ source: b2, target: a2 }]);
  }, true);
  topo("coverage-of-coverage", ["X", "CV"], (b, acc) => {
    const X = acc("X", 100);
    const CV = acc("CV", 100000, "coverage");
    w.brokers.find((x) => x.id === b)!.coverageAccount = CV;
    const l2 = P(CV, "SELL", "1.20020", "cl2", { autoHedged: true });
    const l1 = P(CV, "BUY", "1.20020", "cl1", { autoHedged: true, coverageLeg: l2 });
    P(X, "BUY", "1.20000", "cx", { coverageLeg: l1 });
  }, true);

  return w;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const arg = (name: string, dflt?: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const seed = Number(arg("seed", "1"));
  const n = Number(arg("accounts", "100"));
  const out = arg("out", `engine/parity/out/load/world-${seed}-${n}.json`)!;
  const world = generate(seed, n);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(world, null, 1) + "\n");
  console.log(`[load:generate] seed=${seed} clients=${n}: ${world.accounts.length} accounts, ${world.positions.length} positions, ${world.mirrors.reduce((s, m) => s + m.links.length, 0)} mirror links, ${world.topologies.length} topologies -> ${out}`);
}
