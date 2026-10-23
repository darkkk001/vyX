// READ-ONLY report of the native-client build registry (lib/client-builds.ts), for the ClientBuild durability change
// (2026-10-23). Run on the VPS from the repo, with the gateway's REDIS_URL (the same Redis the web uses for sessions)
// in the environment; it only reads (SMEMBERS, SCAN, GET) and prints no secret:
//   cd C:\vyxtrader\repo\services\api-gateway
//   $env:REDIS_URL = "<the gateway's REDIS_URL>"; node ..\..\deploy\vps\client-build-registry-report.mjs
// Prints every registered build (buildId, broker, app, version, status, dates) and two consistency checks: keys that
// exist but are missing from the index (invisible to the admin list) and index entries whose key is gone.
import { Redis } from "ioredis";

const url = process.env.REDIS_URL;
if (!url) {
  console.error("REDIS_URL is not set");
  process.exit(2);
}
const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
await r.connect();
console.log(`redis host: ${new URL(url).host}`);

const index = new Set(await r.smembers("client_builds:index"));
const keys = new Set();
let cursor = "0";
do {
  const [next, batch] = await r.scan(cursor, "MATCH", "client_build:*", "COUNT", 500);
  cursor = next;
  for (const k of batch) keys.add(k.slice("client_build:".length));
} while (cursor !== "0");

const rows = [];
for (const id of [...new Set([...index, ...keys])].sort()) {
  const raw = await r.get(`client_build:${id}`);
  let b = null;
  try { b = raw ? JSON.parse(raw) : null; } catch { b = null; }
  rows.push({ buildId: id, broker: b?.brokerSubdomain ?? "?", app: b?.app ?? "?", version: b?.version ?? "?", status: b?.status ?? (raw ? "UNPARSEABLE" : "NO KEY"), createdAt: b?.createdAt ?? "", revokedAt: b?.revokedAt ?? "", inIndex: index.has(id) });
}
console.table(rows);
const byStatus = rows.reduce((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
console.log(`builds: ${rows.length}  index: ${index.size}  keys: ${keys.size}  by status: ${JSON.stringify(byStatus)}`);
console.log(`keys missing from the index: ${[...keys].filter((k) => !index.has(k)).join(", ") || "none"}`);
console.log(`index entries without a key: ${[...index].filter((k) => !keys.has(k)).join(", ") || "none"}`);
await r.quit();
