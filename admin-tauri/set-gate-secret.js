#!/usr/bin/env node
// Bakes SUPER_ADMIN_DESKTOP_GATE_SECRET's real value into this build so
// this window's launch URL (src-tauri/src/main.rs) can get past
// middleware.ts's /login (and the rest of SUPER_ADMIN_PAGE_PATHS)
// otherwise-unconditional 404 -- see that file's and lib/desktop-gate.ts's
// comments for the full mechanism. Not broker-scoped (there's exactly one
// Super Admin surface for the whole platform), so unlike manager-tauri's
// rebrand.js this only ever patches the one secret field, nothing else.
// IMPORTANT: revert app.config.json (`git checkout -- src-tauri/app.config.json`)
// after building -- the built installer already has the secret baked in,
// this is only to keep the next local dev/testing session from shipping
// the real secret in a plain committed file.
// Usage: node set-gate-secret.js --secret "the-same-value-as-Vercel's-SUPER_ADMIN_DESKTOP_GATE_SECRET-env-var"
// Then:  npm run build

const fs = require("fs");
const path = require("path");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const secret = arg("secret");

if (!secret) {
  console.error('Usage: node set-gate-secret.js --secret "the-same-value-as-Vercel\'s-SUPER_ADMIN_DESKTOP_GATE_SECRET-env-var"');
  process.exit(1);
}

const configPath = path.join(__dirname, "src-tauri", "app.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.desktopGateSecret = secret;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log("src-tauri/app.config.json -> desktopGateSecret set");

console.log("\nNow run: npm run build");
console.log("Then, if publishing this release: npm run publish -- --notes \"...\"");
console.log("Only after publishing (or if not publishing), revert: git checkout -- src-tauri/app.config.json");
