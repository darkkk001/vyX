import { defineConfig } from "vitest/config";
import path from "node:path";

const rootDir = import.meta.dirname;

// First TS test runner in this repo (Phase 0 money-risk patch,
// docs/ROADMAP.md). Only the "@/*" alias tsconfig.json already declares
// is needed -- these are plain unit tests against pure functions in
// lib/*, no Next.js runtime/JSX involved.
export default defineConfig({
  test: {
    environment: "node",
    // Hard production guard for every test file, host-based (scripts/lib/db-host-policy.mjs).
    // web4: each test file runs against its own clone of the local test DB (vitest.global.isolated-db.ts explains
    // why); the guard runs first so a production / non-allowlisted DATABASE_URL still refuses the whole run.
    globalSetup: ["./vitest.global.isolated-db.ts"],
    setupFiles: ["./vitest.setup.db-guard.ts", "./vitest.setup.isolated-db.ts"],
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "services/**", "engine/**", "desktop-tauri/**", "manager-tauri/**", "admin-tauri/**"],
    // Default 5s is tight for lib/mirror.test.ts's live-DB-gated tests
    // (each opens a real transaction against a remote Postgres instance) --
    // every other test in this suite is pure/synchronous and finishes in
    // milliseconds regardless, so raising this doesn't slow those down.
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "."),
      "server-only": path.resolve(rootDir, "vitest.server-only-shim.ts"),
    },
  },
});
