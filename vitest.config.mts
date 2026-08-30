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
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "services/**", "engine/**", "desktop-tauri/**", "manager-tauri/**", "admin-tauri/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "."),
    },
  },
});
