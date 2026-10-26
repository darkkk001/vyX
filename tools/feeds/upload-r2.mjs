// Update-feed publish to R2 (docs/FEED-BINARIES-DESIGN.md, step 5; owner 2026-10-26). Run by the publish scripts AFTER
// the packages are built into a feed folder and BEFORE its index files are committed to the web repo:
//
//   node tools/feeds/upload-r2.mjs <feed folder> <app> <slug>
//     <feed folder>  the folder Velopack wrote (its *.nupkg, Setup / portable and releases.win.json)
//     <app>          terminal | backoffice          <slug>  the broker's feed slug (qoretrader, futurixglobal, ...)
//
// 1. Every .nupkg / .exe / .zip in the folder is uploaded to bucket vyx-feeds at native-<app>-updates/<slug>/<file>,
//    unless R2 already has it with the same size and sha256. A versioned package (.nupkg) is never overwritten: one
//    already there with other bytes stops the run. Setup / portable keep one name per brand and are replaced.
// 2. Each file is downloaded again through https://feeds.vyxtrader.com and compared byte for byte with the local file,
//    and every package with the SHA256 the folder's releases.win.json lists (what Velopack checks).
// Exit 0 = every file is in R2 and correct: the index may be committed. Anything else: do NOT commit the index.
//
// Credentials: C:\vyx-secrets\r2-token.txt (TOKEN_VALUE, ENDPOINT; the S3 key id is the token's id, the secret its
// sha256), or R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY. Never in the repo.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const [dir, app, slug] = process.argv.slice(2);
if (!dir || !["terminal", "backoffice"].includes(app ?? "") || !slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error("usage: node tools/feeds/upload-r2.mjs <feed folder> <terminal|backoffice> <slug>");
  process.exit(2);
}
const BUCKET = "vyx-feeds";
const PUBLIC = "https://feeds.vyxtrader.com";
const prefix = `native-${app}-updates/${slug}`;

async function credentials() {
  if (process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
    return { endpoint: process.env.R2_ENDPOINT, id: process.env.R2_ACCESS_KEY_ID, secret: process.env.R2_SECRET_ACCESS_KEY };
  const env = Object.fromEntries(
    readFileSync("C:/vyx-secrets/r2-token.txt", "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const acc = env.ENDPOINT.replace(/^https:\/\/([0-9a-f]+)\..*$/, "$1");
  const v = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/tokens/verify`, { headers: { Authorization: `Bearer ${env.TOKEN_VALUE}` } })).json();
  if (!v.success) throw new Error("R2 token check failed");
  return { endpoint: env.ENDPOINT, id: v.result.id, secret: createHash("sha256").update(env.TOKEN_VALUE).digest("hex") };
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const files = readdirSync(dir).filter((f) => /\.(nupkg|exe|zip)$/.test(f) && statSync(join(dir, f)).isFile()).sort();
if (files.length === 0) {
  console.error(`${dir}: no .nupkg / .exe / .zip`);
  process.exit(2);
}
const indexFile = join(dir, "releases.win.json");
const index = new Map(existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")).Assets.map((a) => [a.FileName, a.SHA256.toLowerCase()]) : []);

const c = await credentials();
const s3 = new S3Client({ region: "auto", endpoint: c.endpoint, credentials: { accessKeyId: c.id, secretAccessKey: c.secret } });

let uploaded = 0, present = 0;
const bad = [];
for (const f of files) {
  const body = readFileSync(join(dir, f));
  const local = sha(body);
  const key = `${prefix}/${f}`;
  if (index.has(f) && index.get(f) !== local) {
    bad.push(`${f}: local file does not match its releases.win.json SHA256`);
    continue;
  }
  let have = null;
  try {
    have = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) {
    if (e.name !== "NotFound" && e.$metadata?.httpStatusCode !== 404) throw e;
  }
  if (have && have.ContentLength === body.length && have.Metadata?.sha256 === local) {
    present++;
    continue;
  }
  if (have && f.endsWith(".nupkg")) {
    bad.push(`${f}: already in R2 with other bytes (packages are never overwritten)`);
    continue;
  }
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body, ContentLength: body.length,
    ContentType: f.endsWith(".zip") ? "application/zip" : "application/octet-stream",
    CacheControl: f.endsWith(".nupkg") ? "public, max-age=31536000, immutable" : "public, max-age=300",
    Metadata: { sha256: local },
  }));
  uploaded++;
}

// the byte check, through the public domain the redirect points at
for (const f of files) {
  const local = sha(readFileSync(join(dir, f)));
  let ok = false, why = "";
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    try {
      const r = await fetch(`${PUBLIC}/${prefix}/${f}?check=${Date.now()}`);
      if (!r.ok) { why = `HTTP ${r.status}`; continue; }
      const got = sha(Buffer.from(await r.arrayBuffer()));
      if (got !== local) { why = "bytes differ from the local file"; break; }
      ok = true;
    } catch (e) {
      why = e.message;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
  if (!ok) bad.push(`${f}: ${why} (through ${PUBLIC})`);
}

console.log(`${prefix}: ${files.length} files, ${uploaded} uploaded, ${present} already there, ${index.size} in releases.win.json`);
if (bad.length) {
  for (const b of bad) console.error("FAIL " + b);
  console.error("Do NOT commit this feed's index: R2 does not hold every file correctly.");
  process.exit(1);
}
console.log("OK: every file is in R2 and byte-checked; the index may be committed.");
