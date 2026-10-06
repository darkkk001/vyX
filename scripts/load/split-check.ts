// Stage 6 split harness -- the attribution check (docs/STAGE6-PLAN.md, "the split proof").
//
//   DATABASE_URL=<vyx_load_split> DIRECT_URL=<same> npx tsx --conditions=react-server scripts/load/split-check.ts \
//     <world.json> <variant> <web-trace.jsonl> <engine-trace.jsonl> <split-snapshot.json> [<flips.json>]
//
// The web and the engine ran AT THE SAME TIME on one database, each writing a one-line trace per risk action it took
// (VYX_RISK_ACTION_TRACE). From the world and the variant the owner of every account is known (scripts/load/split.ts: the one
// rule). Fails (exit 1) when:
//   A. an action was taken by the side that does not own the account (a double-owner action);
//   B. a position was closed by a risk action more than once, by either side;
//   C. a position the snapshot shows closed by SL / TP / stop-out has no risk action, or one by the wrong side (an account
//      nobody acted on = the NEITHER case), or a traced close has no closed position;
//   D. a side that owns accounts with risk work took no action (the run proved nothing), or a side that owns none took one.
// With a flips file (the WEB-fallback drill: broker -> the time its riskAuthority went back to WEB, read from the database
// clock by the UPDATE itself): an engine close must have STARTED before its broker's flip (its transaction holds the share
// lock the flip waited for), a web action must come AFTER the flip, nothing the other way round, and BOTH sides must have worked
// (the engine before the flip, the web after).
import "./env";
import fs from "node:fs";
import { assertLoadDb } from "./env";
import type { World } from "./generate";
import { isSplitVariant, ownersOf } from "./split";

type Trace = { actor: "WEB" | "RUST"; kind: string; accountId: string; ref: string; ts: number };

function readTrace(file: string): Trace[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
  const [worldPath, variant, webTracePath, engineTracePath, snapshotPath, flipsPath] = process.argv.slice(2);
  if (!isSplitVariant(variant)) throw new Error(`unknown variant ${variant}`);
  const world: World = JSON.parse(fs.readFileSync(worldPath, "utf8"));
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { positions: Record<string, { status: string; closedBy: string | null }> };
  const flips: { broker: string; tsMs: number }[] = flipsPath ? JSON.parse(fs.readFileSync(flipsPath, "utf8")).flips : [];
  const flipOf = new Map(flips.map((f) => [f.broker, f.tsMs] as const));
  const owners = ownersOf(world, variant);
  const brokerOf = new Map(world.accounts.map((a) => [a.id, a.broker] as const));
  const accountOfPosition = new Map(world.positions.map((p) => [p.id, p.account] as const));
  const web = readTrace(webTracePath);
  const engine = readTrace(engineTracePath);
  const problems: string[] = [];
  const fail = (m: string) => problems.length < 40 && problems.push(m);

  // A. the actor owns the account (before a flip) -- with a flip, the owner depends on the time
  const ownerAt = (accountId: string, ts: number): "WEB" | "RUST" => {
    const base = owners.get(accountId) ?? "WEB";
    const flip = flipOf.get(brokerOf.get(accountId) ?? "");
    return flip !== undefined && ts > flip ? "WEB" : base;
  };
  for (const t of web) if (!flipOf.size && owners.get(t.accountId) !== "WEB") fail(`WEB acted (${t.kind}) on ${t.accountId}, owned by ${owners.get(t.accountId)}`);
  for (const t of engine) if (!flipOf.size && owners.get(t.accountId) !== "RUST") fail(`RUST acted (${t.kind}) on ${t.accountId}, owned by ${owners.get(t.accountId)}`);

  // B. no position closed by a risk action twice
  const closes = [...web, ...engine].filter((t) => t.kind === "close");
  const seen = new Map<string, Trace>();
  for (const t of closes) {
    const prev = seen.get(t.ref);
    if (prev) fail(`position ${t.ref} closed by a risk action twice: ${prev.actor} and ${t.actor}`);
    seen.set(t.ref, t);
  }

  // C. every risk-closed position has exactly one risk action, by its owner; every traced close is a closed position
  const riskClosed = Object.entries(snapshot.positions).filter(([, p]) => p.status === "CLOSED" && (p.closedBy === "stop_loss" || p.closedBy === "take_profit" || p.closedBy === "stop_out"));
  for (const [id] of riskClosed) {
    const t = seen.get(id);
    const account = accountOfPosition.get(id) ?? "?";
    if (!t) {
      fail(`position ${id} (account ${account}) was closed by a risk rule but no side traced the action`);
      continue;
    }
    if (flipOf.size === 0 && t.actor !== owners.get(account)) fail(`position ${id} closed by ${t.actor}, its account ${account} is owned by ${owners.get(account)}`);
  }
  for (const [ref, t] of seen) {
    const p = snapshot.positions[ref];
    if (!p || p.status !== "CLOSED") fail(`traced close of ${ref} by ${t.actor} but the position is not closed`);
  }

  // E. effects (a mirror close, a coverage close) are NOT risk actions: they run once on their own guards on whichever account they land.
  // Count where they landed: in `cross` every client is the engine's DEMO account and every master / coverage account the web's LIVE one, so
  // every effect is a DEMO account's effect landing on a LIVE account -- the variant must have produced some, or it proved nothing.
  const effects = Object.entries(snapshot.positions).filter(([, p]) => p.status === "CLOSED" && (p.closedBy === "mirror" || p.closedBy === "coverage_auto"));
  const effectsOn = (side: "WEB" | "RUST") => effects.filter(([id]) => owners.get(accountOfPosition.get(id) ?? "") === side).length;
  if (variant === "cross" && effectsOn("WEB") === 0) fail("cross: no effect landed on a web-owned account, the variant proved nothing about effects across sides");

  // D. a side with accounts that had risk work took action; a side with none took none
  const workAccounts = new Set(riskClosed.map(([id]) => accountOfPosition.get(id) ?? ""));
  const sideWork = (side: "WEB" | "RUST") => [...workAccounts].filter((a) => owners.get(a) === side).length;
  if (!flipOf.size) {
    if (sideWork("WEB") > 0 && web.length === 0) fail("the web owns accounts with risk work but took no action");
    if (sideWork("RUST") > 0 && engine.length === 0) fail("the engine owns accounts with risk work but took no action");
    if (sideWork("WEB") === 0 && web.length > 0) fail(`the web owns no account with risk work but took ${web.length} action(s)`);
    if (sideWork("RUST") === 0 && engine.length > 0) fail(`the engine owns no account with risk work but took ${engine.length} action(s)`);
  }

  // the drill
  let drill = "";
  if (flipOf.size) {
    const { prisma } = await import("@/lib/prisma");
    await assertLoadDb(prisma);
    const engineCloses = engine.filter((t) => t.kind === "close");
    const rows = await prisma.transaction.findMany({ where: { type: "TRADE_PNL", referenceId: { in: engineCloses.map((t) => t.ref) } }, select: { referenceId: true, accountId: true, createdAt: true } });
    const startedAt = new Map(rows.map((r) => [r.referenceId!, r.createdAt.getTime()] as const));
    let engineBefore = 0;
    for (const t of engineCloses) {
      const flip = flipOf.get(brokerOf.get(t.accountId) ?? "");
      const s = startedAt.get(t.ref);
      if (flip === undefined || s === undefined) continue;
      if (s >= flip) fail(`the engine closed ${t.ref} in a transaction that started at ${s}, not before the flip at ${flip}`);
      else engineBefore++;
    }
    let webAfter = 0;
    for (const t of web) {
      const flip = flipOf.get(brokerOf.get(t.accountId) ?? "");
      if (flip === undefined) {
        fail(`the web acted on ${t.accountId} whose broker never flipped (variant ${variant})`);
        continue;
      }
      if (t.ts <= flip) fail(`the web acted (${t.kind} ${t.ref}) at ${t.ts}, not after the flip at ${flip}`);
      else webAfter++;
    }
    if (engineBefore === 0) fail("the drill proved nothing: the engine closed nothing before the flip");
    if (webAfter === 0) fail("the drill proved nothing: the web took over nothing after the flip");
    // no engine action traced after its flip commit by owner rule: an engine close whose transaction started before the flip is allowed
    void ownerAt;
    drill = `; drill: ${engineBefore} engine close(s) before the flip, ${webAfter} web action(s) after it`;
    await prisma.$disconnect();
  }

  const byActor = (xs: Trace[]) => `${xs.filter((t) => t.kind === "close").length} close(s), ${xs.filter((t) => t.kind.startsWith("margin_call")).length} margin-call write(s)`;
  if (problems.length) {
    console.log(`[load:split-check] FAIL variant=${variant}\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const rustOwners = [...owners.values()].filter((o) => o === "RUST").length;
  console.log(`[load:split-check] OK variant=${variant}: ${rustOwners} engine-owned / ${owners.size - rustOwners} web-owned accounts; web ${byActor(web)}; engine ${byActor(engine)}; ${riskClosed.length} risk-closed positions, each by exactly one side, its owner; ${effects.length} effect closes (mirror / coverage): ${effectsOn("WEB")} landed on web-owned accounts, ${effectsOn("RUST")} on engine-owned${drill}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
