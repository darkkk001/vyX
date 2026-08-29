#!/usr/bin/env node
// Direct port of desktop-tauri/publish.js for this app -- see that file's
// header comment for the full rationale (tauri-plugin-updater's "static"
// manifest shape, why this is hand-built rather than tauri-generated).
// Only the destination path/URL differ: this app's feed lives at
// public/manager-tauri-updates/, a separate feed from desktop-tauri's own,
// matching this app having its own signing keypair and pubkey in
// tauri.conf.json.
//
// Usage: npm run build && npm run publish, then commit + push the repo.
// Requires a real signed build -- see docs/deployment.md for how the
// signing private key (manager-tauri/src-tauri/.updater-keys/, gitignored,
// never committed) is provided to `tauri build` via the
// TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD env vars.

const fs = require("fs");
const path = require("path");

const bundleDir = path.join(__dirname, "src-tauri", "target", "release", "bundle", "nsis");

// Same broker-scoping as desktop-tauri/publish.js -- see that file's own
// comment for the full rationale (every broker's rebranded Manager
// installer used to share one generic feed, so the next generic release
// would silently debrand every broker's installed backoffice app).
const brokerConfigPath = path.join(__dirname, "src-tauri", "broker.config.json");
const brokerConfig = fs.existsSync(brokerConfigPath) ? JSON.parse(fs.readFileSync(brokerConfigPath, "utf-8")) : null;
const isBrokerBuild = brokerConfig?.mode === "broker";
const slug = isBrokerBuild ? brokerConfig.subdomain.split(".")[0] : null;
const rootDomain = isBrokerBuild ? brokerConfig.rootDomain : "vyxtrader.com";

const destDir = isBrokerBuild
  ? path.join(__dirname, "..", "public", "manager-tauri-updates", slug)
  : path.join(__dirname, "..", "public", "manager-tauri-updates");
const publicBaseUrl = isBrokerBuild
  ? `https://${rootDomain}/manager-tauri-updates/${slug}`
  : `https://${rootDomain}/manager-tauri-updates`;

console.log(
  isBrokerBuild
    ? `Publishing as a broker build: ${brokerConfig.brokerName} (slug "${slug}") -> ${destDir}`
    : `Publishing as the generic launcher-mode build -> ${destDir}`
);

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
// version's manifest. Hit exactly this once while building this feature (in
// desktop-tauri's own publish.js).
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

const destRelative = path.relative(path.join(__dirname, ".."), destDir).replace(/\\/g, "/");

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(path.join(bundleDir, installer), path.join(destDir, installer));
console.log(`Copied ${installer} -> ${destRelative}/`);

const notesArgIndex = process.argv.indexOf("--notes");
const notes = notesArgIndex !== -1 ? process.argv[notesArgIndex + 1] : `${brokerConfig?.brokerName ?? "VyXTrader Manager"} ${version}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      // encodeURIComponent -- see desktop-tauri/publish.js's own comment.
      url: `${publicBaseUrl}/${encodeURIComponent(installer)}`,
    },
  },
};

fs.writeFileSync(path.join(destDir, "latest.json"), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${destRelative}/latest.json`);

console.log(`\nNow commit and push the repo (${destRelative}/) to publish this update to installed apps.`);
