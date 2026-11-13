import { describe, expect, it } from "vitest";
import { amountRefusedForAuthority } from "@/lib/amount-sltp";
import { riskOwnerOf } from "@/lib/risk-authority";

// Engine live allowlist (DORMANT): the amount refusal follows the account's real risk owner. Proof that flag off / no entry is byte-same as the
// previous rule (verbatim copy below, from feat/engine-live-allowlist a66da65), and that an allowlisted LIVE account is judged as engine-owned.
function before(broker: { riskAuthority?: string | null; riskAuthorityDemoOnly?: boolean | null } | null | undefined, mode: string | null | undefined, env: Record<string, string | undefined>): boolean {
  if (env.ENGINE_AMOUNT_SLTP === "1") return false;
  return riskOwnerOf(broker, mode) === "RUST";
}
const auths = ["RUST", "WEB", null, undefined, "rust"] as const;
const demoOnlys = [true, false, null, undefined] as const;
const modes = ["DEMO", "LIVE", null, undefined, "live", "OTHER"] as const;
const flags = [true, false, null, undefined] as const;
const entries = [true, false, null, undefined] as const;
const envs = [{}, { ENGINE_AMOUNT_SLTP: "1" }, { ENGINE_AMOUNT_SLTP: "0" }, { ENGINE_AMOUNT_SLTP: "true" }];

function* all() {
  for (const a of auths) for (const d of demoOnlys) for (const m of modes) for (const f of flags) for (const e of entries) for (const env of envs) yield { a, d, m, f, e, env };
}

describe("amountRefusedForAuthority honours the engine live allowlist (dormant)", () => {
  it("flag off (false / null / missing): identical to the previous rule for every input", () => {
    let n = 0;
    for (const c of all()) {
      if (c.f === true) continue;
      const b = { riskAuthority: c.a, riskAuthorityDemoOnly: c.d, engineLiveAllowlistOn: c.f };
      expect(amountRefusedForAuthority(b, c.m, c.env, c.e)).toBe(before(b, c.m, c.env)); n++;
    }
    expect(n).toBe(5 * 4 * 6 * 3 * 4 * 4);
  });

  it("flag on, account not on the list: identical; and today's 3-argument call shape: identical", () => {
    for (const c of all()) {
      const b = { riskAuthority: c.a, riskAuthorityDemoOnly: c.d, engineLiveAllowlistOn: c.f };
      expect(amountRefusedForAuthority(b, c.m, c.env)).toBe(before(b, c.m, c.env));
      if (c.f === true && c.e !== true) expect(amountRefusedForAuthority(b, c.m, c.env, c.e)).toBe(before(b, c.m, c.env));
    }
  });

  it("the only differences: flag on + entry on + LIVE + RUST demo-only broker + engine amounts not on -> refused (engine-owned)", () => {
    const diffs = [];
    for (const c of all()) {
      const b = { riskAuthority: c.a, riskAuthorityDemoOnly: c.d, engineLiveAllowlistOn: c.f };
      const now = amountRefusedForAuthority(b, c.m, c.env, c.e);
      if (now !== before(b, c.m, c.env)) { diffs.push(c); expect(now).toBe(true); }
    }
    expect(diffs.length).toBe(3 * 3); // demo-only true/null/undefined x env {} / "0" / "true"
    for (const d of diffs) { expect(d).toMatchObject({ a: "RUST", m: "LIVE", f: true, e: true }); expect(d.d).not.toBe(false); expect(d.env.ENGINE_AMOUNT_SLTP).not.toBe("1"); }
  });

  it("allowlisted LIVE account: refused exactly as a DEMO account of the same broker; a non-listed LIVE peer stays WEB-judged", () => {
    const b = { riskAuthority: "RUST", riskAuthorityDemoOnly: true, engineLiveAllowlistOn: true };
    expect(amountRefusedForAuthority(b, "LIVE", {}, true)).toBe(amountRefusedForAuthority(b, "DEMO", {}));
    expect(amountRefusedForAuthority(b, "LIVE", {}, true)).toBe(true);
    expect(amountRefusedForAuthority(b, "LIVE", {}, false)).toBe(false);
    expect(amountRefusedForAuthority(b, "LIVE", { ENGINE_AMOUNT_SLTP: "1" }, true)).toBe(false); // engine watches amounts: allowed
    expect(amountRefusedForAuthority({ ...b, engineLiveAllowlistOn: false }, "LIVE", {}, true)).toBe(false);
  });
});
