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
// Usage: node rebrand.js --name "AcmeFX" --subdomain "acmefx.vyxtrader.com" [--product-name "AcmeFX Trader"] [--icon path/to/icon.ico] [--root vyxtrader.com] [--gateway-ws-url wss://feed.acmefx.vyxtrader.com] [--banner-logo path/to/logo.png] [--banner-bg "#07090C"]
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
// Optional -- the API Gateway's live WebSocket base for this broker.
// Left unset if not given: the desktop app then falls back to the same
// default (and the same 2s-poll degradation) as the website's own
// unset-NEXT_PUBLIC_GATEWAY_WS_URL fallback -- see main.rs's own comment.
const gatewayWsUrl = arg("gateway-ws-url");
// Optional -- a raw logo image (any format sharp reads: PNG/JPEG/etc,
// NOT the .ico from --icon) to brand the NSIS installer WIZARD itself.
// Without this, Tauri's stock NSIS template shows zero branding at all
// (no header/sidebar image) -- the exact "looks like a generic, out of
// date installer" complaint this flag exists to fix.
const bannerLogo = arg("banner-logo");
const bannerBg = arg("banner-bg") || "#07090C";

if (!name || !subdomain) {
  console.error('Usage: node rebrand.js --name "AcmeFX" --subdomain "acmefx.vyxtrader.com" [--product-name "AcmeFX Trader"] [--icon path/to/icon.ico] [--root vyxtrader.com] [--gateway-ws-url wss://feed.acmefx.vyxtrader.com] [--banner-logo path/to/logo.png] [--banner-bg "#07090C"]');
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

// Every rebrand used to keep the committed default updater endpoint
// (the generic launcher-mode build's own feed) -- meaning every broker's
// white-label installer polled the exact same public/desktop-tauri-updates/
// latest.json the generic build publishes to. The next generic release
// would silently push its own unbranded build down onto every rebranded
// broker's installed app: wrong productName, wrong icon, and (the real
// damage) broker.config.json's mode flips from "broker" back to
// "launcher", so the app would boot straight into the root-domain server
// picker instead of that broker's own login screen. Scoping the endpoint
// by subdomain slug gives each broker's build its own feed, so a broker's
// update only ever comes from a publish.js run against that same broker's
// own rebrand.
const slug = subdomain.split(".")[0];
tauriConf.plugins ??= {};
tauriConf.plugins.updater ??= {};
tauriConf.plugins.updater.endpoints = [`https://${rootDomain}/desktop-tauri-updates/${slug}/latest.json`];

fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
console.log(`src-tauri/tauri.conf.json -> productName: "${productName}" (installer/Start Menu/Task Manager name)`);
console.log(`src-tauri/tauri.conf.json -> updater endpoint: https://${rootDomain}/desktop-tauri-updates/${slug}/latest.json`);

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
  // sharp (used above) can't encode BMP -- NSIS's one required format --
  // so a short PowerShell System.Drawing conversion does PNG -> 24bpp BMP
  // for each banner in one shot.
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
console.log("Then, if publishing this release: npm run publish -- --notes \"...\" (uses this broker's own slug-scoped feed automatically)");
console.log('Only after publishing (or if not publishing), revert: git checkout -- src-tauri/broker.config.json src-tauri/tauri.conf.json');
