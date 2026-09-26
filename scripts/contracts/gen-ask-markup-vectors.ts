// Generates docs/contracts/ask-markup-vectors.json FROM THE SERVER'S OWN FUNCTIONS (lib/ask-markup.ts), the price a
// SELL closes at and the rule that decides it. lib/ask-markup.test.ts fails if the file and the server disagree.
//   NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json scripts/contracts/gen-ask-markup-vectors.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { computeAskMarkupVectors } from "../../lib/ask-markup-contract";

const out = computeAskMarkupVectors();
const file = path.resolve(import.meta.dirname, "..", "..", "docs", "contracts", "ask-markup-vectors.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}: ${out.resolution.length} resolution cases, ${out.prices.length} price cases`);
