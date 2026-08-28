import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Dev-only proxy: this Phase 2 spike still talks over plain browser
// fetch() to a locally running `npm run dev` Next server, to prove
// components/webtrader/WebTrader.tsx is portable *before* Tauri's own
// reqwest cookie-jar bridge (Phase 3+) is involved at all. The Host
// header override picks a fixed seeded broker (AcmeFX) for local
// testing -- it stands in for the real per-install broker.config.json /
// window.vyxDesktop wiring that replaces this proxy once the app is
// wired into Tauri.
export default defineConfig({
  plugins: [react()],
  define: {
    // WebTrader.tsx reads process.env.NEXT_PUBLIC_GATEWAY_WS_URL directly
    // (a Next.js build-time inlining convention) -- Vite has no `process`
    // global at all, so left alone this throws at runtime. Substituting
    // the bare `undefined` identifier here (not a JSON string) makes the
    // component's own `?? "ws://127.0.0.1:8080"` fallback take over,
    // reproducing today's unset-env-var dev behavior exactly.
    "process.env.NEXT_PUBLIC_GATEWAY_WS_URL": "undefined",
  },
  resolve: {
    alias: {
      // desktop-tauri/webtrader-shell -> repo root is two levels up.
      "@": path.resolve(__dirname, "../.."),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        headers: { Host: "acmefx.localhost:3000" },
      },
    },
  },
});
