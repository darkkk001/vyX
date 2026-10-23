import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { backfillClientBuildsToPostgres, getClientBuild, registerClientBuild, restoreClientBuildRegistry, setClientBuildStatus } from "@/lib/client-builds";

// Build registry durability (2026-10-23): every publish / revoke reaches Postgres ("ClientBuild") and Redis; a Redis
// that lost the registry is rebuilt from Postgres at startup. Local Redis (db 9, vitest.setup.db-guard.ts) + scratch DB.

const INDEX = "client_builds:index";
const tag = randomUUID().replace(/-/g, "").slice(0, 10);
const ids: string[] = [];
const newId = () => {
  const id = `test-${tag}-${ids.length}`;
  ids.push(id);
  return id;
};
const build = (buildId: string) => ({ buildId, brokerId: `broker-${tag}`, brokerSubdomain: `cbtest-${tag}`, app: "terminal" as const, version: "1.0.99", note: "" });

let ready = false;
let savedIndex: string[] = [];
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "ClientBuild" LIMIT 1`;
    await getRedis().ping();
    savedIndex = await getRedis().smembers(INDEX); // db 9 is test-only, but put back whatever another test left
    ready = true;
  } catch {
    console.warn("lib/client-builds.test.ts: DB (with the ClientBuild table) or Redis unreachable, skipping");
  }
});
afterAll(async () => {
  if (ready) {
    const r = getRedis();
    for (const id of ids) await r.del(`client_build:${id}`);
    await r.srem(INDEX, ...ids);
    if (savedIndex.length) await r.sadd(INDEX, ...savedIndex);
    await prisma.clientBuild.deleteMany({ where: { buildId: { in: ids } } });
  }
  await prisma.$disconnect();
});

describe("client build registry: Postgres + Redis", () => {
  it("a publish is written to Postgres and Redis; a revoke updates both", async () => {
    if (!ready) return;
    const id = newId();
    await registerClientBuild(build(id));
    expect((await getClientBuild(id))?.status).toBe("ACTIVE");
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } })).status).toBe("ACTIVE");

    await setClientBuildStatus(id, "REVOKED", "kill switch test");
    expect((await getClientBuild(id))?.status).toBe("REVOKED");
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect([row.status, row.note, row.revokedAt != null]).toEqual(["REVOKED", "kill switch test", true]);
  });

  it("a Redis that lost every registry key is rebuilt from Postgres, revocations included; a healthy Redis is left alone", async () => {
    if (!ready) return;
    const a = newId(), b = newId();
    await registerClientBuild(build(a));
    await registerClientBuild(build(b));
    await setClientBuildStatus(b, "REVOKED");
    expect(await restoreClientBuildRegistry()).toBe(0); // index not empty: nothing read, nothing written

    // Redis loses the registry (flush / new instance)
    const r = getRedis();
    const all = await r.smembers(INDEX);
    for (const id of all) await r.del(`client_build:${id}`);
    await r.del(INDEX);
    expect(await getClientBuild(a)).toBeNull();

    const restored = await restoreClientBuildRegistry();
    expect(restored).toBeGreaterThanOrEqual(2);
    expect((await getClientBuild(a))?.status).toBe("ACTIVE");
    expect((await getClientBuild(b))?.status).toBe("REVOKED"); // a revoked build stays revoked after the rebuild
    expect(await r.sismember(INDEX, a)).toBe(1);
  });

  it("backfill gives a Redis-only build (registered before the durable copy) its Postgres row, and never overwrites one", async () => {
    if (!ready) return;
    const old = newId();
    const rec = { ...build(old), status: "ACTIVE", createdAt: "2026-09-15T10:00:00.000Z", revokedAt: null };
    await getRedis().set(`client_build:${old}`, JSON.stringify(rec));
    await getRedis().sadd(INDEX, old);
    expect(await prisma.clientBuild.findUnique({ where: { buildId: old } })).toBeNull();

    expect(await backfillClientBuildsToPostgres()).toBeGreaterThanOrEqual(1);
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: old } });
    expect([row.status, row.createdAt.toISOString()]).toEqual(["ACTIVE", "2026-09-15T10:00:00.000Z"]);
    await prisma.clientBuild.update({ where: { buildId: old }, data: { note: "kept" } });
    await backfillClientBuildsToPostgres();
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: old } })).note).toBe("kept");
  });
});
