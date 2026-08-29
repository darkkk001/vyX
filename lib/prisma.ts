import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

// Accelerate replaces the plain pooled Postgres connection with Prisma's
// own edge-routed connection pool, but only understands its own proxy
// protocol -- a DATABASE_URL of prisma:// or prisma+postgres://
// (accelerate.prisma-data.net). It was adopted because every serverless
// invocation on Vercel was paying real, consistent latency just to
// acquire a Postgres connection (measured: even fully parallelized
// read-only pages like /manage/dashboard sat around 1.2-1.5s versus
// ~0.2-0.6s for a page with no DB work at all).
//
// Once DATABASE_URL points at a plain postgresql://... connection instead
// (Neon direct or pooled -- see docs/db-migration.md), applying
// withAccelerate() to it is wrong, not just redundant: the extension
// expects the Accelerate proxy protocol and errors against a raw libpq
// URL. So this only wraps the client when DATABASE_URL is actually an
// Accelerate URL, detected once at module load -- the same file works
// unmodified before, during, and after the Neon cutover, and a plain
// Postgres connection (Neon or otherwise) just gets an ordinary
// PrismaClient with no proxy in the path. Not using Accelerate's
// query-caching (cacheStrategy) anywhere -- every read here (balances,
// positions, prices) needs to be live, never a cached/stale one -- so
// there is nothing Accelerate-specific this app depends on once its own
// connection-pooling role is gone.
//
// `.$extends()`'s return type breaks TypeScript's `include`/`select`
// inference everywhere else in the app that calls `prisma.model.findMany`
// with a nested include (confirmed: reverting just this file's extends
// call took the app from 130+ new `tsc` errors to 0) -- a known
// Prisma/Accelerate typing quirk, not a real capability loss. Extensions
// only add methods, never remove or narrow existing ones, so casting the
// extended client back to the plain `PrismaClient` type is safe: every
// model delegate, `$queryRaw`, and `$transaction` call behaves exactly as
// before, Accelerate's pooling still applies at runtime (when the
// extension is actually applied) regardless of the TS type used to
// describe it.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function isAccelerateUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith("prisma://") || url.startsWith("prisma+postgres://"));
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient();
  if (isAccelerateUrl(process.env.DATABASE_URL)) {
    return client.$extends(withAccelerate()) as unknown as PrismaClient;
  }
  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
