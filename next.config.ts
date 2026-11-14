import type { NextConfig } from "next";

// Native update feeds (docs/FEED-BINARIES-DESIGN.md, owner go 2026-10-24): the packages, Setup and portable of these
// broker slugs live in R2 behind feeds.vyxtrader.com, at the same paths. Installed apps keep their compiled-in
// www.vyxtrader.com/native-<app>-updates/<slug>/ URL; this redirect (302, before public/ files) sends the binaries
// to R2. The index files (releases.win.json, RELEASES, assets.win.json) stay here, under git review. A slug is added
// only after its binaries are byte-checked in R2 and an installed copy updated through the redirect (QoreTrader), or,
// where no installed copy is behind its feed, every file was downloaded through www and byte-checked (Futurix).
const R2_FEED_SLUGS = ["qoretrader", "futurixglobal", "tradenextfx"];

// Security headers on every response (owner 2026-11-13, CRM security batch). The CSP keeps the outside services the
// pages use working: Cloudflare Turnstile (script + frame + verify call), the price/event gateway's websocket
// (NEXT_PUBLIC_GATEWAY_WS_URL, wss://*.vyxtrader.com), Snap's Bitmoji images and broker logos (img-src https:).
// Google and Snap sign-in are full-page navigations (no script or frame from them). 'unsafe-inline' scripts stay
// because Next's App Router writes its page data as inline scripts; no external script host is allowed except
// Cloudflare's. 'unsafe-eval' only in `next dev` (React's dev tooling needs it; the production bundle has no eval).
const gatewayOrigin = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "").origin; } catch { return ""; }
})();
const dev = process.env.NODE_ENV !== "production";
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' https://challenges.cloudflare.com wss://*.vyxtrader.com https://*.vyxtrader.com https://*.bitmoji.com https://*.snapchat.com https://*.snapkit.com https://bitmoji-sdk-images.s3.amazonaws.com${gatewayOrigin && gatewayOrigin !== "null" ? ` ${gatewayOrigin}` : ""}${dev ? " ws: http://localhost:* ws://localhost:*" : ""}`,
  "frame-src 'self' https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  "frame-ancestors 'self'",
].join("; ");
export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), interest-cohort=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  async redirects() {
    return R2_FEED_SLUGS.map((slug) => ({
      source: `/native-:app(terminal|backoffice)-updates/${slug}/:file(.+\\.(?:nupkg|exe|zip))`,
      destination: `https://feeds.vyxtrader.com/native-:app-updates/${slug}/:file`,
      statusCode: 302 as const,
    }));
  },
  // Security/branding audit -- the production build (`next build
  // --turbopack`, see package.json's own build script) was emitting a
  // full .js.map next to every client chunk, each one embedding the
  // COMPLETE original, unminified source (every file, every comment)
  // plus its absolute local file:// path -- confirmed live in a fresh
  // build: components/webtrader/WebTrader.tsx's entire source, verbatim,
  // sat in .next/static/chunks/*WebTrader_tsx*.js.map. Since everything
  // under .next/static is served publicly at /_next/static/... by
  // design (that's how the JS itself reaches the browser), any visitor
  // could fetch the .map file next to any chunk and read this app's
  // full source. Disabling browser source maps entirely for production.
  productionBrowserSourceMaps: false,
  // Same audit -- strips the default `X-Powered-By: Next.js` response
  // header (a free fingerprint of the stack/version for no benefit to a
  // real user).
  poweredByHeader: false,
};

export default nextConfig;
