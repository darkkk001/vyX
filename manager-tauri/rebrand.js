#!/usr/bin/env node
// Rebrands this Tauri shell for one broker before packaging — points it
// straight at that broker's Manager/Broker-Admin backoffice (mode:
// "broker"), skipping the root-domain server picker entirely. Direct
// port of desktop-tauri/rebrand.js — same args, same broker.config.json
// shape, just without --gateway-ws-url (Manager has no live price/
// trading WebSocket relay to configure). Also patches tauri.conf.json's
// productName -- the installer file name, Start Menu shortcut, and
// Windows Add/Remove Programs entry all come from this field, not from
// broker.config.json, so a broker's staff should never see "VyXTrader"
// text anywhere in the install experience. IMPORTANT: revert both
// broker.config.json AND tauri.conf.json (`git checkout -- src-tauri/broker.config.json src-tauri/tauri.conf.json`)
// after building -- the built installer already has everything baked
// in, this is only to keep the next local dev/testing session pointed
// at the generic VyXTrader default instead of a stale broker rebrand.
// Usage: node rebrand.js --name "AcmeFX Manager" --subdomain "acmefx.vyxtrader.com" [--product-name "AcmeFX Manager"] [--icon path/to/icon.ico] [--root vyxtrader.com]
// Then:  npm run build   (produces the branded installer)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
// Optional -- see desktop-tauri/rebrand.js's own comment.
const bannerLogo = arg("banner-logo");
const bannerBg = arg("banner-bg") || "#07090C";

if (!name || !subdomain) {
  console.error('Usage: node rebrand.js --name "AcmeFX Manager" --subdomain "acmefx.vyxtrader.com" [--product-name "AcmeFX Manager"] [--icon path/to/icon.ico] [--root vyxtrader.com] [--banner-logo path/to/logo.png] [--banner-bg "#07090C"]');
  process.exit(1);
}

fs.writeFileSync(
  path.join(__dirname, "src-tauri", "broker.config.json"),
  JSON.stringify({ brokerName: name, subdomain, rootDomain, mode: "broker" }, null, 2) + "\n"
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

if (bannerLogo) {
  const iconsDir = path.join(__dirname, "src-tauri", "icons");
  execFileSync("node", [path.join(__dirname, "generate-nsis-banners.cjs"), bannerLogo, iconsDir, bannerBg], { stdio: "inherit" });
  const psScript = `
    Add-Type -AssemblyName System.Drawing
    foreach ($name in @("nsis-header", "nsis-sidebar")) {
      $src = [System.Drawing.Image]::FromFile("${iconsDir.replace(/\\/g, "\\\\")}\\$name.png")
      $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
      $bmp.Save("${iconsDir.replace(/\\/g, "\\\\")}\\$name.bmp", [System.Drawing.Imaging.ImageFormat]::Bmp)
      $g.Dispose(); $bmp.Dispose(); $src.Dispose()
    }
  `;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", psScript], { stdio: "inherit" });
  fs.unlinkSync(path.join(iconsDir, "nsis-header.png"));
  fs.unlinkSync(path.join(iconsDir, "nsis-sidebar.png"));

  const tauriConf2 = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
  tauriConf2.bundle ??= {};
  tauriConf2.bundle.windows ??= {};
  tauriConf2.bundle.windows.nsis = {
    ...tauriConf2.bundle.windows.nsis,
    headerImage: "icons/nsis-header.bmp",
    sidebarImage: "icons/nsis-sidebar.bmp",
  };
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf2, null, 2) + "\n");
  console.log("src-tauri/icons/nsis-{header,sidebar}.bmp generated; tauri.conf.json's bundle.windows.nsis wired to them");
} else {
  console.log("No --banner-logo given -- installer wizard keeps Tauri's stock (unbranded) look");
}

console.log("\nNow run: npm run build");
console.log('After building, revert: git checkout -- src-tauri/broker.config.json src-tauri/tauri.conf.json');
