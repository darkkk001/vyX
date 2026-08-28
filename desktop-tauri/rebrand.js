#!/usr/bin/env node
// Rebrands this Tauri shell for one broker before packaging — points it
// straight at that broker's WebTrader (mode: "broker"), skipping the
// root-domain server picker entirely. Direct port of desktop/rebrand.js
// (the Electron app's own rebrand tool) — same args, same broker.config.json
// shape, same behavior; only the icon's destination path differs (Tauri's
// icons/ dir instead of Electron's build/). Also patches tauri.conf.json's
// productName -- the installer file name, Start Menu shortcut, and
// Windows Add/Remove Programs entry all come from this field, not from
// broker.config.json, so a broker's traders should never see "VyXTrader"
// text anywhere in the install experience. IMPORTANT: revert both
// broker.config.json AND tauri.conf.json (`git checkout -- src-tauri/broker.config.json src-tauri/tauri.conf.json`)
// after building -- the built installer already has everything baked
// in, this is only to keep the next local dev/testing session pointed
// at the generic VyXTrader default instead of a stale broker rebrand.
// Usage: node rebrand.js --name "AcmeFX" --subdomain "acmefx.vyxtrader.com" [--product-name "AcmeFX Trader"] [--icon path/to/icon.ico] [--root vyxtrader.com] [--gateway-ws-url wss://feed.acmefx.vyxtrader.com]
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
// Defaults to --name itself -- pass --product-name separately only when
// the installer/Start-Menu name should differ from the in-app broker
// name shown on the login screen and window title.
const productName = arg("product-name") || name;
// Assumes a standard two-label root (vyxtrader.com) unless overridden —
// fine for this platform's actual domain, not a general-purpose PSL parser.
const rootDomain = arg("root") || subdomain?.split(".").slice(-2).join(".");
// Optional -- the API Gateway's live WebSocket base for this broker.
// Left unset if not given: the desktop app then falls back to the same
// default (and the same 2s-poll degradation) as the website's own
// unset-NEXT_PUBLIC_GATEWAY_WS_URL fallback -- see main.rs's own comment.
const gatewayWsUrl = arg("gateway-ws-url");

if (!name || !subdomain) {
  console.error('Usage: node rebrand.js --name "AcmeFX" --subdomain "acmefx.vyxtrader.com" [--product-name "AcmeFX Trader"] [--icon path/to/icon.ico] [--root vyxtrader.com] [--gateway-ws-url wss://feed.acmefx.vyxtrader.com]');
  process.exit(1);
}

fs.writeFileSync(
  path.join(__dirname, "src-tauri", "broker.config.json"),
  JSON.stringify(
    { brokerName: name, subdomain, rootDomain, mode: "broker", ...(gatewayWsUrl ? { gatewayWsUrl } : {}) },
    null,
    2
  ) + "\n"
);
console.log(`src-tauri/broker.config.json -> ${name} @ ${subdomain} (root: ${rootDomain})`);

const tauriConfPath = path.join(__dirname, "src-tauri", "tauri.conf.json");
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.productName = productName;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
console.log(`src-tauri/tauri.conf.json -> productName: "${productName}" (installer/Start Menu/Task Manager name)`);

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
console.log('After building, revert: git checkout -- src-tauri/broker.config.json src-tauri/tauri.conf.json');
