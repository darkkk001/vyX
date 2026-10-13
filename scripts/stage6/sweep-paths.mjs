// Stage 6 local 7-path sweep, the per-path evidence. Reads one run-split.sh output directory (world.json, split-snapshot.json, the two traces) and
// prints, for each of the shadow bot's seven scenarios (tools/shadow-bot/scenarios, branch shadow-bot), the same RISK PATH as the harness world exercises it
// and how many times the ENGINE took it. Exits 1 when a path was not exercised by the engine (a sweep that skipped a path proves nothing).
//
//   S1 single stop-out      engine stop-out closes of ordinary accounts
//   S2 fan-in               engine closes inside the fan-in topology (many clients, one master, one coverage account)
//   S3 hedge break          margin-call notices written by the engine (the call edge) and the stop-outs that follow
//   S4 hedged + NBP         engine closes that ended at a zero balance on a negative-balance-protection broker (the write-off)
//   S5 coverage             coverage closes: the auto-hedged leg closed once with its client position (a follow-up of an engine close)
//   S6 mirror               mirror closes: the follower's copy closed with the master's (a follow-up of an engine close)
//   S7 FX                   engine closes of EUR-currency accounts and of JPY-quoted positions (cross-currency conversion)
//
// With --either (the drills and the mixed run, where the web legitimately takes part) a path counts when EITHER side took it.
// usage: node scripts/stage6/sweep-paths.mjs <run-split output dir> [--either]
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const either = process.argv.includes("--either");
if (!dir) throw new Error("usage: sweep-paths.mjs <run-split output dir>");
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const lines = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const world = read("world.json");
const snap = read("split-snapshot.json");
const engine = lines("engine-trace.jsonl");
const web = lines("web-trace.jsonl");

const account = new Map(world.accounts.map((a) => [a.id, a]));
const posAccount = new Map(world.positions.map((p) => [p.id, p.account]));
const posSymbol = new Map(world.positions.map((p) => [p.id, p.symbol]));
const nbpBroker = new Set(world.brokers.filter((b) => b.nbp).map((b) => b.id));
const fanIn = new Set((world.topologies.find((t) => t.name === "fan-in")?.accounts) ?? []);
const acting = either ? [...engine, ...web] : engine; // who counts for the path lines
const closes = acting.filter((t) => t.kind === "close");
const closedBy = (id) => snap.positions[id]?.closedBy;

const s1 = closes.filter((t) => closedBy(t.ref) === "stop_out" && account.get(t.accountId)?.role === "stopout").length;
const s2 = closes.filter((t) => fanIn.has(t.accountId)).length;
const s3 = acting.filter((t) => t.kind === "margin_call_in").length;
const s4 = closes.filter((t) => {
  const a = account.get(t.accountId);
  return a && nbpBroker.has(a.broker) && Number(snap.accounts[t.accountId]?.balance) === 0;
}).length;
const s5 = Object.values(snap.positions).filter((p) => p.closedBy === "coverage_auto").length;
const s6 = Object.values(snap.positions).filter((p) => p.closedBy === "mirror").length;
const s7 = closes.filter((t) => account.get(t.accountId)?.currency === "EUR" || posSymbol.get(t.ref) === "USDJPY").length;

const rows = [
  ["S1 single stop-out", s1],
  ["S2 fan-in", s2],
  ["S3 hedge break (margin-call notices from the engine)", s3],
  ["S4 hedged + negative-balance protection (write-off)", s4],
  ["S5 coverage (hedge leg closed with its client position)", s5],
  ["S6 mirror (copy closed with its master)", s6],
  ["S7 FX (EUR account / JPY-quoted position)", s7],
];
let bad = 0;
for (const [name, n] of rows) {
  console.log(`  ${n > 0 ? "PASS" : "FAIL"}  ${name}: ${n}${either ? " (either side)" : ""}`);
  if (n === 0) bad++;
}
void posAccount;
console.log(`  engine actions: ${engine.length} (${engine.filter((t) => t.kind === "close").length} closes), web actions: ${web.length}`);
process.exit(bad ? 1 : 0);
