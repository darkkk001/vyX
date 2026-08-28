import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Dev-only proxy, same purpose as desktop-tauri/webtrader-shell/'s own:
// prove components/admin/* is portable in a plain browser tab before
// Tauri's reqwest bridge is involved, against a local `npm run dev` Next
// server. The Host header override picks the seeded AcmeFX broker.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // manager-tauri/manager-shell -> repo root is two levels up.
      "@": path.resolve(__dirname, "../.."),
    },
  },
  build: {
    // tauri.conf.json's build.frontendDist is "../dist" relative to
    // src-tauri/, i.e. manager-tauri/dist.
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5176,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        headers: { Host: "acmefx.localhost:3000" },
      },
    },
  },
});
