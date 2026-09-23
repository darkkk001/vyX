#!/usr/bin/env node
// Stage 0 parity harness -- compares engine/parity/out/ts/*.json (web path, scripts/parity/run-ts.ts)
// with engine/parity/out/rust/*.json (engine path, `cargo run -p parity`).
//
//   node scripts/parity/diff.mjs [--markdown]
//
// Per scenario: MATCH (identical), EXPECTED-DIVERGENCE (every differing field is listed in one of
// the scenario's knownDivergence[].fields) or FAIL (anything else, including a missing output).
// Exit code 1 when any scenario FAILs. A scenario that declares a divergence but matches is shown
// as MATCH with a "(declared divergence absent)" note -- once Stage 2 aligns Rust, drop the entry.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const scenarioDir = path.join(root, "engine", "parity", "scenarios");
const tsDir = path.join(root, "engine", "parity", "out", "ts");
// --rust-dir rust-db compares the web against the engine's DB mode (Stage 1: the real monitor on the real
// schema, `cargo run -p parity -- --db`) instead of the pure-calc run
const rustDirArg = process.argv.indexOf("--rust-dir");
const rustDir = path.join(root, "engine", "parity", "out", rustDirArg > 0 ? process.argv[rustDirArg + 1] : "rust");
const markdown = process.argv.includes("--markdown");

const FIELDS = ["marginLevelBefore", "closedPositionIds", "closeReasons", "finalBalance", "finalCredit", "transactions", "marginCallNotified"];
const LEVEL_TOL = 1e-9; // both sides compute in exact decimal; only representation may differ
const MONEY_TOL = 1e-4; // DB columns are Decimal(18,4)

const num = (v) => (v == null ? null : Number(v));
const fmtLevel = (v) => (v == null ? "null" : Number(v).toFixed(2));
const fmtTx = (t) => t.map((x) => `${x.type === "TRADE_PNL" ? "PNL" : x.type}:${Number(x.amount)}`).join(",") || "-";

function fieldDiff(field, a, b) {
  switch (field) {
    case "marginLevelBefore": {
      if (a == null || b == null) return a === b ? null : `level ts=${fmtLevel(a)} rust=${fmtLevel(b)}`;
      return Math.abs(num(a) - num(b)) <= LEVEL_TOL * Math.max(1, Math.abs(num(a))) ? null : `level ts=${fmtLevel(a)} rust=${fmtLevel(b)}`;
    }
    case "finalBalance":
      return Math.abs(num(a) - num(b)) <= MONEY_TOL ? null : `balance ts=${Number(a)} rust=${Number(b)}`;
    case "finalCredit": // Stage 2 F1: a loss beyond the balance consumes credit
      return Math.abs(num(a) - num(b)) <= MONEY_TOL ? null : `credit ts=${Number(a)} rust=${Number(b)}`;
    case "transactions": {
      const same = a.length === b.length && a.every((x, i) => x.type === b[i].type && Math.abs(num(x.amount) - num(b[i].amount)) <= MONEY_TOL);
      return same ? null : `txns ts=[${fmtTx(a)}] rust=[${fmtTx(b)}]`;
    }
    case "closedPositionIds":
    case "closeReasons":
      return JSON.stringify(a) === JSON.stringify(b) ? null : `${field === "closedPositionIds" ? "closed" : "reasons"} ts=[${a.join(",")}] rust=[${b.join(",")}]`;
    case "marginCallNotified":
      return a === b ? null : `marginCall ts=${a} rust=${b}`;
  }
}

const rows = [];
let failures = 0;
for (const file of fs.readdirSync(scenarioDir).filter((f) => f.endsWith(".json")).sort()) {
  const sc = JSON.parse(fs.readFileSync(path.join(scenarioDir, file), "utf8"));
  const known = sc.knownDivergence ?? [];
  const read = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { return null; }
  };
  const ts = read(tsDir);
  const rust = read(rustDir);
  if (!ts || !rust) {
    failures++;
    rows.push({ name: sc.name, status: "FAIL", details: [`missing output: ${!ts ? "ts " : ""}${!rust ? "rust" : ""}`.trim()] });
    continue;
  }
  const details = [];
  const unexpected = [];
  const usedIds = new Set();
  for (const acct of sc.accounts.map((a) => a.key)) {
    const a = ts.accounts[acct];
    const b = rust.accounts[acct];
    if (!a || !b) {
      unexpected.push(`${acct}: missing in ${!a ? "ts" : "rust"}`);
      continue;
    }
    for (const f of FIELDS) {
      const d = fieldDiff(f, a[f], b[f]);
      if (!d) continue;
      const cover = known.find((k) => k.fields.includes(f));
      const prefix = sc.accounts.length > 1 ? `${acct}.` : "";
      if (cover) {
        usedIds.add(cover.id);
        details.push(`${prefix}${d} [${cover.id}]`);
      } else {
        unexpected.push(`${prefix}${d}`);
      }
    }
  }
  let status;
  if (unexpected.length) {
    status = "FAIL";
    failures++;
  } else if (details.length) {
    status = "EXPECTED-DIVERGENCE";
  } else {
    status = "MATCH";
  }
  const absent = known.filter((k) => !usedIds.has(k.id)).map((k) => k.id);
  if (absent.length && status !== "FAIL") details.push(`(declared divergence absent: ${absent.join(", ")})`);
  rows.push({ name: sc.name, status, details: [...unexpected.map((u) => `UNEXPECTED ${u}`), ...details] });
}

if (markdown) {
  console.log("| scenario | result | what differs |");
  console.log("|---|---|---|");
  for (const r of rows) console.log(`| ${r.name} | ${r.status} | ${r.details.join("; ").replace(/\|/g, "\\|") || "-"} |`);
} else {
  const w1 = Math.max(...rows.map((r) => r.name.length), 8);
  const w2 = 19;
  console.log(`${"scenario".padEnd(w1)} | ${"result".padEnd(w2)} | what differs`);
  console.log(`${"-".repeat(w1)}-+-${"-".repeat(w2)}-+-${"-".repeat(40)}`);
  for (const r of rows) console.log(`${r.name.padEnd(w1)} | ${r.status.padEnd(w2)} | ${r.details.join("; ") || "-"}`);
}
const count = (s) => rows.filter((r) => r.status === s).length;
console.log(`\n${rows.length} scenarios: ${count("MATCH")} MATCH, ${count("EXPECTED-DIVERGENCE")} EXPECTED-DIVERGENCE, ${count("FAIL")} FAIL`);
process.exit(failures ? 1 : 0);
