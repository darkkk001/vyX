#!/usr/bin/env node
// Generates the two banner images NSIS shows in the installer wizard
// (bundle.windows.nsis.headerImage/sidebarImage in tauri.conf.json) --
// without these, Tauri's default NSIS template shows no branding at all,
// which is what made a per-broker installer look like a generic/stock
// wizard instead of that broker's own app. NSIS requires BMP specifically
// (not PNG/JPEG) -- sharp (used here for the resize/composite work) can't
// encode BMP itself, so this writes an intermediate PNG per banner and a
// short PowerShell System.Drawing conversion (invoked by rebrand.js right
// after this) turns each into the final .bmp.
//
// Usage: node generate-nsis-banners.cjs <logoPngPath> <outDir> [bgHex]
// Writes <outDir>/nsis-header.png (150x57) and <outDir>/nsis-sidebar.png
// (164x314), logo centered/contained with padding on a solid background.

const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const [, , logoPath, outDir, bgHex] = process.argv;
if (!logoPath || !outDir) {
  console.error("Usage: node generate-nsis-banners.cjs <logoPngPath> <outDir> [bgHex]");
  process.exit(1);
}
const bg = bgHex || "#07090C"; // matches WebTrader's own dark bg-0 default

async function makeBanner(width, height, logoMaxWidth, logoMaxHeight, outPath) {
  const logo = await sharp(logoPath)
    .resize({ width: logoMaxWidth, height: logoMaxHeight, fit: "inside" })
    .toBuffer();
  const logoMeta = await sharp(logo).metadata();
  const left = Math.round((width - (logoMeta.width ?? logoMaxWidth)) / 2);
  const top = Math.round((height - (logoMeta.height ?? logoMaxHeight)) / 2);
  await sharp({ create: { width, height, channels: 3, background: bg } })
    .composite([{ input: logo, left, top }])
    .png()
    .toFile(outPath);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  // Recommended NSIS dimensions (tauri.conf.json's own schema comment) --
  // logo padded well inside each so it never touches the edges.
  await makeBanner(150, 57, 120, 40, path.join(outDir, "nsis-header.png"));
  await makeBanner(164, 314, 120, 120, path.join(outDir, "nsis-sidebar.png"));
  console.log(`Wrote ${outDir}/nsis-header.png and nsis-sidebar.png`);
})();
