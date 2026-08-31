import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

const rootDir = import.meta.dirname;

// First TS test runner in this repo (Phase 0 money-risk patch,
// docs/ROADMAP.md). Only the "@/*" alias tsconfig.json already declares
// is needed -- these are plain unit tests against pure functions in
// lib/*, no Next.js runtime/JSX involved.
//
// Phase 1 trust pack §2 added live-Redis-gated tests (lib/auth.test.ts)
// alongside the existing live-Neon-gated one (lib/margin.test.ts) --
// both need real env vars from the root .env, which Vitest does NOT read
// automatically (unlike `next dev`/`next build`, which load it for free).
// loadEnv(mode, envDir, "") with an empty prefix loads every variable in
// .env, not just VITE_-prefixed ones, same file the app itself reads.
export default defineConfig({
  test: {
    env: loadEnv("test", rootDir, ""),
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "services/**", "engine/**", "desktop-tauri/**", "manager-tauri/**", "admin-tauri/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "."),
      "server-only": path.resolve(rootDir, "vitest.server-only-shim.ts"),
    },
  },
});
