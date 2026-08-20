import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

// Accelerate replaces the plain pooled Postgres connection with Prisma's
// own edge-routed connection pool (DATABASE_URL is now a
// prisma+postgres://accelerate.prisma-data.net/... URL, not a raw
// postgres:// one -- see prisma/schema.prisma's datasource comment).
// Every serverless invocation on Vercel was paying real, consistent
// latency just to acquire a Postgres connection (measured: even fully
// parallelized read-only pages like /manage/dashboard sat around 1.2-1.5s
// versus ~0.2-0.6s for a page with no DB work at all) -- Accelerate's
// pool is what this is meant to remove. Not using its query-caching
// (cacheStrategy) anywhere -- every read here (balances, positions,
// prices) needs to be live, never a cached/stale one.
//
// `.$extends()`'s return type breaks TypeScript's `include`/`select`
// inference everywhere else in the app that calls `prisma.model.findMany`
// with a nested include (confirmed: reverting just this file's extends
// call took the app from 130+ new `tsc` errors to 0) -- a known
// Prisma/Accelerate typing quirk, not a real capability loss. Extensions
// only add methods, never remove or narrow existing ones, so casting the
// extended client back to the plain `PrismaClient` type is safe: every
// model delegate, `$queryRaw`, and `$transaction` call behaves exactly as
// before, Accelerate's pooling still applies at runtime regardless of the
// TS type used to describe it. The only thing this cast hides is
// `$accelerate`-specific extras like `cacheStrategy`, which nothing here
// uses (see comment above -- every read needs to be live).
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function withAccelerateClient(): PrismaClient {
  return new PrismaClient().$extends(withAccelerate()) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? withAccelerateClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
