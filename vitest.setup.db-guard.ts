// Runs before every test file (vitest.config.mts setupFiles). Refuses the whole run when the
// database the tests would reach is production or not on the dev allowlist -- see
// scripts/lib/db-host-policy.mjs for the rule and the incidents behind it.
//
// Prisma reads DATABASE_URL from the process env OR from ./.env by itself, so a test that never
// looks at the env still writes wherever .env points. Mirror that: check the process env first,
// then fall back to parsing .env exactly like Prisma does.
import fs from "node:fs";
import path from "node:path";
import { testDbVerdict } from "./scripts/lib/db-host-policy.mjs";

function readDotEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, ".env"), "utf8");
    const m = text.match(new RegExp(`^\s*${name}\s*=\s*"?([^"\r\n]+)"?`, "m"));
    return m?.[1];
  } catch {
    return undefined;
  }
}

for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  const v = testDbVerdict(readDotEnv(name));
  if (!v.ok) {
    throw new Error(
      `[db-guard] refusing to run tests: ${name} host '${v.host}': ${v.reason}. ` +
        `Point .env at a local Postgres or a Neon DEV branch and list that host in TEST_DB_ALLOWED_HOSTS.`
    );
  }
}
if (process.env.ALLOW_TEST_DB_WRITES === "true" && !testDbVerdict(readDotEnv("DATABASE_URL")).ok) {
  throw new Error("[db-guard] ALLOW_TEST_DB_WRITES=true is set next to a blocked DATABASE_URL, remove it.");
}
