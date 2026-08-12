#!/usr/bin/env node
// Copies the built installer + electron-updater metadata into the Next.js
// app's public/ folder, so Vercel serves them as a plain static "generic"
// update feed (see package.json's build.publish.url) — no separate hosting
// needed, reuses the same deployment this app already has.
// Usage: npm run build && npm run publish, then commit + push the repo.

const fs = require("fs");
const path = require("path");

const releaseDir = path.join(__dirname, "release");
const destDir = path.join(__dirname, "..", "public", "desktop-updates");

if (!fs.existsSync(releaseDir)) {
  console.error("No release/ folder — run `npm run build` first.");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });

const patterns = [/\.exe$/, /\.exe\.blockmap$/, /^latest.*\.yml$/];
const files = fs.readdirSync(releaseDir).filter((f) => patterns.some((p) => p.test(f)));

if (files.length === 0) {
  console.error("No installer/update metadata found in release/ — run `npm run build` first.");
  process.exit(1);
}

for (const f of files) {
  fs.copyFileSync(path.join(releaseDir, f), path.join(destDir, f));
  console.log(`Copied ${f} -> public/desktop-updates/`);
}

console.log("\nNow commit and push the repo (public/desktop-updates/) to publish this update to installed apps.");
