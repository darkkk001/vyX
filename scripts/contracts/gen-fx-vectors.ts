// Generates docs/contracts/fx-vectors.json FROM THE SERVER'S OWN FUNCTIONS (lib/fx.ts conversionRate, lib/trading.ts
// computeRealizedPnl, lib/margin.ts liveUsedMarginFor / requiredMarginFor / hedgedUsedMargin), so the server is the
// source of truth the terminal (C#) and the web trader are pinned to. lib/fx-contract.test.ts re-computes every
// expected value with the same functions and fails if the file and the server ever disagree.
//   NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json scripts/contracts/gen-fx-vectors.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { computeFxVectors, FX_VECTOR_INPUTS } from "../../lib/fx-contract";

const out = computeFxVectors(FX_VECTOR_INPUTS);
const file = path.resolve(import.meta.dirname, "..", "..", "docs", "contracts", "fx-vectors.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}: ${out.cases.length} cases, ${out.accounts.length} accounts`);
