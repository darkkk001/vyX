import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Execution latency Phase 1 (item 3): WebTrader draws its own fill / full close from the order's answer at once; the
// positions / account / history reads only reconcile afterwards (they used to be awaited first: one more round trip
// through Vercel before the position appeared).
const src = readFileSync(join(process.cwd(), "components", "webtrader", "WebTrader.tsx"), "utf8");
const between = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe("WebTrader: own fill and close from the answer", () => {
  it("a market fill is applied from result.position before any read, and the reads are not awaited", () => {
    const fill = between("if (result.position) {", "} else {");
    expect(fill).toContain("applyOwnFill(result.position, result.balance);");
    expect(fill.indexOf("applyOwnFill(")).toBeLessThan(fill.indexOf("refreshPositions()"));
    expect(fill).toContain("void Promise.all([refreshPositions(), refreshAccount()]);");
    expect(fill).not.toContain("await Promise.all([refreshPositions()");
  });

  it("a full close leaves the table at once with its sound; a partial still waits for the read (its remainder comes from it)", () => {
    const close = between("const res = await tradeApi.closePosition(id, price);", "} catch (err)");
    expect(close).toContain("applyOwnFullClose(id, answer.balance);");
    expect(close).toContain('playSound("positionClosed"');
    expect(close).toContain("if (answer.partial) {");
  });

  it("the helpers keep the close-sound diff in step (no second sound from the background read)", () => {
    expect(src).toContain("prevPositionsRef.current.set(pos.id, pos);");
    expect(src).toContain("prevPositionsRef.current.delete(id);");
  });
});
