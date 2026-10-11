import { EXPECTED_MIGRATIONS } from "@/lib/expected-migrations.generated";

// Startup schema guard. On 2026-10-07 the web went live before 4 migrations reached the database and every staff
// request failed one by one (a missing column). This module compares the migration list bundled into this build with
// what the database says it has applied, once per instance start (instrumentation.ts).
//
// Outcomes:
//   ok       every expected migration is applied (extra ones, i.e. the DB is ahead, are fine: info line only)
//   behind   expected migrations are missing: ONE log line, and middleware answers 503 until they are applied
//   unknown  the database could not be reached or the query failed: WARNING, never refuses (a transient DB problem
//            must not take the site down), and re-checked like behind so the guard does not stay off for the
//            instance's lifetime (2026-10-11: Neon wake-ups past the old 5 s limit left instances unknown for good)
//
// Cost: one query per instance start. While behind or unknown, the check is repeated at most every RECHECK_MS and
// only when a request asks (so an instance recovers after `prisma migrate deploy` without a redeploy); nothing runs
// when ok.

export type SchemaStatus = "unchecked" | "ok" | "behind" | "unknown";
export type SchemaState = { status: SchemaStatus; missing: string[]; checkedAt: number };

export const RECHECK_MS = 10_000;
// Long enough for a suspended Neon compute to wake (seen above 5 s in production).
export const QUERY_TIMEOUT_MS = 15_000;
const STATE_KEY = "__vyxSchemaGuardState";

type G = typeof globalThis & { [STATE_KEY]?: SchemaState };
// On globalThis so the instrumentation bundle and the route bundles (separate module graphs) share one state.
const g = globalThis as G;

export function getSchemaState(): SchemaState {
  return (g[STATE_KEY] ??= { status: "unchecked", missing: [], checkedAt: 0 });
}

export function resetSchemaState() {
  delete g[STATE_KEY];
}

export function computeMissing(expected: readonly string[], applied: Iterable<string>): string[] {
  const have = new Set(applied);
  return expected.filter((n) => !have.has(n));
}

export function behindMessage(missing: string[]): string {
  return (
    `SCHEMA GUARD: database is behind this build: missing ${missing.length} migration(s): ${missing.join(", ")}. ` +
    `Refusing to serve. Run prisma migrate deploy.`
  );
}

export type AppliedQuery = () => Promise<string[]>;

async function defaultQuery(): Promise<string[]> {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
    SELECT DISTINCT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  return rows.map((r) => r.migration_name);
}

export async function runSchemaCheck(
  opts: { query?: AppliedQuery; expected?: readonly string[]; quiet?: boolean } = {}
): Promise<SchemaState> {
  const query = opts.query ?? defaultQuery;
  const expected = opts.expected ?? EXPECTED_MIGRATIONS;
  const previous = getSchemaState().status;
  let state: SchemaState;
  try {
    const applied = await Promise.race([
      query(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("schema check timed out")), QUERY_TIMEOUT_MS).unref?.()),
    ]);
    const missing = computeMissing(expected, applied);
    if (missing.length > 0) {
      state = { status: "behind", missing, checkedAt: Date.now() };
      // Rechecks (quiet) stay silent while still behind, so the loop does not log one line per request.
      if (!opts.quiet || previous !== "behind") console.error(behindMessage(missing));
    } else {
      state = { status: "ok", missing: [], checkedAt: Date.now() };
      // Distinct names: the live ledger holds some migrations twice (two rows, one name), which are not "ahead".
      const known = new Set(expected);
      const extra = new Set(applied.filter((n) => !known.has(n))).size;
      if (extra > 0) console.info(`SCHEMA GUARD: database has ${extra} more migration(s) than this build; continuing.`);
      if (previous === "behind") console.info("SCHEMA GUARD: database is now up to date; serving again.");
      if (previous === "unknown") console.info("SCHEMA GUARD: migrations verified after an earlier failed check.");
    }
  } catch (err) {
    state = { status: "unknown", missing: [], checkedAt: Date.now() };
    // Rechecks (quiet) stay silent while still unknown, same as behind.
    if (!opts.quiet || previous !== "unknown") {
      console.warn(
        `SCHEMA GUARD: could not verify migrations (${err instanceof Error ? err.message : String(err)}); serving anyway.`
      );
    }
  }
  g[STATE_KEY] = state;
  return state;
}

/**
 * While behind or unknown, re-check at most every RECHECK_MS: the instance recovers after migrate deploy, and a check
 * that failed (timeout, DB asleep) gets another go instead of leaving the guard off. No-op when ok or unchecked.
 */
export async function refreshIfStale(opts: { query?: AppliedQuery; expected?: readonly string[]; now?: number } = {}) {
  const s = getSchemaState();
  if ((s.status === "behind" || s.status === "unknown") && (opts.now ?? Date.now()) - s.checkedAt >= RECHECK_MS) {
    return runSchemaCheck({ query: opts.query, expected: opts.expected, quiet: true });
  }
  return s;
}

/** Generic, broker-safe wording for the health route. */
export function schemaLabel(s: SchemaState): string {
  if (s.status === "behind") return `behind (${s.missing.length})`;
  return s.status;
}
