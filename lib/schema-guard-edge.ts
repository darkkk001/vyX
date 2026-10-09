// Edge side of the schema guard: plain code (no Node or Prisma imports) so middleware.ts and the tests can use it.
// Middleware cannot see the Node instance's state, so it asks /api/internal/schema-status (a route that makes no DB
// query unless the instance is already behind) and caches the answer: 60 s while ok, 5 s while behind. Any failure to
// ask means "serve" (fail open).

export const SCHEMA_OK_TTL_MS = 60_000;
export const SCHEMA_BEHIND_TTL_MS = 5_000;
export const UPDATING_BODY = { error: "Service is being updated, try again shortly" };

export function createSchemaGate(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  let cached: { behind: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  return {
    /** true when the build's database is behind and requests must be refused. */
    async isBehind(ask: () => Promise<boolean>): Promise<boolean> {
      const t = now();
      if (cached && t - cached.at < (cached.behind ? SCHEMA_BEHIND_TTL_MS : SCHEMA_OK_TTL_MS)) return cached.behind;
      inFlight ??= ask()
        .then((behind) => {
          cached = { behind, at: now() };
          return behind;
        })
        .catch(() => false)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

export function schemaGuardExempt(pathname: string): boolean {
  return pathname === "/api/health" || pathname.startsWith("/api/internal/");
}
