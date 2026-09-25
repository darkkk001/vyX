import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkGroupCloseOnly, checkGroupTradingHalted, checkCloseOnly } from "@/lib/risk";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

// Per-group close-only (2026-09-23): the dealing desk's own emergency controls are scoped to its
// group, so the desk can stop its own book without stopping the whole broker.
describe("checkGroupCloseOnly", () => {
  it("blocks when the group is close-only and passes when it is not", () => {
    expect(checkGroupCloseOnly({ closeOnlyAt: null })).toBeNull();
    expect(checkGroupCloseOnly({ closeOnlyAt: new Date() })).toContain("close-only");
  });

  it("names the GROUP, not the broker, so a trader can tell the two apart", () => {
    const group = checkGroupCloseOnly({ closeOnlyAt: new Date() })!;
    const broker = checkCloseOnly({ closeOnlyAt: new Date() })!;
    expect(group).toContain("group");
    expect(broker).toContain("broker");
    expect(group).not.toBe(broker);
  });

  it("is independent of the group's full halt", () => {
    // close-only set, halt clear: opening refused, but not by the halt gate
    expect(checkGroupTradingHalted({ tradingHaltedAt: null })).toBeNull();
    expect(checkGroupCloseOnly({ closeOnlyAt: new Date() })).not.toBeNull();
    // halt set, close-only clear: the halt gate is the one that fires
    expect(checkGroupTradingHalted({ tradingHaltedAt: new Date() })).not.toBeNull();
    expect(checkGroupCloseOnly({ closeOnlyAt: null })).toBeNull();
  });
});

// Every place that already gates an OPEN on the group's halt must gate it on close-only too, or a
// group could be put in close-only and still open positions through the path that was missed.
const OPEN_GATES = [
  "app/api/trade/orders/route.ts",
  "lib/pending-trigger.ts", // the pending LIMIT/STOP trigger fill (server trigger + the legacy fill route, Batch 4)
  "app/api/trade/orders/[id]/requote-response/route.ts",
  "app/api/manage/positions/route.ts",
  "app/api/manage/dealing-queue/[id]/route.ts",
  "app/api/manage/dealing-desk-toggle/route.ts",
  "lib/mirror.ts",
];

describe("per-group close-only is enforced at every open gate (static)", () => {
  it.each(OPEN_GATES)("%s checks checkGroupCloseOnly beside checkGroupTradingHalted", (file) => {
    const content = read(file);
    expect(content).toMatch(/checkGroupTradingHalted\(/);
    expect(content).toMatch(/checkGroupCloseOnly\(/);
  });

  it("the group row is actually selected with closeOnlyAt wherever it is narrowed", () => {
    // lib/mirror.ts is the one site that selects specific group columns rather than the whole row
    const content = read("lib/mirror.ts");
    const narrowed = content.match(/group: \{ select: \{[^}]*\}/g) ?? [];
    expect(narrowed.length).toBeGreaterThan(0);
    for (const sel of narrowed) {
      if (sel.includes("tradingHaltedAt")) expect(sel).toContain("closeOnlyAt");
    }
  });

  it("closing is never gated on it (a close-only group can still close)", () => {
    // the close paths must not have picked the gate up by accident
    for (const file of ["app/api/trade/positions/[id]/close/route.ts", "lib/bulk-close.ts", "lib/position-close.ts"]) {
      expect(read(file)).not.toMatch(/checkGroupCloseOnly\(/);
    }
  });
});
