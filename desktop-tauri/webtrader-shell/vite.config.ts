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
    // global at all, so left alone this throws at runtime.
    //
    // 2026-09-08: same fix as manager-tauri/manager-shell/vite.config.ts
    // (see its own comment for the confirmed "Connecting…" bug this was
    // causing there) -- reads the real value from this process's own env
    // if set at build time, same convention as TAURI_SIGNING_PRIVATE_KEY.
    // WebTrader.tsx's own window.vyxDesktop?.onPriceTick native-relay
    // check means this specific shell likely wasn't hitting the same
    // visible symptom (it has an escape hatch manager/admin-shell don't),
    // but the browser-WS path is still real and should point at the real
    // gateway once that relay isn't in play.
    "process.env.NEXT_PUBLIC_GATEWAY_WS_URL": process.env.NEXT_PUBLIC_GATEWAY_WS_URL
      ? JSON.stringify(process.env.NEXT_PUBLIC_GATEWAY_WS_URL)
      : "undefined",
  },
  resolve: {
    alias: {
      // desktop-tauri/webtrader-shell -> repo root is two levels up.
      "@": path.resolve(__dirname, "../.."),
    },
  },
  build: {
    // tauri.conf.json's build.frontendDist is "../dist" relative to
    // src-tauri/, i.e. desktop-tauri/dist -- building straight there
    // means `tauri build`/`tauri dev` need no separate copy step.
    outDir: "../dist",
    emptyOutDir: true,
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
