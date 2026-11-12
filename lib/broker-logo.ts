import "server-only";
import type { LogoHeight } from "@/lib/broker-logo-paths";

// The resizing half of lib/broker-logo-paths.ts: the broker's uploaded file, scaled down and compressed. The artwork
// is not changed or redrawn: no crop, no padding, no recolouring (sharp resize "inside", never enlarged).

const sources = new Map<string, Promise<Buffer>>();
// loaded on first use: if it cannot load, the callers fall back to the original logo instead of failing
const loadSharp = async () => (await import("sharp")).default;

/** The uploaded file (kept for a few logos per server instance, so the 8 copies of one logo fetch it once). */
function source(url: string): Promise<Buffer> {
  let p = sources.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000), cache: "no-store" });
      if (!res.ok) throw new Error(`logo ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) throw new Error("logo too large");
      return buf;
    })();
    p.catch(() => sources.delete(url));
    sources.set(url, p);
    while (sources.size > 6) sources.delete(sources.keys().next().value!);
  }
  return p;
}

/** One copy: `height` CSS px tall (x2 for retina), as WebP or PNG. Wide logos keep their shape (width up to 7x). */
export async function logoVariant(url: string, height: LogoHeight, retina: boolean, format: "webp" | "png"): Promise<Buffer> {
  const px = height * (retina ? 2 : 1);
  const sharp = await loadSharp();
  const img = sharp(await source(url), { limitInputPixels: 64_000_000 })
    .resize({ height: px, width: px * 7, fit: "inside", withoutEnlargement: true });
  // both lossless: every visible pixel equals the scaled original (lossy WebP changed the fine lines)
  return format === "webp"
    ? img.webp({ lossless: true, effort: 6 }).toBuffer()
    : img.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

/** A square PNG of the logo for the favicon and home-screen icons: scaled to fit, transparent around it. */
export async function logoSquarePng(url: string, size: number): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(await source(url), { limitInputPixels: 64_000_000 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}
