import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientRefusal } from "@/lib/client-reason";
import { amountRefusalBody } from "@/lib/amount-sltp";
import { amountRefusalText } from "@/components/webtrader/sltp-units";

// Amount SL / TP in the WebTrader (owner 2026-11-04). WebTrader has no DOM test harness, so the wiring is pinned by source like
// lib/webtrader-session-lost.test.ts; the unit logic itself is tested in components/webtrader/sltp-units.test.ts.
const root = path.join(__dirname, "..");
const src = readFileSync(path.join(root, "components", "webtrader", "WebTrader.tsx"), "utf8");
const css = readFileSync(path.join(root, "app", "(broker)", "trade", "webtrader-native.css"), "utf8") + readFileSync(path.join(root, "app", "(broker)", "trade", "webtrader.css"), "utf8");
const fn = (name: string) => {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return src.slice(start, start + 3600);
};

describe("order ticket", () => {
  it("has the Price / Pips / Amount selector (radio group) over both legs, defaulting to Price", () => {
    expect(src).toContain('const [slTpUnit, setSlTpUnit] = useState<SlTpUnit>("price")');
    expect(src).toContain('role="radiogroup" aria-label="Stop loss and take profit unit"');
    expect(src).toContain("SLTP_UNITS.map((u) =>");
  });
  it("a market order and a pending order send their legs through the one unit-aware path", () => {
    for (const name of ["placeOrder", "placePendingOrder"]) {
      const body = fn(name);
      expect(body, name).toContain("ticketLegs(side,");
      expect(body, name).toContain("...(legs.slAmount ? { slAmount: legs.slAmount } : {})");
      expect(body, name).toContain("slPrice: legs.slPrice, tpPrice: legs.tpPrice");
      expect(body, name).toContain("showAmountRefusal(err)");
    }
  });
  it("only the price unit is judged against the bid on the client, and the risk % row is price-only", () => {
    expect(src).toContain("const ticketPriceUnit = slTpUnit === \"price\"");
    expect(src).toMatch(/const buyDisabled = [^;]*ticketPriceUnit &&/);
    expect(src).toMatch(/slTpUnit === "price" \? \(\s*<div className="nt-row">\s*<span className="nt-row-label">Risk %<\/span>/);
  });
  it("the server's amount refusal is shown inline under the SL / TP rows, not as a toast", () => {
    expect(src).toContain('{ticketSltpError ? <div className="nt-sltp-error" role="alert">{ticketSltpError}</div> : null}');
    expect(fn("showAmountRefusal")).toContain("setTicketSltpError(text)");
    expect(css).toMatch(/\.nt-sltp-error \{[^}]*var\(--err\)/);
  });
});

describe("position SL / TP edit", () => {
  it("opens from the row's action button and from an amount cell, with the same selector", () => {
    expect(src).toContain('title="Stop loss and take profit" onClick={() => openSltpEditForPosition(p.id)}');
    expect(src).toContain("if (p.slAmount && !p.slPrice) openSltpEditForPosition(p.id)");
    expect(src).toContain("if (p.tpAmount && !p.tpPrice) openSltpEditForPosition(p.id)");
    expect(src).toContain("changeSltpUnit(u.key)");
  });
  it("saving sends legs through legForModify and keeps the modal open on an amount refusal", () => {
    const save = src.slice(src.indexOf("async function saveSltpEdit()"), src.indexOf("// ---------- inline SL/TP edit ----------"));
    expect(save).toContain("legForModify({");
    expect(save).toContain("keepOpenOnAmountRefusal(err)");
    expect(save).toContain("...(slLeg.wire.amount !== undefined ? { slAmount: slLeg.wire.amount } : {})");
    expect(src).toContain('{sltpEdit.error ? <div className="sltp-edit-error" role="alert">{sltpEdit.error}</div> : null}');
  });
  it("the inline price edit is untouched: still a price field that commits slPrice / tpPrice", () => {
    expect(src).toContain('await tradeApi.editPositionSlTp(id, { currentPrice: ref, ...(field === "sl" ? { slPrice: value } : { tpPrice: value }) });');
  });
});

describe("amounts on screen use the platform colours", () => {
  it("TP blue, SL red, in the account currency", () => {
    expect(css).toMatch(/\.sltp-amount\.sl \{ color: var\(--sell\); \}/);
    expect(css).toMatch(/\.sltp-amount\.tp \{ color: var\(--buy\); \}/);
    expect(src).toContain('className="mono sltp-amount sl"');
    expect(src).toContain('className="mono sltp-amount tp"');
    expect(css).not.toMatch(/\.sltp-amount[^{]*\{[^}]*var\(--ok\)/); // green is status only
  });
});

describe("what the server says reaches the screen", () => {
  it("an amount refusal's sentence survives clientRefusal and is what the screen reads", () => {
    const body = clientRefusal(amountRefusalBody("AMOUNT_ALREADY_REACHED", "SL amount 10.00 USD is already reached (P/L -10.00 USD): it would close at once"));
    expect(amountRefusalText({ body })).toBe("SL amount 10.00 USD is already reached (P/L -10.00 USD): it would close at once");
  });
});
