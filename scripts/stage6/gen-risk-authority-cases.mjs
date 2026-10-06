// Stage 6: regenerates lib/risk-authority-cases.json, the case matrix BOTH the web rule (lib/risk-authority.ts riskOwnerOf,
// tested in lib/risk-authority.test.ts) and the engine rule (engine/order-management/src/authority.rs risk_owner_of,
// tested in its unit tests) are run against. The expected owner is written here from the rule stated once, in words:
//
//   RUST only when the broker's authority is exactly "RUST", the account mode is exactly "DEMO" or "LIVE", and
//   (the demo-only scope is exactly false, or the account is "DEMO"). Everything else is WEB.
//
// Full cross product of every shape a value can arrive in (right, wrong case, empty, null, unknown, omitted).
//
//   node scripts/stage6/gen-risk-authority-cases.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OMIT = Symbol("omit");
const authorities = ["WEB", "RUST", "rust", "", null, "SOMETHING_NEW", OMIT];
const demoOnlys = [true, false, null, OMIT];
const modes = ["DEMO", "LIVE", "demo", "", null, "WEIRD", OMIT];

const cases = [];
for (const authority of authorities) {
  for (const demoOnly of demoOnlys) {
    for (const mode of modes) {
      const rust = authority === "RUST" && (mode === "DEMO" || mode === "LIVE") && (demoOnly === false || mode === "DEMO");
      const c = {};
      if (authority !== OMIT) c.authority = authority;
      if (demoOnly !== OMIT) c.demoOnly = demoOnly;
      if (mode !== OMIT) c.mode = mode;
      c.owner = rust ? "RUST" : "WEB";
      cases.push(c);
    }
  }
}
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../lib/risk-authority-cases.json");
fs.writeFileSync(out, JSON.stringify(cases, null, 0).replace(/\},\{/g, "},\n{") + "\n");
console.log(`${cases.length} cases, ${cases.filter((c) => c.owner === "RUST").length} RUST -> ${out}`);
