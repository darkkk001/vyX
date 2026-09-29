// Shadow bot CLI (owner-approved plan, 2026-09-29). Runs on a separate machine, never on the VPS.
//   npx tsx tools/shadow-bot/bot.ts list
//   npx tsx tools/shadow-bot/bot.ts run <scenario> --dry-run         offline: simulated backend, no network at all
//   npx tsx tools/shadow-bot/bot.ts run <scenario> [--flatten-first]  LIVE: needs SHADOWBOT_PASSWORD + SYNTH_FEED_SECRET_FILE
//   npx tsx tools/shadow-bot/bot.ts status <account...>               LIVE read-only: open positions per account
// A live run refuses to start when a scenario account already holds positions (unless --flatten-first), and when a
// scenario is marked needsObserver (S5) until the read-only staff observer exists.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { assertConfig, assertAccount, GuardRefused } from "./src/guards";
import { Journal } from "./src/journal";
import { HttpTickSink, PriceDriver } from "./src/price-driver";
import { HttpTradeClient, type TradeBackend } from "./src/trade-client";
import { RecordingSink, SimObserver, SimTradeBackend, type SimAccount } from "./src/sim";
import { DEFAULT_OBSERVER_FILE, HttpObserver, loadObserverCreds, type Observer } from "./src/observer";
import { Runner, type Scenario } from "./src/runner";
import type { SymbolMeta } from "./src/margin";

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
type Config = {
  tradeHost: string; feedUrl: string; tenant: string; symbols: string[]; symbolMeta: Record<string, SymbolMeta>;
  dryRunFxRates: Record<string, number>; limits: { maxOpenAccounts: number; tickMs: number; pollMs: number; maxRampPctPerSec: number; maxJumpPct: number; settleSecs: number; logEveryTick: boolean };
  accounts: Record<string, SimAccount>;
};

/** A command-line flag (two leading dashes). */
const FLAG = /^-{2}\w/;
const OPS = new Set(["note", "price.set", "price.jump", "open", "close", "closeBy", "coverageBaseline", "expectCoverageLeg", "expectCoverageClosed", "closeAccount", "rampUntil", "hold", "observe", "expect", "ramp", "waitUntil", "expectMirror", "expectNoNewPosition", "require"]);

export function loadConfig(): Config {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "config", "bot.json"), "utf8")) as Config;
  assertConfig(cfg);
  return cfg;
}
export function loadScenario(name: string, cfg: Config): Scenario {
  const file = path.join(ROOT, "scenarios", name.endsWith(".json") ? name : `${name}.json`);
  const sc = JSON.parse(readFileSync(file, "utf8")) as Scenario;
  for (const a of sc.accounts) { assertAccount(a); if (!cfg.accounts[a]) throw new GuardRefused(`scenario account ${a} is not in config/bot.json`); }
  for (const s of sc.symbols) if (!cfg.symbols.includes(s)) throw new GuardRefused(`scenario symbol ${s} is not in config/bot.json`);
  for (const [i, st] of sc.steps.entries()) {
    if (!OPS.has(st.op)) throw new Error(`${sc.name} step ${i + 1}: unknown op ${st.op}`);
    const sym = (st as { symbol?: string }).symbol; if (sym && !sc.symbols.includes(sym)) throw new GuardRefused(`${sc.name} step ${i + 1}: symbol ${sym} is not in the scenario's list`);
    const acct = (st as { account?: string }).account; if (acct && !sc.accounts.includes(acct)) throw new GuardRefused(`${sc.name} step ${i + 1}: account ${acct} is not in the scenario's list`);
    if (st.op === "price.jump" && !sc.allowJump) throw new GuardRefused(`${sc.name} step ${i + 1}: price.jump without allowJump`);
  }
  return sc;
}
/** Quote -> account rate: direct, inverse, or a cross through USD (JPY -> EUR = JPY -> USD -> EUR). */
export function fxFrom(rates: Record<string, number>) {
  const direct = (q: string, a: string): number => (q === a ? 1 : rates[`${q}${a}`] ?? (rates[`${a}${q}`] ? 1 / rates[`${a}${q}`] : NaN));
  return (q: string, a: string) => { const d = direct(q, a); return Number.isFinite(d) ? d : direct(q, "USD") * direct("USD", a); };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  if (cmd === "list") {
    for (const f of readdirSync(path.join(ROOT, "scenarios")).filter((f) => f.endsWith(".json")).sort()) {
      const sc = loadScenario(f, cfg);
      console.log(`${sc.name.padEnd(20)} ${sc.needsObserver ? "[needs observer] " : ""}${sc.title}`);
    }
    return;
  }
  if (cmd !== "run" && cmd !== "status") throw new Error("usage: bot.ts list | run <scenario> [--dry-run] [--flatten-first] | status <account...>");
  const dryRun = rest.includes("--dry-run");
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + (dryRun ? "-dry" : "");
  const journal = new Journal(path.join(ROOT, "logs"), runId);

  let trade: TradeBackend; let price: PriceDriver;
  if (dryRun) {
    const sink = new RecordingSink();
    price = new PriceDriver(sink, journal, { ...cfg.limits, logEveryTick: false });
    // --dry-balance=<account>:<amount> (dry run only): start an account from another balance than the seed value
    const accounts = structuredClone(cfg.accounts);
    for (const f of rest.filter((x) => x.startsWith("-" + "-dry-balance="))) {
      const [acct, amt] = f.split("=")[1].split(":"); assertAccount(acct);
      if (!accounts[acct] || !(Number(amt) >= 0)) throw new Error(`bad ${f}`);
      accounts[acct].balance = Number(amt);
    }
    trade = new SimTradeBackend(accounts, price, cfg.symbolMeta, cfg.dryRunFxRates);
  } else {
    const password = process.env.SHADOWBOT_PASSWORD;
    const secretFile = process.env.SYNTH_FEED_SECRET_FILE;
    if (!password) throw new Error("SHADOWBOT_PASSWORD is not set");
    if (!secretFile) throw new Error("SYNTH_FEED_SECRET_FILE is not set (the path of the copied synth-feed-secret.txt)");
    const secret = readFileSync(secretFile, "utf8").trim();
    if (!/^[0-9a-f]{48}$/.test(secret)) throw new Error("the synth feed secret file does not hold a 48-hex secret");
    price = new PriceDriver(new HttpTickSink(secret), journal, cfg.limits);
    trade = new HttpTradeClient(password);
  }

  if (cmd === "status") {
    for (const a of rest.filter((x) => !FLAG.test(x))) { assertAccount(a); const ps = await trade.positions(a); journal.write({ kind: "status", account: a, open: ps.map((p) => `${p.side} ${p.volume} ${p.symbol} @${p.openPrice} (${p.id})`) }); }
    return;
  }
  const sc = loadScenario(rest.find((x) => !FLAG.test(x)) ?? "", cfg);
  // the read-only staff observer (S5): simulated in the dry run; live, signed in from its credentials file
  // (SHADOWBOT_OBSERVER_FILE, default %USERPROFILE%/.vyx/shadowbot-observer.json, from scripts/seed-zzshadowbot-observer.ts)
  let observer: Observer | undefined;
  if (sc.needsObserver) {
    if (dryRun) observer = new SimObserver(trade as SimTradeBackend);
    else {
      const file = process.env.SHADOWBOT_OBSERVER_FILE || DEFAULT_OBSERVER_FILE;
      observer = new HttpObserver(loadObserverCreds(file));
      const open = await observer.coveragePositions(); // signs in now: a bad credential stops the run before any order
      journal.write({ kind: "observer.ready", coverageOpen: open.length, credentials: "file (not logged)" });
    }
  }
  journal.write({ kind: "run.start", mode: dryRun ? "DRY RUN (offline, simulated backend: nothing is sent)" : "LIVE", scenario: sc.name, journal: journal.file, limits: cfg.limits });

  if (!dryRun) {
    for (const a of sc.accounts) {
      const open = await trade.positions(a);
      if (open.length === 0) continue;
      if (!rest.includes("--flatten-first")) throw new GuardRefused(`${a} already holds ${open.length} position(s): rerun with --flatten-first, or check them first (bot.ts status ${a})`);
      journal.write({ kind: "preflight.flatten", account: a, positions: open.map((p) => p.id) });
      // needs a fresh price for the symbols it closes: set them from the current server quote
      for (const s of new Set(open.map((p) => p.symbol))) { const q = await trade.quote(a, s); await price.set(s, q.bid, Number((q.ask - q.bid).toFixed(6))); }
      for (const p of open) { const q = await trade.quote(a, p.symbol); await trade.close(a, p.id, p.side === "BUY" ? q.bid : q.ask); }
      price.stopAll();
    }
  }

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    price.stopAll();
    journal.write({ kind: "interrupted", note: "ticks stopped; open positions are left as they are (bot.ts status / run --flatten-first)" });
    process.exit(130);
  });

  const runner = new Runner(trade, price, journal, { maxOpenAccounts: cfg.limits.maxOpenAccounts, settleSecs: cfg.limits.settleSecs, pollMs: cfg.limits.pollMs, dryRun, meta: cfg.symbolMeta, fx: fxFrom(cfg.dryRunFxRates), observer });
  const ok = await runner.run(sc);
  price.stopAll();
  journal.write({ kind: "run.end", result: ok ? "PASS" : "FAIL", journal: journal.file });
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && /bot\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof GuardRefused ? `REFUSED: ${e.message}` : e); process.exitCode = 1; });
}
