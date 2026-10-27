// Shadow bot: the guards refuse what they must, every scenario file validates, the sizing math holds, and the
// journal never writes a secret. No network, no database.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertAccount, assertBulk, assertConfig, assertFeedUrl, assertSymbol, assertTradeUrl, BULK_MAX_LOTS, BULK_MAX_ORDERS_PER_SEC, BULK_MAX_POSITIONS_PER_ACCOUNT, GuardRefused, TRADE_ACCOUNTS } from "../src/guards";
import { lotsForMarginPct, lotsForStopOutAt } from "../src/margin";
import { Journal } from "../src/journal";
import { PriceDriver } from "../src/price-driver";
import { RecordingSink } from "../src/sim";
import { fxFrom, loadConfig, loadScenario } from "../bot";

describe("guards", () => {
  it("accept only the five synthetic symbols (leading lowercase v, exact names)", () => {
    for (const s of ["vGOLD", "vEUR", "vGBP", "vJPY", "vIDX"]) expect(() => assertSymbol(s)).not.toThrow();
    for (const s of ["XAUUSD", "EURUSD", "VGOLD", "vgold", "vSILVER", "", "XAUUSDv"]) expect(() => assertSymbol(s)).toThrow(GuardRefused);
  });
  it("accept only 49990001..49990013; the broker hedge account 49990099 is never a trade account", () => {
    expect(TRADE_ACCOUNTS).toHaveLength(13);
    expect(() => assertAccount("49990013")).not.toThrow();
    for (const a of ["49990099", "49990000", "49990014", "50005701", ""]) expect(() => assertAccount(a)).toThrow(GuardRefused);
  });
  it("accept only the zzshadowbot trade API and the synth-feed route", () => {
    expect(() => assertTradeUrl("https://zzshadowbot.vyxtrader.com/api/trade/orders")).not.toThrow();
    for (const u of ["https://futurixglobal.vyxtrader.com/api/trade/orders", "https://zzshadowbot.vyxtrader.com/api/manage/accounts", "http://zzshadowbot.vyxtrader.com/api/trade/me"]) expect(() => assertTradeUrl(u)).toThrow(GuardRefused);
    expect(() => assertFeedUrl("https://feed.vyxtrader.com/internal/synth-feed")).not.toThrow();
    expect(() => assertFeedUrl("https://feed.vyxtrader.com/internal/price-feed")).toThrow(GuardRefused);
  });
  it("openMany: count, lots, pace and SL distance are capped; an SL is never optional", () => {
    const ok = { count: 450, volume: 0.01, perSec: 8, slFromPct: 0.5, slToPct: 1.5 };
    expect(() => assertBulk(ok)).not.toThrow();
    expect(BULK_MAX_POSITIONS_PER_ACCOUNT).toBe(500);
    for (const bad of [
      { ...ok, count: BULK_MAX_POSITIONS_PER_ACCOUNT + 1 }, { ...ok, count: 0 }, { ...ok, count: 1.5 },
      { ...ok, volume: BULK_MAX_LOTS + 0.01 }, { ...ok, volume: 0 },
      { ...ok, perSec: BULK_MAX_ORDERS_PER_SEC + 1 }, { ...ok, perSec: 0 },
      { ...ok, slFromPct: 0 }, { ...ok, slToPct: 5.1 }, { ...ok, slFromPct: NaN },
    ]) expect(() => assertBulk(bad)).toThrow(GuardRefused);
  });
  it("a config cannot widen them", () => {
    const cfg = loadConfig();
    expect(() => assertConfig({ ...cfg, tradeHost: "https://futurixglobal.vyxtrader.com" })).toThrow(GuardRefused);
    expect(() => assertConfig({ ...cfg, tenant: "futurixglobal" })).toThrow(GuardRefused);
    expect(() => assertConfig({ ...cfg, symbols: [...cfg.symbols, "XAUUSD"] })).toThrow(GuardRefused);
    expect(() => assertConfig({ ...cfg, accounts: { ...cfg.accounts, "49990099": cfg.accounts["49990001"] } })).toThrow(GuardRefused);
  });
});

describe("scenarios", () => {
  const cfg = loadConfig();
  const files = readdirSync(path.join(import.meta.dirname, "..", "scenarios")).filter((f) => f.endsWith(".json"));
  it("all eight exist and validate", () => {
    expect(files.sort()).toEqual(["s1-single-stopout.json", "s2-fan-in.json", "s3-hedge-break.json", "s4-hedged-nbp.json", "s5-coverage.json", "s6-mirror.json", "s7-fx.json", "s8-stopout-contention.json"]);
    for (const f of files) expect(() => loadScenario(f, cfg)).not.toThrow();
  });
  it("no scenario holds more than 4 accounts, and only S2 may jump (within 5%)", () => {
    for (const f of files) {
      const sc = loadScenario(f, cfg);
      expect(sc.accounts.length).toBeLessThanOrEqual(cfg.limits.maxOpenAccounts);
      const jumps = sc.steps.filter((s) => s.op === "price.jump") as { pct: number }[];
      if (sc.name !== "s2-fan-in") expect(jumps).toHaveLength(0);
      for (const j of jumps) expect(Math.abs(j.pct)).toBeLessThanOrEqual(cfg.limits.maxJumpPct);
      for (const s of sc.steps) if ("pctPerSec" in s) expect((s as { pctPerSec: number }).pctPerSec).toBeLessThanOrEqual(cfg.limits.maxRampPctPerSec);
    }
  });
  it("every openMany step is inside the bulk caps and gives every position an SL", () => {
    for (const f of files) {
      for (const st of loadScenario(f, cfg).steps) {
        if (st.op !== "openMany") continue;
        const m = st as unknown as { count: number; volume: number; perSec?: number; slFromPct: number; slToPct: number };
        expect(() => assertBulk({ ...m, perSec: m.perSec ?? BULK_MAX_ORDERS_PER_SEC })).not.toThrow();
      }
    }
  });
  it("S8 crosses three stop-outs inside the SL levels (three episodes per run), each before its wipe-out, on a symbol with digits", () => {
    const sc = loadScenario("s8-stopout-contention", cfg);
    const many = sc.steps.find((s) => s.op === "openMany") as unknown as { count: number; slFromPct: number; slToPct: number; symbol: string; account: string };
    const victims = sc.steps.filter((s) => s.op === "open") as unknown as { account: string; stopOutAtPct: number; as: string }[];
    const ramp = sc.steps.find((s) => s.op === "rampUntil") as unknown as { maxPct: number; until: { closed: string[] } };
    const expectStep = sc.steps.find((s) => s.op === "expect") as unknown as { stoppedOut: string[] };
    expect(many.count).toBe(450);
    expect(victims).toHaveLength(3);
    expect(new Set(victims.map((v) => v.account)).size).toBe(3);
    expect(victims.map((v) => v.account)).not.toContain(many.account);
    expect(sc.accounts.length).toBeLessThanOrEqual(cfg.limits.maxOpenAccounts);
    for (const v of victims) {
      expect(v.stopOutAtPct).toBeGreaterThan(many.slFromPct);
      expect(v.stopOutAtPct).toBeLessThan(many.slToPct);
      const a = cfg.accounts[v.account];
      const wipeOut = v.stopOutAtPct + a.stopOutLevel / a.leverage;
      expect(wipeOut - v.stopOutAtPct, `${v.as}: room between its stop-out and its wipe-out`).toBeGreaterThanOrEqual(0.25);
      expect(ramp.until.closed).toContain(v.as);
      expect(expectStep.stoppedOut).toContain(v.as);
    }
    expect(new Set(victims.map((v) => v.stopOutAtPct)).size).toBe(3);
    expect(cfg.symbolMeta[many.symbol].digits).toBe(1);
  });
  it("S5 is marked as needing the observer (refused live until it exists)", () => {
    expect(loadScenario("s5-coverage", cfg).needsObserver).toBe(true);
  });
});

describe("sizing", () => {
  it("stop-out distance: the S2 gap passes every stop-out and stays under every wipe-out", () => {
    const cases = [{ E: 10000, lev: 100 }, { E: 2000, lev: 200 }, { E: 1000, lev: 50 }];
    for (const { E, lev } of cases) {
      const lots = lotsForStopOutAt(1.5, E, lev, 50, 1, 20000, 1);
      const equityAt = (movePct: number) => E - lots * 20000 * movePct / 100;
      const usedAt = (movePct: number) => (lots * 20000 * (1 - movePct / 100)) / lev;
      expect(equityAt(1.6) / usedAt(1.6) * 100).toBeLessThanOrEqual(50);   // past the stop-out
      expect(equityAt(1.6)).toBeGreaterThan(0);                               // not wiped out
    }
  });
  it("margin % of equity", () => {
    expect(lotsForMarginPct(60, 800, 100, 100, 2000.15, 1)).toBe(0.23);
  });
  it("FX crosses through USD for the dry run", () => {
    const fx = fxFrom({ EURUSD: 1.08, USDJPY: 150 });
    expect(fx("USD", "EUR")).toBeCloseTo(1 / 1.08, 10);
    expect(fx("JPY", "EUR")).toBeCloseTo(1 / 150 / 1.08, 10);
  });
});

describe("S4 sizing (SB Hedge NBP on vGOLD, the live config)", () => {
  // markup 60 pips x 0.1 (2 digits) = 6.00: a BUY fills at ask + 6.00, an open SELL is valued at ask + 6.00
  // (lib/ask-markup.ts accountClosePrice); commission 50 per lot; contract 100; leverage 1000; stop-out 20
  const cs = 100, lev = 1000, markup = 6.0, commission = 50, spread = 0.3, bid = 2000;
  const legCost = (lots: number) => lots * (commission + (spread + markup) * cs); // what one leg costs on opening
  const sellMargin = (lots: number) => (lots * cs * (bid + spread + markup)) / lev; // the web prices it at the marked ask
  it("the first leg alone stays above the margin call (far from stop-out); the pair ends clearly below zero", () => {
    expect(lotsForMarginPct(18, 600, lev, cs, bid + spread / 2, 1)).toBe(0.53); // 108 / 200.015 = 0.5399, floored to the lot step
    for (const equity of [580, 600, 650]) {
      const lots = lotsForMarginPct(18, equity, lev, cs, bid + spread / 2, 1);
      expect(((equity - legCost(lots)) / sellMargin(lots)) * 100).toBeGreaterThan(100);
      expect(equity - 2 * legCost(lots)).toBeLessThan(-50);
    }
  });
  it("the old fixed 1.0 lot could not survive its own first leg on 600 (the failed run: stopped out, then 0 funds)", () => {
    expect(((600 - legCost(1)) / sellMargin(1)) * 100).toBeLessThan(20);
  });
  it("S4 closes the pair by each other and requires fresh equity", () => {
    const sc = loadScenario("s4-hedged-nbp", loadConfig());
    const ops = sc.steps.map((s) => s.op);
    expect(ops).toContain("closeBy");
    expect(ops).not.toContain("close");
    const req = sc.steps.find((s) => s.op === "require") as { minEquity: number } | undefined;
    expect(req?.minEquity).toBe(580);
    expect(ops.indexOf("require")).toBeLessThan(ops.indexOf("open"));
    // close-by leaves the balance positive (below): S4 must not expect a write-off
    expect(sc.steps.some((s) => s.op === "expect" && "nbpWriteOff" in s)).toBe(false);
  });
  it("close-by settles both legs at ONE raw price: only the BUY's markup is realized (the 2026-09-29 run, balance 213.10)", () => {
    const lots = 0.53, sellOpen = 2000, buyOpen = 2006.3, close = 1996.07; // the live rows
    const realized = (sellOpen - close) * lots * cs + (close - buyOpen) * lots * cs;
    expect(realized).toBeCloseTo(-(spread + markup) * lots * cs, 6); // -333.90, whatever the close price
    expect(600 - 2 * commission * lots + realized).toBeCloseTo(213.1, 6); // positive: no write-off
    // while open, the server valued the SELL at ask + 6.00 too: equity ~-121 (negative) at used margin 0
    expect(600 - 2 * legCost(lots)).toBeCloseTo(-120.8, 6);
  });
});

describe("journal", () => {
  it("never writes a secret, cookie or password", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sbj-"));
    const j = new Journal(dir, "t", () => {});
    j.write({ kind: "x", secret: "abc", cookie: "vyx=1", password: "pw", nested: { synthFeedSecret: "zzz" }, ok: 1 });
    const text = readFileSync(j.file, "utf8");
    for (const v of ["abc", "vyx=1", "pw\"", "zzz"]) expect(text).not.toContain(v);
    expect(text).toContain("\"ok\":1");
  });
});

describe("price driver tick jitter (owner 2026-10-27: no phase lock with the engine's 250 ms risk loop)", () => {
  const driver = (tickMs: number, tickJitterMs?: number) =>
    new PriceDriver(new RecordingSink(), new Journal(mkdtempSync(path.join(os.tmpdir(), "pd-")), "t", () => {}), { tickMs, tickJitterMs, maxRampPctPerSec: 1, maxJumpPct: 1, logEveryTick: false });
  it("without a jitter every interval is tickMs", () => {
    const d = driver(1000);
    for (let i = 0; i < 50; i++) expect(d.nextTickMs()).toBe(1000);
  });
  it("with a jitter the intervals spread over tickMs +- jitter, and their phase against a 250 ms cycle is not fixed", () => {
    const d = driver(1000, 150);
    const xs = Array.from({ length: 2000 }, () => d.nextTickMs());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(850);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1150);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean - 1000)).toBeLessThan(15);
    // the arrival phase (cumulative time mod 250) visits all four quarters of the loop's cycle
    let t = 0; const quarters = new Set<number>();
    for (const x of xs) { t += x; quarters.add(Math.floor((t % 250) / 62.5)); }
    expect(quarters.size).toBe(4);
  });
  it("a jittered ramp keeps its %/s: each step follows the interval it stands for", async () => {
    const d = driver(40, 15);
    await d.set("vIDX", 20000, 2);
    const t0 = Date.now();
    await d.ramp("vIDX", "down", 0.5, 100, 1.2, async () => false);
    const secs = (Date.now() - t0) / 1000;
    const moved = (20000 - d.bid("vIDX")) / 20000 * 100;
    d.stopAll();
    // 0.5 %/s over the ramp's own time, within the timer slack of a test machine
    expect(moved / secs).toBeGreaterThan(0.35);
    expect(moved / secs).toBeLessThan(0.55);
  });
});