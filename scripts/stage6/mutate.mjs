// Stage 6 mutation helper: replaces the first occurrence of SEARCH with REPLACE in FILE (exact text); exits 2 when SEARCH is not
// there, so a mutation that no longer applies is reported instead of silently "detected".
//   node scripts/stage6/mutate.mjs <file> <search> <replace>
import fs from "node:fs";

const [file, search, replace] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
if (!text.includes(search)) {
  console.error(`[mutate] ${file}: the text to mutate is not there:\n${search}`);
  process.exit(2);
}
fs.writeFileSync(file, text.replace(search, () => replace));
