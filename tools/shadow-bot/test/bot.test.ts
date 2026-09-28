// Shadow bot: the guards refuse what they must, every scenario file validates, the sizing math holds, and the
// journal never writes a secret. No network, no database.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertAccount, assertConfig, assertFeedUrl, assertSymbol, assertTradeUrl, GuardRefused, TRADE_ACCOUNTS } from "../src/guards";
import { lotsForMarginPct, lotsForStopOutAt } from "../src/margin";
import { Journal } from "../src/journal";
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
  it("all seven exist and validate", () => {
    expect(files.sort()).toEqual(["s1-single-stopout.json", "s2-fan-in.json", "s3-hedge-break.json", "s4-hedged-nbp.json", "s5-coverage.json", "s6-mirror.json", "s7-fx.json"]);
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
