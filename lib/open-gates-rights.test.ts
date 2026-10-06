import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every code path that opens exposure (it calls the group min-volume gate, step 1) must also call the per-account
// trading-rights gate (step 3), so a new open path cannot ship without it. Static, no database.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

describe("trading rights at every open gate", () => {
  it("each file that checks the group minimum volume also checks the account's trading rights", () => {
    const files = [...walk("app"), ...walk("lib")].filter((f) => /checkGroupMinLot\(/.test(readFileSync(f, "utf8")) && !f.endsWith("risk.ts"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const missing = files.filter((f) => !/checkAccountTradingRights\(/.test(readFileSync(f, "utf8")));
    expect(missing).toEqual([]);
  });
});
