import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WT_COLORS, wtColors } from "./wt-colors";

// Platform colour rule (owner 2026-11-03): BUY blue (#4A7DD6 dark / #2F6BD8 light), SELL red #C84A4A, money never green;
// green only for status (--ok) and price direction (--tick-up). wt-colors.ts must carry the same values as webtrader.css.

const root = path.resolve(__dirname, "..", "..");
const css = readFileSync(path.join(root, "app", "(broker)", "trade", "webtrader.css"), "utf8").replace(/\r\n/g, "\n");

/** The custom properties of the first block whose selector line is exactly `selector {`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {\n`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) out[m[1]] = m[2].trim();
  return out;
}

describe("WebTrader colour tokens", () => {
  const classic = block(".wt-root");
  const deflt = block('.wt-root[data-theme="default"]');
  const light = block('.wt-root[data-mode="light"]');

  it("BUY is blue and SELL is red in every theme", () => {
    expect([classic["--buy"], deflt["--buy"], light["--buy"]]).toEqual(["#4A7DD6", "#4A7DD6", "#2F6BD8"]);
    expect([classic["--sell"], deflt["--sell"], light["--sell"]]).toEqual(["#C84A4A", "#C84A4A", "#C84A4A"]);
  });

  it("money follows the side colours; status and price direction have their own green", () => {
    for (const t of [classic, deflt, light]) {
      expect(t["--profit"]).toBe("var(--buy)");
      expect(t["--loss"]).toBe("var(--sell)");
      expect(t["--ok"]).toMatch(/^#/);
      expect(t["--err"]).toMatch(/^#/);
      expect(t["--tick-up"]).toMatch(/^#/);
      expect(t["--tick-down"]).toMatch(/^#/);
    }
  });

  it("wt-colors.ts carries the same values as the stylesheet (classic dark, light)", () => {
    const pairs: [keyof (typeof WT_COLORS)["dark"], string][] = [["buy", "--buy"], ["sell", "--sell"], ["ok", "--ok"], ["err", "--err"], ["tickUp", "--tick-up"], ["tickDown", "--tick-down"]];
    for (const [k, v] of pairs) {
      expect(WT_COLORS.dark[k], k).toBe(classic[v]);
      expect(WT_COLORS.light[k], k).toBe(light[v]);
    }
    expect(WT_COLORS.dark.profit).toBe(WT_COLORS.dark.buy);
    expect(WT_COLORS.light.loss).toBe(WT_COLORS.light.sell);
    expect(wtColors("light")).toBe(WT_COLORS.light);
    expect(wtColors(undefined)).toBe(WT_COLORS.dark);
  });

  it("no WebTrader component hard-codes the old green / red", () => {
    const dir = path.join(root, "components", "webtrader");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      // DesktopTitleBar's window-close hover is the OS danger red, not a trading colour
      const hits = (src.match(/#16C784|#1FD68A|#0A7A4D|#EA3943|#F0475A/gi) ?? []).length - (f === "DesktopTitleBar.tsx" ? 1 : 0);
      if (hits > 0) offenders.push(`${f}: ${hits}`);
    }
    expect(offenders).toEqual([]);
  });
});
