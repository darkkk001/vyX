import type { NextConfig } from "next";

// Native update feeds (docs/FEED-BINARIES-DESIGN.md, owner go 2026-10-24): the packages, Setup and portable of these
// broker slugs live in R2 behind feeds.vyxtrader.com, at the same paths. Installed apps keep their compiled-in
// www.vyxtrader.com/native-<app>-updates/<slug>/ URL; this redirect (302, before public/ files) sends the binaries
// to R2. The index files (releases.win.json, RELEASES, assets.win.json) stay here, under git review. A slug is added
// only after its binaries are byte-checked in R2 and an installed copy updated through the redirect (QoreTrader), or,
// where no installed copy is behind its feed, every file was downloaded through www and byte-checked (Futurix).
const R2_FEED_SLUGS = ["qoretrader", "futurixglobal"];

const nextConfig: NextConfig = {
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
