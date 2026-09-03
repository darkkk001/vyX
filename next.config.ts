import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
