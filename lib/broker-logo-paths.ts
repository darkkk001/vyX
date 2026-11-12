// Smaller copies of a broker's uploaded logo (owner 2026-11-12: QoreTrader's 1.8 MB PNG made the sign-in page slow).
// Each copy is the uploaded file itself, only resized and compressed (lib/broker-logo.ts, served by
// app/brand-logo/[v]/[file]/route.ts): WebP with a PNG fallback, 1x and 2x, at the heights the pages draw it.
// The version in the path is a hash of the logo's URL, so a new upload gets new paths and the files can be cached for
// a year. Safe on server and client (no Node APIs).

/** The heights (CSS px) the logo is drawn at: the sign-in's top row 48, the sidebar 40, the sign-in's large mark 140,
 *  the small brand rows 28. */
export const LOGO_HEIGHTS = [28, 40, 48, 140] as const;
export type LogoHeight = (typeof LOGO_HEIGHTS)[number];

/** Only uploaded raster logos (https) get copies; an SVG or a relative path is already small and is used as is. */
export function logoResizable(url: string | null | undefined): url is string {
  return !!url && /^https:\/\//i.test(url) && !/\.svg(\?|#|$)/i.test(url);
}

/** A short, stable hash of the logo URL (FNV-1a, two seeds). */
export function logoVersion(url: string): string {
  const h = (seed: number) => {
    let x = seed >>> 0;
    for (let i = 0; i < url.length; i++) { x ^= url.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, "0");
  };
  return h(0x811c9dc5) + h(0x2f6b8a1d).slice(0, 4);
}

export function logoVariantPath(url: string, height: LogoHeight, format: "webp" | "png", retina = false): string {
  return `/brand-logo/${logoVersion(url)}/${height}${retina ? "@2x" : ""}.${format}`;
}

/** What <picture> needs: the WebP set (1x, 2x) and the PNG fallback (1x src, 2x srcset). */
export function logoSources(url: string, height: LogoHeight) {
  return {
    webpSet: `${logoVariantPath(url, height, "webp")} 1x, ${logoVariantPath(url, height, "webp", true)} 2x`,
    png: logoVariantPath(url, height, "png"),
    pngSet: `${logoVariantPath(url, height, "png", true)} 2x`,
  };
}
