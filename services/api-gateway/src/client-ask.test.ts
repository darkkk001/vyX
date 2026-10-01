// client-ask.ts pinned to the shared contract (docs/contracts/ask-markup-vectors.json, generated from the web's own
// lib/ask-markup.ts): the stream's per-account ask must equal the price the web fills at, for every vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Decimal } from "decimal.js";
import { resolveRule, clientAsk, rewriteTick, type AskRule } from "./client-ask.js";

const v = JSON.parse(readFileSync(new URL("../../../docs/contracts/ask-markup-vectors.json", import.meta.url), "utf-8"));
const D = (x: unknown) => (x == null ? null : new Decimal(String(x)));
const lvl = (l: { spreadMarkup: string | null; targetTotalSpreadPips: string | null } | null) => ({ markup: D(l?.spreadMarkup), target: D(l?.targetTotalSpreadPips) });

test("every resolution vector: the stream resolves the same rule as the web", () => {
  for (const c of v.resolution) {
    const r = resolveRule({ engine: c.pricingEngineEnabled, coverage: c.coverage, digits: c.digits, broker: D(c.broker), group: lvl(c.group), account: lvl(c.accountSymbol) });
    const got = r.mode === "markup" ? { mode: "markup", markupPips: r.markupPips.toString() } : { mode: "target", targetPips: r.targetPips.toString(), fallbackPips: r.fallbackPips?.toString() ?? null };
    assert.deepEqual(got, c.expected, c.name);
  }
});

test("every price vector: the stream's ask equals the web's account ask", () => {
  for (const c of v.prices) {
    const rule: AskRule = c.rule.mode === "markup"
      ? { mode: "markup", markupPips: new Decimal(c.rule.markupPips), digits: c.digits }
      : { mode: "target", targetPips: new Decimal(c.rule.targetPips), fallbackPips: D(c.rule.fallbackPips), digits: c.digits };
    assert.equal(clientAsk(rule, c.bid, c.ask).toString(), new Decimal(c.expected.accountAsk).toString(), c.name);
  }
});

test("a rewritten tick carries the account's ask in place of the raw ask, nothing else changes, same JSON type", () => {
  const rule: AskRule = { mode: "markup", markupPips: new Decimal("1.5"), digits: 2 };
  const out = JSON.parse(rewriteTick({ symbol: "XAUUSD", bid: "4298.96", ask: "4299.13", t0: 1 }, rule));
  assert.deepEqual(out, { symbol: "XAUUSD", bid: "4298.96", ask: "4299.28", t0: 1 });
  assert.ok(!JSON.stringify(out).includes("4299.13"), "the raw ask must not reach the trader");
  const num = JSON.parse(rewriteTick({ symbol: "X", bid: 1.1, ask: 1.2 }, { mode: "markup", markupPips: new Decimal(0), digits: 1 }));
  assert.equal(typeof num.ask, "number");
});
