#!/usr/bin/env node
// Copies the signed release installer + a hand-built tauri-plugin-updater
// manifest into the Next.js app's public/ folder, so Vercel serves them as
// plain static files -- same "generic static feed, no separate hosting"
// pattern as desktop/publish.js, at a separate public/desktop-tauri-updates/
// path (see docs/deployment.md's desktop-updates section for why this is a
// distinct feed from Electron's).
//
// Unlike electron-builder, `tauri build` does not auto-generate an update
// manifest -- it only emits the installer + a `.sig` signature file when
// tauri.conf.json's bundle.createUpdaterArtifacts is on. This script builds
// that manifest by hand, in the exact shape tauri-plugin-updater's "static"
// format expects: {version, notes, pub_date, platforms: {"windows-x86_64":
// {signature, url}}} (confirmed against the plugin's actual RemoteRelease/
// ReleaseManifestPlatform structs in its source, not guessed).
//
// Usage: npm run build && npm run publish, then commit + push the repo.
// Requires a real signed build -- see docs/deployment.md for how the
// signing private key (desktop-tauri/src-tauri/.updater-keys/, gitignored,
// never committed) is provided to `tauri build` via the
// TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD env vars.

const fs = require("fs");
const path = require("path");

const bundleDir = path.join(__dirname, "src-tauri", "target", "release", "bundle", "nsis");
const destDir = path.join(__dirname, "..", "public", "desktop-tauri-updates");
const publicBaseUrl = "https://vyxtrader.com/desktop-tauri-updates";

if (!fs.existsSync(bundleDir)) {
  console.error(`No ${bundleDir} -- run \`npm run build\` first (a signed release build).`);
  process.exit(1);
}

const tauriConf = JSON.parse(fs.readFileSync(path.join(__dirname, "src-tauri", "tauri.conf.json"), "utf-8"));
const version = tauriConf.version;

// Matched against tauri.conf.json's current version, not just "*-setup.exe" --
// a stale installer from a previous version left in the bundle dir (forgot to
// clean before rebuilding after a version bump) would otherwise silently be
// picked up by a bare .find(), publishing the wrong build under the new
// version's manifest. Hit exactly this once while building this feature.
const candidates = fs.readdirSync(bundleDir).filter((f) => f.endsWith("-setup.exe"));
if (candidates.length === 0) {
  console.error(`No *-setup.exe found in ${bundleDir} -- run \`npm run build\` first.`);
  process.exit(1);
}
const matches = candidates.filter((f) => f.includes(version));
if (matches.length === 0) {
  console.error(
    `Found *-setup.exe file(s) in ${bundleDir} but none match tauri.conf.json's version ` +
      `"${version}": ${candidates.join(", ")}. Delete stale bundle output and rebuild.`
  );
  process.exit(1);
}
if (matches.length > 1) {
  console.error(
    `More than one *-setup.exe matches version "${version}" in ${bundleDir}: ` +
      `${matches.join(", ")}. Delete stale bundle output and rebuild.`
  );
  process.exit(1);
}
const installer = matches[0];

const sigFile = `${installer}.sig`;
if (!fs.existsSync(path.join(bundleDir, sigFile))) {
  console.error(
    `${sigFile} not found next to the installer -- bundle.createUpdaterArtifacts must be ` +
      "true in tauri.conf.json and TAURI_SIGNING_PRIVATE_KEY must be set when building, " +
      "or the build won't produce a signature."
  );
  process.exit(1);
}

const signature = fs.readFileSync(path.join(bundleDir, sigFile), "utf-8").trim();

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(path.join(bundleDir, installer), path.join(destDir, installer));
console.log(`Copied ${installer} -> public/desktop-tauri-updates/`);

const notesArgIndex = process.argv.indexOf("--notes");
const notes = notesArgIndex !== -1 ? process.argv[notesArgIndex + 1] : `VyXTrader ${version}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${publicBaseUrl}/${installer}`,
    },
  },
};

fs.writeFileSync(path.join(destDir, "latest.json"), JSON.stringify(manifest, null, 2));
console.log("Wrote public/desktop-tauri-updates/latest.json");

console.log("\nNow commit and push the repo (public/desktop-tauri-updates/) to publish this update to installed apps.");
