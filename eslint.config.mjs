import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // A bare `npm run lint` (package.json's "lint": "eslint", no path
      // args -- exactly what CI's Lint step and a pre-commit hook would
      // both run) walked the whole repo, including every *-tauri app's
      // own Rust build output (src-tauri/target/**), which ships raw,
      // unminified webview/codegen JS with syntax ESLint can't even
      // parse -- 147 real "errors" that were never source code at all.
      // "out/**"/"build/**" above only match at the repo root (no
      // leading **/), so they never actually excluded these -- found
      // when Phase 1 §4's new CI workflow ran this command for the
      // first time ever, instead of every prior lint pass in this repo
      // always scoping to specific files/dirs.
      "**/target/**",
      // Same root cause, same fix -- each *-tauri app's own Vite-built
      // shell bundle (manager-shell/dist, webtrader-shell/dist,
      // admin-shell/dist) is minified build output, not source, and
      // "build/**"/"out/**" above never matched it for the same
      // no-leading-**/ reason.
      "**/dist/**",
      // Each *-tauri app's own release/rebrand tooling -- plain
      // `node script.js` CLI scripts run outside Next's own module
      // system entirely (CI release workflows, a local rebrand pass),
      // intentionally CommonJS since that's what a bare `node` process
      // without a package.json "type":"module" understands natively.
      // This Next.js-oriented config's @typescript-eslint/no-require-imports
      // rule was never meant to reach these; rewriting working release
      // scripts to ESM just to satisfy a linter they were never in scope
      // for isn't the fix.
      "**/publish.js",
      "**/rebrand.js",
      "**/generate-nsis-banners.cjs",
    ],
  },
];

export default eslintConfig;
