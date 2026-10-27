import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { EXPECTED_MIGRATIONS } from "@/lib/expected-migrations.generated";
import {
  QUERY_TIMEOUT_MS,
  RECHECK_MS,
  getSchemaState,
  refreshIfStale,
  resetSchemaState,
  runSchemaCheck,
} from "@/lib/schema-guard";
import { GET as schemaStatusGET } from "@/app/api/internal/schema-status/route";
import { GET as healthGET } from "@/app/api/health/route";

// DB-backed: each test file runs against its own clone of the scratch database (vitest.global.isolated-db.ts), so
// editing _prisma_migrations here cannot touch anything else.

const SECRET = "test-secret";
const LAST = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1];

async function loadMiddleware() {
  vi.resetModules();
  const mod = await import("@/middleware");
  return mod.middleware;
}

function mockInternalFetch() {
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/schema-status") {
      return schemaStatusGET(new NextRequest(url, { headers: { "x-internal-secret": SECRET } }));
    }
    throw new Error("unexpected fetch " + url.pathname);
  });
}

function apiRequest(p: string) {
  return new NextRequest(`http://localhost${p}`, { headers: { host: "localhost" } });
}

let errors: string[];
let warns: string[];
let infos: string[];

beforeEach(() => {
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
  process.env.ROOT_DOMAIN = "localhost";
  resetSchemaState();
  errors = [];
  warns = [];
  infos = [];
  vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation((m) => void warns.push(String(m)));
  vi.spyOn(console, "info").mockImplementation((m) => void infos.push(String(m)));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Undo whatever the test did to _prisma_migrations: rename the hidden migration back, drop the extra row.
  await prisma.$executeRaw`UPDATE _prisma_migrations SET migration_name = ${LAST} WHERE migration_name = ${"zz_guard_test_" + LAST}`;
  await prisma.$executeRaw`DELETE FROM _prisma_migrations WHERE id IN ('zz-guard-test-ahead', 'zz-guard-test-dup')`;
});

async function unapplyLast() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM _prisma_migrations WHERE migration_name = ${LAST}`;
  expect(rows.length).toBe(1);
  await prisma.$executeRaw`UPDATE _prisma_migrations SET migration_name = ${"zz_guard_test_" + LAST} WHERE migration_name = ${LAST}`;
}

describe("generated list", () => {
  it("matches prisma/migrations", () => {
    const dir = path.resolve(import.meta.dirname, "..", "prisma", "migrations");
    const onDisk = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect([...EXPECTED_MIGRATIONS]).toEqual(onDisk);
  });
});

describe("schema guard against the scratch database", () => {
  it("pending migration: logs the exact line and every route answers 503", async () => {
    await unapplyLast();
    const state = await runSchemaCheck();
    expect(state.status).toBe("behind");
    expect(errors).toEqual([
      `SCHEMA GUARD: database is behind this build: missing 1 migration(s): ${LAST}. Refusing to serve. Run prisma migrate deploy.`,
    ]);

    mockInternalFetch();
    const middleware = await loadMiddleware();
    for (const p of ["/api/trade/orders", "/api/manage/candles", "/api/auth/sign-in"]) {
      const res = await middleware(apiRequest(p));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Service is being updated, try again shortly" });
    }
    const health = await healthGET();
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "updating", schema: "behind (1)" });
  });

  it("recovers without a redeploy once the migration is applied", async () => {
    await unapplyLast();
    await runSchemaCheck();
    await prisma.$executeRaw`UPDATE _prisma_migrations SET migration_name = ${LAST} WHERE migration_name = ${"zz_guard_test_" + LAST}`;
    const { refreshIfStale } = await import("@/lib/schema-guard");
    const s = await refreshIfStale({ now: Date.now() + 60_000 });
    expect(s.status).toBe("ok");
    expect(infos.join("\n")).toContain("now up to date");
  });

  it("all applied: serves normally", async () => {
    const state = await runSchemaCheck();
    expect(state.status).toBe("ok");
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    mockInternalFetch();
    const middleware = await loadMiddleware();
    const res = await middleware(apiRequest("/api/trade/orders"));
    expect(res.status).not.toBe(503);
    const health = await healthGET();
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", schema: "ok", db: "ok" });
  });

  it("database unreachable: warns and serves", async () => {
    const state = await runSchemaCheck({
      query: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(state.status).toBe("unknown");
    expect(errors).toEqual([]);
    expect(warns.join("\n")).toContain("SCHEMA GUARD: could not verify migrations");
    mockInternalFetch();
    const middleware = await loadMiddleware();
    const res = await middleware(apiRequest("/api/trade/orders"));
    expect(res.status).not.toBe(503);
    expect((await healthGET()).status).toBe(200);
  });

  it("database ahead: info line and serves", async () => {
    await prisma.$executeRaw`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
      VALUES ('zz-guard-test-ahead', 'x', 'zz_guard_test_ahead', now(), now(), 1)`;
    const state = await runSchemaCheck();
    expect(state.status).toBe("ok");
    expect(errors).toEqual([]);
    expect(infos.join("\n")).toContain("more migration(s) than this build");
    expect(getSchemaState().status).toBe("ok");
    await prisma.$executeRaw`DELETE FROM _prisma_migrations WHERE id = 'zz-guard-test-ahead'`;
  });

  it("failed check is re-checked: stays quiet while still failing, then guards again", async () => {
    const failing = async (): Promise<string[]> => {
      throw new Error("schema check timed out");
    };
    await runSchemaCheck({ query: failing });
    expect(getSchemaState().status).toBe("unknown");
    // too soon: no new query
    let calls = 0;
    const counting = async () => {
      calls++;
      return failing();
    };
    await refreshIfStale({ query: counting, now: Date.now() + 1_000 });
    expect(calls).toBe(0);
    // still failing after RECHECK_MS: re-queried, no second warning
    await refreshIfStale({ query: counting, now: Date.now() + RECHECK_MS });
    expect(calls).toBe(1);
    expect(warns.length).toBe(1);
    // the database answers: the guard is on again, and a pending migration is now refused
    await unapplyLast();
    const s = await refreshIfStale({ now: Date.now() + RECHECK_MS });
    expect(s.status).toBe("behind");
    mockInternalFetch();
    const middleware = await loadMiddleware();
    expect((await middleware(apiRequest("/api/trade/orders"))).status).toBe(503);
  });

  it("unknown recovers to ok with one info line", async () => {
    await runSchemaCheck({ query: async () => Promise.reject(new Error("connect ECONNREFUSED")) });
    const s = await refreshIfStale({ now: Date.now() + RECHECK_MS });
    expect(s.status).toBe("ok");
    expect(infos.join("\n")).toContain("verified after an earlier failed check");
  });

  it("timeout allows a slow Neon wake-up", () => {
    expect(QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("a migration recorded twice is not counted as ahead", async () => {
    // The scratch database may already be ahead (migrations from other branches): compare against its own baseline.
    const extraNow = async () => {
      infos.length = 0;
      expect((await runSchemaCheck()).status).toBe("ok");
      const m = infos.join("\n").match(/database has (\d+) more migration/);
      return m ? Number(m[1]) : 0;
    };
    const baseline = await extraNow();
    await prisma.$executeRaw`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
      VALUES ('zz-guard-test-dup', 'x', ${LAST}, now(), now(), 1)`;
    expect(await extraNow()).toBe(baseline);
    await prisma.$executeRaw`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
      VALUES ('zz-guard-test-ahead', 'x', 'zz_guard_test_ahead', now(), now(), 1)`;
    expect(await extraNow()).toBe(baseline + 1);
  });

  it("schema-status refuses callers without the internal secret", async () => {
    const res = await schemaStatusGET(new NextRequest("http://localhost/api/internal/schema-status"));
    expect(res.status).toBe(403);
  });
});
