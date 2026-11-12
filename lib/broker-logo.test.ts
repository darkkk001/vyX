import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGO_HEIGHTS, logoResizable, logoSources, logoVariantPath, logoVersion } from "@/lib/broker-logo-paths";

vi.mock("server-only", () => ({}));
const read = (p: string) => readFileSync(p, "utf8");

// Owner 2026-11-12: QoreTrader's uploaded logo (1.8 MB, 1440 px PNG) made the sign-in slow. The pages now draw resized
// copies of the same file (WebP + PNG, 1x + 2x), cached for a year under a path versioned by the logo URL.
const UP = "https://x.public.blob.vercel-storage.com/broker-logos/1794435569096-2mb-abc.png";

describe("paths", () => {
  it("only uploaded raster logos get copies", () => {
    expect(logoResizable(UP)).toBe(true);
    expect(logoResizable("/qoretrader-demo/qoretrader-lockup-light.svg")).toBe(false);
    expect(logoResizable("https://cdn.example.com/logo.SVG")).toBe(false);
    expect(logoResizable(null)).toBe(false);
    expect(logoResizable("")).toBe(false);
  });
  it("versioned by the logo URL: stable, and a new upload gets new paths", () => {
    expect(logoVersion(UP)).toMatch(/^[0-9a-f]{12}$/);
    expect(logoVersion(UP)).toBe(logoVersion(UP));
    expect(logoVersion(UP)).not.toBe(logoVersion(UP.replace("abc", "abd")));
    const v = logoVersion(UP);
    expect(logoVariantPath(UP, 140, "webp", true)).toBe(`/brand-logo/${v}/140@2x.webp`);
    expect(logoSources(UP, 48)).toEqual({
      webpSet: `/brand-logo/${v}/48.webp 1x, /brand-logo/${v}/48@2x.webp 2x`,
      png: `/brand-logo/${v}/48.png`,
      pngSet: `/brand-logo/${v}/48@2x.png 2x`,
    });
    expect([...LOGO_HEIGHTS]).toEqual([28, 40, 48, 140]);
  });
});

describe("resizing keeps the artwork", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("scales the uploaded file down, same shape, transparency kept; never enlarged", async () => {
    // a 1440 px square with a transparent corner and a coloured centre
    const big = await sharp({ create: { width: 1440, height: 1440, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 720, height: 720, channels: 4, background: { r: 245, g: 166, b: 35, alpha: 1 } } }).png().toBuffer(), left: 360, top: 360 }])
      .png().toBuffer();
    const wide = await sharp({ create: { width: 160, height: 40, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array(url.includes("wide") ? wide : big), { status: 200 })));
    const { logoVariant, logoSquarePng } = await import("@/lib/broker-logo");
    const w = await logoVariant(`${UP}?a`, 140, true, "webp");
    const wm = await sharp(w).metadata();
    expect([wm.format, wm.width, wm.height, wm.hasAlpha]).toEqual(["webp", 280, 280, true]);
    const png = await logoVariant(`${UP}?a`, 48, false, "png");
    const pm = await sharp(png).metadata();
    expect([pm.format, pm.width, pm.height]).toEqual(["png", 48, 48]);
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // corner still transparent
    const c = (24 * 48 + 24) * 4;
    expect([data[c], data[c + 1], data[c + 2], data[c + 3]]).toEqual([245, 166, 35, 255]); // centre colour unchanged
    expect(w.length).toBeLessThan(big.length);
    // a small wide logo is never blown up, and keeps its shape
    const sm = await sharp(await logoVariant(`${UP}?wide`, 140, true, "png")).metadata();
    expect([sm.width, sm.height]).toEqual([160, 40]);
    const ico = await sharp(await logoSquarePng(`${UP}?a`, 32)).metadata();
    expect([ico.width, ico.height]).toEqual([32, 32]);
  });
});

describe("where the copies are used", () => {
  it("sign-in (48 top row, 140 mark, both preloaded), sidebar 40, favicon + home-screen icon", () => {
    const panel = read("components/room/AuthBrandPanel.tsx");
    expect(panel).toContain('<BrokerLogoImg className="r-auth-mark" src={broker.logoUrl} height={140} />');
    expect(panel).toContain("for (const h of [140, 48] as const)");
    expect(panel).toContain('preload(s.webpSet.split(" ")[0], { as: "image", type: "image/webp", imageSrcSet: s.webpSet, fetchPriority: "high" });');
    expect(read("components/room/RoomLogo.tsx")).toContain('<BrokerLogoImg src={logoUrl} height={size === "sm" ? 28 : 48} />');
    expect(read("components/room/RoomBrand.tsx")).toContain("<BrokerLogoImg src={logoUrl} height={showName ? 40 : 28}");
    const img = read("components/room/BrokerLogoImg.tsx");
    expect(img).toContain('<picture style={{ display: "contents" }}>');
    expect(img).toContain('<source type="image/webp" srcSet={s.webpSet} />');
    expect(read("lib/broker-brand-icon.tsx")).toContain("return await logoSquarePng(b.logoUrl, size);");
    expect(read("app/(broker)/layout.tsx")).toContain("icons: { icon: `/favicon.ico?v=${brandIconVersion(broker?.logoUrl)}`");
  });
  it("a year of cache for the copies and the versioned icons", () => {
    expect(read("app/brand-logo/[v]/[file]/route.ts")).toContain('"Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable"');
    expect(read("lib/broker-brand.ts")).toContain('"public, max-age=31536000, s-maxage=31536000, immutable" : "public, max-age=3600"');
  });
});
