#!/usr/bin/env node
// Rebrands this Electron shell for one broker before packaging — points it
// straight at that broker's WebTrader (mode: "broker"), skipping the
// root-domain server picker entirely, same as how a broker-branded MT5
// build comes with its server pre-selected.
// Usage: node rebrand.js --name "AcmeFX" --subdomain "acmefx.vyxtrader.com" [--icon path/to/icon.ico] [--root vyxtrader.com]
// Then:  npm run build   (produces the branded .exe in desktop/release/)

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
  console.error('Usage: node rebrand.js --name "AcmeFX" --subdomain "acmefx.vyxtrader.com" [--icon path/to/icon.ico] [--root vyxtrader.com]');
  process.exit(1);
}

fs.writeFileSync(
  path.join(__dirname, "broker.config.json"),
  JSON.stringify({ brokerName: name, subdomain, rootDomain, mode: "broker" }, null, 2) + "\n"
);
console.log(`broker.config.json -> ${name} @ ${subdomain} (root: ${rootDomain})`);

if (iconPath) {
  if (!iconPath.toLowerCase().endsWith(".ico")) {
    console.error("Icon must be a .ico file (Windows exe icons require it) — convert the broker's logo first.");
    process.exit(1);
  }
  fs.copyFileSync(iconPath, path.join(__dirname, "build", "icon.ico"));
  console.log("build/icon.ico updated");
} else {
  console.log("No --icon given, keeping the current build/icon.ico");
}

console.log("\nNow run: npm run build");
