import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Dev-only proxy, same purpose as the other two shells' own: prove
// components/admin/* is portable in a plain browser tab before Tauri's
// reqwest bridge is involved. Host header targets the fixed admin
// subdomain -- middleware.ts's SUPER_ADMIN_SUBDOMAIN -- not a broker.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // See manager-tauri/manager-shell/vite.config.ts's identical entry --
    // lib/admin-realtime.tsx needs the same process.env shim.
    "process.env.NEXT_PUBLIC_GATEWAY_WS_URL": "undefined",
  },
  resolve: {
    alias: {
      // admin-tauri/admin-shell -> repo root is two levels up.
      "@": path.resolve(__dirname, "../.."),
    },
  },
  build: {
    // tauri.conf.json's build.frontendDist is "../dist" relative to
    // src-tauri/, i.e. admin-tauri/dist.
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5177,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
        headers: { Host: "admin.localhost:3000" },
      },
    },
  },
});
