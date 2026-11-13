import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { effectiveRiskOwner, engineLiveAllowed, riskOwnerOf, type RiskAuthorityFields, type RiskOwner } from "@/lib/risk-authority";

// Live cutover (owner 2026-11-11), DORMANT. Proof that the per-account engine allowlist changes NOTHING while its flag is off or the list is
// empty: the rule below is a verbatim copy of lib/risk-authority.ts as it was before this change (main 541ca98), compared with the new one
// over every combination of every input, including null / undefined / unknown values.
function riskOwnerOfBefore(broker: { riskAuthority?: string | null; riskAuthorityDemoOnly?: boolean | null } | null | undefined, accountMode: string | null | undefined): RiskOwner {
  if (!(broker?.riskAuthority === "RUST")) return "WEB";
  if (accountMode !== "DEMO" && accountMode !== "LIVE") return "WEB";
  const demoOnly = broker?.riskAuthorityDemoOnly !== false;
  return !demoOnly || accountMode === "DEMO" ? "RUST" : "WEB";
}
function effectiveBefore(broker: Parameters<typeof riskOwnerOfBefore>[0], accountMode: string | null | undefined, engineAlive: boolean | null | undefined): RiskOwner {
  return engineAlive === true ? riskOwnerOfBefore(broker, accountMode) : "WEB";
}

const authorities = ["RUST", "WEB", null, undefined, "rust", "OTHER"] as const;
const demoOnlys = [true, false, null, undefined] as const;
const modes = ["DEMO", "LIVE", null, undefined, "live", "OTHER"] as const;
const alives = [true, false, null, undefined] as const;
const flags = [true, false, null, undefined] as const;
const entries = [true, false, null, undefined] as const;

function* all() {
  for (const a of authorities) for (const d of demoOnlys) for (const m of modes) for (const al of alives) for (const f of flags) for (const e of entries)
    yield { a, d, m, al, f, e };
}

describe("engine live allowlist (dormant): flag off or list empty = today's rule, byte for byte", () => {
  it("flag OFF (false / null / missing), any account entry: every answer equals today's", () => {
    let n = 0;
    for (const c of all()) {
      if (c.f === true) continue;
      const broker: RiskAuthorityFields = { riskAuthority: c.a, riskAuthorityDemoOnly: c.d, engineLiveAllowlistOn: c.f };
      expect(riskOwnerOf(broker, c.m, c.e)).toBe(riskOwnerOfBefore(broker, c.m));
      expect(effectiveRiskOwner(broker, c.m, c.al, c.e)).toBe(effectiveBefore(broker, c.m, c.al));
      expect(engineLiveAllowed(broker, c.m, c.e)).toBe(false);
      n++;
    }
    expect(n).toBe(6 * 4 * 6 * 4 * 3 * 4);
  });

  it("flag ON but the account NOT on the list (false / null / missing): every answer equals today's", () => {
    for (const c of all()) {
      if (c.f !== true || c.e === true) continue;
      const broker: RiskAuthorityFields = { riskAuthority: c.a, riskAuthorityDemoOnly: c.d, engineLiveAllowlistOn: true };
      expect(riskOwnerOf(broker, c.m, c.e)).toBe(riskOwnerOfBefore(broker, c.m));
      expect(effectiveRiskOwner(broker, c.m, c.al, c.e)).toBe(effectiveBefore(broker, c.m, c.al));
    }
  });

  it("callers that pass no allowlist inputs at all (today's call shape) get today's answer", () => {
    for (const c of all()) {
      const broker = { riskAuthority: c.a, riskAuthorityDemoOnly: c.d };
      expect(riskOwnerOf(broker, c.m)).toBe(riskOwnerOfBefore(broker, c.m));
      expect(effectiveRiskOwner(broker, c.m, c.al)).toBe(effectiveBefore(broker, c.m, c.al));
    }
  });

  it("the ONLY difference: flag on + account on the list + LIVE + RUST broker that is demo-only + engine alive", () => {
    const diffs: string[] = [];
    for (const c of all()) {
      const broker: RiskAuthorityFields = { riskAuthority: c.a, riskAuthorityDemoOnly: c.d, engineLiveAllowlistOn: c.f };
      if (effectiveRiskOwner(broker, c.m, c.al, c.e) !== effectiveBefore(broker, c.m, c.al)) diffs.push(JSON.stringify(c));
    }
    // demo-only is true / null / undefined (3 values); everything else is pinned
    expect(diffs.length).toBe(3);
    for (const d of diffs.map((s) => JSON.parse(s))) {
      expect(d).toMatchObject({ a: "RUST", m: "LIVE", al: true, f: true, e: true });
      expect(d.d).not.toBe(false);
    }
  });

  it("the shared case matrix (the engine and gateway are tested on the same file) matches this implementation", () => {
    const file = path.join(process.cwd(), "lib", "engine-live-allowlist-cases.json");
    const cases = JSON.parse(readFileSync(file, "utf8")) as { riskAuthority: string | null; riskAuthorityDemoOnly: boolean | null; engineLiveAllowlistOn: boolean | null; accountMode: string | null; engineLiveEnabled: boolean | null; modeAllowed: boolean; owner: RiskOwner }[];
    expect(cases.length).toBeGreaterThan(50);
    for (const c of cases) {
      const broker = { riskAuthority: c.riskAuthority, riskAuthorityDemoOnly: c.riskAuthorityDemoOnly, engineLiveAllowlistOn: c.engineLiveAllowlistOn };
      expect(riskOwnerOf(broker, c.accountMode, c.engineLiveEnabled)).toBe(c.owner);
      // engine ingress::mode_allowed with a scope installed (restricted() == true): DEMO, or LIVE on the allowlist
      expect(c.accountMode === "DEMO" || engineLiveAllowed(broker, c.accountMode, c.engineLiveEnabled)).toBe(c.modeAllowed);
    }
  });
});
