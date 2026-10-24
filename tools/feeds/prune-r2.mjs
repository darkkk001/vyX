// Update-feed cleanup rule (owner 2026-10-24): per broker and app, R2 keeps the newest 5 FULL packages.
// docs/FEED-BINARIES-DESIGN.md, "Cleanup rule".
//
// Kept per feed (public/native-<app>-updates/<slug>):
//   - the 5 newest Full packages (by version);
//   - Delta packages newer than the oldest kept Full (an older delta only upgrades from a version nobody can
//     install any more);
//   - Setup-*.exe and the portable zip (one name each, replaced by every publish).
// Everything else is pruned, in this order, so no client is ever pointed at a missing file:
//   1. --index: drop the pruned packages from releases.win.json and RELEASES in this checkout (then the usual web
//      commit, push and deploy);
//   2. --r2: delete from R2 only what the LIVE index on www.vyxtrader.com no longer lists (checked per file right
//      before the delete), so step 2 is harmless if step 1 was not deployed yet.
// Without a flag: a dry run that prints the plan. Futurix feeds follow the feed release rule: prune them only in an
// owner-approved window.
//
//   node tools/feeds/prune-r2.mjs [--keep 5] [--only <app>/<slug>] [--index] [--r2]
//   R2 credentials (for --r2): R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (never in the repo).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const KEEP = Number(opt("--keep", "5"));
const ONLY = opt("--only", null);
const LIVE = "https://www.vyxtrader.com";
const ROOT = new URL("../../public/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** "1.0.92" -> [1, 0, 92]; prerelease tags sort before the release. */
export function versionKey(v) {
  const [main, pre] = v.split("-");
  return [...main.split(".").map(Number), pre ? 0 : 1];
}
export function cmpVersion(a, b) {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The rule itself: which index assets stay and which go. */
export function plan(assets, keep = KEEP) {
  const fulls = assets.filter((a) => a.Type === "Full").sort((a, b) => cmpVersion(b.Version, a.Version));
  const keptFulls = fulls.slice(0, keep);
  const floor = keptFulls.length ? keptFulls[keptFulls.length - 1].Version : null;
  const stays = (a) =>
    a.Type === "Full" ? keptFulls.includes(a) : a.Type === "Delta" ? floor !== null && cmpVersion(a.Version, floor) > 0 : true;
  return { keep: assets.filter(stays), drop: assets.filter((a) => !stays(a)), floor };
}

function feeds() {
  const out = [];
  for (const app of ["native-terminal-updates", "native-backoffice-updates"]) {
    const dir = join(ROOT, app);
    if (!existsSync(dir)) continue;
    for (const slug of readdirSync(dir)) {
      const id = `${app.replace(/^native-|-updates$/g, "")}/${slug}`;
      if (ONLY && ONLY !== id) continue;
      if (existsSync(join(dir, slug, "releases.win.json"))) out.push({ id, rel: `${app}/${slug}`, dir: join(dir, slug) });
    }
  }
  return out;
}

async function liveListed(rel) {
  const r = await fetch(`${LIVE}/${rel}/releases.win.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`live index ${rel}: HTTP ${r.status}`);
  return new Set((await r.json()).Assets.map((a) => a.FileName));
}

async function r2Client() {
  const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  for (const v of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) if (!process.env[v]) throw new Error(`${v} is not set`);
  const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  return (key) => s3.send(new DeleteObjectCommand({ Bucket: "vyx-feeds", Key: key }));
}

async function main() {
  let del = null;
  for (const f of feeds()) {
    const file = join(f.dir, "releases.win.json");
    const index = JSON.parse(readFileSync(file, "utf8"));
    const p = plan(index.Assets);
    const mb = p.drop.reduce((s, a) => s + (a.Size ?? 0), 0) / 1e6;
    console.log(`${f.id}: keep ${p.keep.length} (fulls from ${p.floor ?? "-"}), prune ${p.drop.length} (${mb.toFixed(0)} MB)`);
    for (const a of p.drop) console.log(`  - ${a.FileName}`);
    if (flag("--index") && p.drop.length) {
      writeFileSync(file, JSON.stringify({ ...index, Assets: p.keep }));
      const rel = join(f.dir, "RELEASES");
      if (existsSync(rel)) {
        const gone = new Set(p.drop.map((a) => a.FileName));
        const lines = readFileSync(rel, "utf8").split(/\r?\n/).filter((l) => l && !gone.has(l.split(" ")[1]));
        writeFileSync(rel, lines.join("\n") + "\n");
      }
      console.log(`  index rewritten (commit, push, deploy before --r2)`);
    }
    if (flag("--r2") && p.drop.length) {
      del ??= await r2Client();
      const listed = await liveListed(f.rel);
      for (const a of p.drop) {
        if (listed.has(a.FileName)) {
          console.log(`  kept in R2 (the live index still lists it): ${a.FileName}`);
          continue;
        }
        await del(`${f.rel}/${a.FileName}`);
        console.log(`  deleted from R2: ${a.FileName}`);
      }
    }
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}` || process.argv[1]?.endsWith("prune-r2.mjs")) {
  await main();
}
