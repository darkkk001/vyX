// Preset avatars (owner 2026-11-14). Converts every image in the source folder (default C:\vyx\assets\avatars, 1024 px
// squares) to public/avatars/<name>-1024.webp, -256.webp and -96.webp (resize only), then rewrites the list
// (scripts/gen-avatar-presets.mjs). A new file dropped in the folder joins both lists after `npm run avatars`.
//   node scripts/avatars-build.mjs [sourceDir]
import { readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { genAvatarPresets } from "./gen-avatar-presets.mjs";

const src = process.argv[2] ?? "C:\\vyx\\assets\\avatars";
const out = path.join(process.cwd(), "public", "avatars");
mkdirSync(out, { recursive: true });
const files = readdirSync(src).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
for (const f of files) {
  const name = path.parse(f).name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  for (const size of [1024, 256, 96]) {
    await sharp(path.join(src, f)).resize(size, size, { fit: "cover" }).webp({ quality: 90 }).toFile(path.join(out, `${name}-${size}.webp`));
  }
  console.log(`avatar ${name}`);
}
await genAvatarPresets();
