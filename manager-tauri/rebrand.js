#!/usr/bin/env node
// Rebrands this Tauri shell for one broker before packaging — points it
// straight at that broker's Manager/Broker-Admin backoffice (mode:
// "broker"), skipping the root-domain server picker entirely. Direct
// port of desktop-tauri/rebrand.js — same args, same broker.config.json
// shape, just without --gateway-ws-url (Manager has no live price/
// trading WebSocket relay to configure, unlike the Trader terminal).
// Usage: node rebrand.js --name "AcmeFX Manager" --subdomain "acmefx.vyxtrader.com" [--icon path/to/icon.ico] [--root vyxtrader.com]
// Then:  npm run build   (produces the branded installer)

const fs = require("fs");
const path = require("path");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const name = arg("name");
const subdomain = arg("subdomain");
const iconPath = arg("icon");
// Assumes a standard two-label root (vyxtrader.com) unless overridden —
// fine for this platform's actual domain, not a general-purpose PSL parser.
const rootDomain = arg("root") || subdomain?.split(".").slice(-2).join(".");

if (!name || !subdomain) {
  console.error('Usage: node rebrand.js --name "AcmeFX Manager" --subdomain "acmefx.vyxtrader.com" [--icon path/to/icon.ico] [--root vyxtrader.com]');
  process.exit(1);
}

fs.writeFileSync(
  path.join(__dirname, "src-tauri", "broker.config.json"),
  JSON.stringify({ brokerName: name, subdomain, rootDomain, mode: "broker" }, null, 2) + "\n"
);
console.log(`src-tauri/broker.config.json -> ${name} @ ${subdomain} (root: ${rootDomain})`);

if (iconPath) {
  if (!iconPath.toLowerCase().endsWith(".ico")) {
    console.error("Icon must be a .ico file (Windows exe icons require it) — convert the broker's logo first.");
    process.exit(1);
  }
  fs.copyFileSync(iconPath, path.join(__dirname, "src-tauri", "icons", "icon.ico"));
  console.log("src-tauri/icons/icon.ico updated");
} else {
  console.log("No --icon given, keeping the current src-tauri/icons/icon.ico");
}

console.log("\nNow run: npm run build");
