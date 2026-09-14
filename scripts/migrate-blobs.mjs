// Account migration: copy every blob from the OLD Vercel Blob stores to the NEW ones and
// rewrite the URLs the database points at (Broker.logoUrl, KycRecord / ClientKycRecord
// documentFrontUrl / documentBackUrl / addressProofUrl).
//
// Two stores, two tokens each side:
//   public  store  BLOB_READ_WRITE_TOKEN      (broker logos, path broker-logos/...)
//   private store  PRIVATE_READ_WRITE_TOKEN   (KYC documents, path kyc/...)
//
// usage (PowerShell), one store at a time -- DOWNLOAD first, verify, then UPLOAD:
//   $env:OLD_TOKEN="<old BLOB_READ_WRITE_TOKEN>"; node scripts/migrate-blobs.mjs download public  C:\blob-export
//   $env:OLD_TOKEN="<old PRIVATE_READ_WRITE_TOKEN>"; node scripts/migrate-blobs.mjs download private C:\blob-export
//   $env:NEW_TOKEN="<new BLOB_READ_WRITE_TOKEN>"; node scripts/migrate-blobs.mjs upload public  C:\blob-export
//   $env:NEW_TOKEN="<new PRIVATE_READ_WRITE_TOKEN>"; node scripts/migrate-blobs.mjs upload private C:\blob-export
//   $env:DATABASE_URL="<NEW Neon direct url>"; node scripts/migrate-blobs.mjs rewrite C:\blob-export
//
// download: lists the old store (paginated) and saves every blob under <dir>/<store>/<pathname>
//           plus <dir>/<store>.manifest.json (pathname, old url, size, contentType).
// upload:   puts every file back at the SAME pathname on the new store (addRandomSuffix:false so
//           the path is stable) and writes <dir>/<store>.urlmap.json { oldUrl: newUrl }.
// rewrite:  applies both url maps to the DB columns with exact-match UPDATEs, in one transaction,
//           printing how many rows changed per column. Run it only after BOTH uploads succeeded.
//
// Nothing here deletes anything on the old side.
import { list, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";

const [mode, storeOrDir, maybeDir] = process.argv.slice(2);
const stores = ["public", "private"];

async function download(store, dir) {
  const token = process.env.OLD_TOKEN;
  if (!token) throw new Error("OLD_TOKEN not set");
  const manifest = [];
  let cursor;
  do {
    const page = await list({ token, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const target = path.join(dir, store, b.pathname);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // private-store blobs need the token on the GET; public ones accept it too
      const res = await fetch(b.url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`GET ${b.url} -> ${res.status}`);
      await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
      manifest.push({ pathname: b.pathname, url: b.url, size: b.size, uploadedAt: b.uploadedAt });
      console.log(`saved ${store}/${b.pathname} (${b.size} B)`);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  await fs.writeFile(path.join(dir, `${store}.manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(`${store}: ${manifest.length} blobs, manifest written`);
}

async function upload(store, dir) {
  const token = process.env.NEW_TOKEN;
  if (!token) throw new Error("NEW_TOKEN not set");
  const manifest = JSON.parse(await fs.readFile(path.join(dir, `${store}.manifest.json`), "utf8"));
  const urlmap = {};
  for (const m of manifest) {
    const body = await fs.readFile(path.join(dir, store, m.pathname));
    const res = await put(m.pathname, body, { token, access: store === "public" ? "public" : "private", addRandomSuffix: false });
    urlmap[m.url] = res.url;
    console.log(`uploaded ${store}/${m.pathname} -> ${res.url}`);
  }
  await fs.writeFile(path.join(dir, `${store}.urlmap.json`), JSON.stringify(urlmap, null, 2));
  console.log(`${store}: ${Object.keys(urlmap).length} urls mapped`);
}

async function rewrite(dir) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const map = {};
  for (const s of stores) {
    try { Object.assign(map, JSON.parse(await fs.readFile(path.join(dir, `${s}.urlmap.json`), "utf8"))); }
    catch { console.warn(`no ${s}.urlmap.json -- skipping that store`); }
  }
  const entries = Object.entries(map);
  if (entries.length === 0) throw new Error("nothing to rewrite");
  const columns = [
    ["Broker", "logoUrl"],
    ["KycRecord", "documentFrontUrl"], ["KycRecord", "documentBackUrl"], ["KycRecord", "addressProofUrl"],
    ["ClientKycRecord", "documentFrontUrl"], ["ClientKycRecord", "documentBackUrl"], ["ClientKycRecord", "addressProofUrl"],
  ];
  await prisma.$transaction(async (tx) => {
    for (const [table, col] of columns) {
      let changed = 0;
      for (const [oldUrl, newUrl] of entries) {
        const n = await tx.$executeRawUnsafe(`UPDATE "${table}" SET "${col}" = $1 WHERE "${col}" = $2`, newUrl, oldUrl);
        changed += n;
      }
      console.log(`${table}.${col}: ${changed} rows rewritten`);
    }
  });
  await prisma.$disconnect();
}

if (mode === "download" && stores.includes(storeOrDir) && maybeDir) await download(storeOrDir, maybeDir);
else if (mode === "upload" && stores.includes(storeOrDir) && maybeDir) await upload(storeOrDir, maybeDir);
else if (mode === "rewrite" && storeOrDir) await rewrite(storeOrDir);
else { console.error("usage: node scripts/migrate-blobs.mjs download|upload public|private <dir>   |   rewrite <dir>"); process.exit(1); }
