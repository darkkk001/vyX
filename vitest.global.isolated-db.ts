import { PrismaClient } from "@prisma/client";
import type { TestProject } from "vitest/node";
import { randomUUID } from "node:crypto";
import { testDbVerdict } from "./scripts/lib/db-host-policy.mjs";

// web4 (owner 2026-09-30: "fix the test-suite isolation so the full suite is a reliable gate").
//
// Why: every DB-backed test file shares ONE database and vitest runs files in parallel, so a file with a global side
// effect (lib/live-price.test.ts notifies EVERY broker in the DB; the risk radar reads the global event history; a
// "next account number" test reads the whole Account table) broke a different file that happened to run at the same
// time -- a different 1-2 failures on every full run.
//
// Fix: every test FILE gets its own throwaway copy of the test database. This global setup clones the configured
// DATABASE_URL once into a run template ("<db>_tpl_<run>"); vitest.setup.isolated-db.ts clones that template again for
// each file (Postgres CREATE DATABASE ... TEMPLATE, a file copy, not a migration) and points DATABASE_URL /
// DIRECT_URL at it before the file imports lib/prisma. The teardown drops every database of the run.
// Only for a LOCAL Postgres (127.0.0.1 / localhost; creating databases on a remote dev branch is not assumed
// possible): anything else runs exactly as before, shared. Opt out with VYX_TEST_SHARED_DB=1.
function localUrl(url: string | undefined): URL | null {
  if (!url || process.env.VYX_TEST_SHARED_DB === "1") return null;
  try {
    const u = new URL(url);
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) return null;
    if (!testDbVerdict(url).ok) return null;
    return u;
  } catch {
    return null;
  }
}

function withDb(u: URL, db: string): string {
  const c = new URL(u.toString());
  c.pathname = `/${db}`;
  return c.toString();
}

let admin: PrismaClient | null = null;
let prefix = "";

export default async function setup(project: TestProject) {
  const base = localUrl(process.env.DATABASE_URL);
  if (!base) return;
  const baseDb = base.pathname.replace(/^\//, "");
  const run = randomUUID().replace(/-/g, "").slice(0, 8);
  prefix = `${baseDb}_t${run}`.toLowerCase();
  const template = `${prefix}_tpl`;
  admin = new PrismaClient({ datasourceUrl: withDb(base, "postgres") });
  // the base must be idle for a TEMPLATE copy: drop our own idle sessions first (a previous run's leftovers)
  await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${baseDb}' AND pid <> pg_backend_pid() AND state = 'idle'`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${template}" TEMPLATE "${baseDb}" STRATEGY FILE_COPY`);
  project.provide("vyxTestDb", { template, prefix, adminUrl: withDb(base, "postgres"), baseUrl: base.toString() });
  const client = admin;
  const runPrefix = prefix;
  // returned teardown: drops every database this run created (template + one per file)
  return async () => {
    const dbs = await client.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname FROM pg_database WHERE datname LIKE '${runPrefix}%'`);
    for (const d of dbs) await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${d.datname}" WITH (FORCE)`).catch(() => {});
    await client.$disconnect();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    vyxTestDb: { template: string; prefix: string; adminUrl: string; baseUrl: string };
  }
}
