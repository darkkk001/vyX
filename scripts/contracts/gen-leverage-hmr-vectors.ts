// Generates docs/contracts/leverage-hmr-vectors.json FROM THE SERVER'S OWN FUNCTIONS (lib/leverage-hmr-contract.ts), so the web is the
// source of truth the engine (engine/order-management/tests/gate_parity.rs) is pinned to. lib/leverage-hmr-contract.test.ts re-computes every
// expected value and fails if the file and the web ever disagree.
//   NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json scripts/contracts/gen-leverage-hmr-vectors.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { computeLeverageHmrVectors } from "../../lib/leverage-hmr-contract";

const out = computeLeverageHmrVectors();
const file = path.resolve(import.meta.dirname, "..", "..", "docs", "contracts", "leverage-hmr-vectors.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}: ${out.open_leverage.length} open_leverage cases, ${out.margin.length} margin cases`);
