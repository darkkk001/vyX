import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeLeverageHmrVectors, marginExpect, openLeverageExpect } from "@/lib/leverage-hmr-contract";

// docs/contracts/leverage-hmr-vectors.json is generated FROM the web's own functions; the engine is pinned to it (gate_parity.rs).
// This fails when the committed file and the web disagree: regenerate with scripts/contracts/gen-leverage-hmr-vectors.ts.
const file = path.resolve(import.meta.dirname, "..", "docs", "contracts", "leverage-hmr-vectors.json");
const committed = JSON.parse(readFileSync(file, "utf8"));

describe("leverage + HMR contract vectors", () => {
  it("the committed file is exactly what the web computes now", () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(computeLeverageHmrVectors())));
  });
  it("every open_leverage case re-computes", () => {
    for (const c of committed.open_leverage) expect(openLeverageExpect(c.input), c.input.note).toEqual(c.expect);
  });
  it("every margin case re-computes", () => {
    for (const c of committed.margin) expect(marginExpect(c.input), c.input.note).toEqual(c.expect);
  });
  it("the vectors cover the rules the spec names", () => {
    const notes = committed.open_leverage.map((c: { input: { note: string } }) => c.input.note).join("\n");
    for (const needle of ["plugin off", "overlapping", "outside", "exactly at endsAt", "disabled"]) expect(notes).toContain(needle);
    const margin = committed.margin.map((c: { expect: { reject: string | null } }) => c.expect.reject);
    expect(margin).toContain("INSUFFICIENT_MARGIN");
    expect(margin).toContain("INSUFFICIENT_BALANCE");
    expect(margin).toContain(null);
  });
});
