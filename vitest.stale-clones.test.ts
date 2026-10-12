import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { dropStaleClones } from "./vitest.stale-clones";

// The leftover-clone sweep: drops only idle, old clones of ITS OWN base; leaves another base's clones, a busy one, a young one and
// any non-matching name alone. Uses its own fake database names on the local scratch server.
let admin: PrismaClient;
let adminUrl: string;
const names = ["sweeptest_tdeadbeef_a", "sweeptest_tdeadbeef_tpl", "sweeptest_tcafebabe", "sweeptest_tbusy0001_x", "sweeptestother_tdeadbeef_a", "sweeptest_tnothexx_x", "sweeptest_extra"];
const exists = async (n: string) => (await admin.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname = '${n}'`)).length > 0;

beforeAll(async () => {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = "/postgres";
  adminUrl = u.toString();
  admin = new PrismaClient({ datasourceUrl: adminUrl });
  for (const n of names) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
  for (const n of names) await admin.$executeRawUnsafe(`CREATE DATABASE "${n}" TEMPLATE template0`);
}, 120_000);
afterAll(async () => {
  for (const n of names) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => {});
  await admin.$disconnect();
}, 120_000);

describe("dropStaleClones", () => {
  it("drops idle clones of the same base and nothing else", async () => {
    const u = new URL(adminUrl);
    u.pathname = "/sweeptest_tbusy0001_x";
    const busy = new PrismaClient({ datasourceUrl: u.toString() });
    await busy.$queryRaw`SELECT 1`; // an open connection: the database is in use
    const dropped = await dropStaleClones(admin, "sweeptest", 0);
    expect(dropped.sort()).toEqual(["sweeptest_tcafebabe", "sweeptest_tdeadbeef_a", "sweeptest_tdeadbeef_tpl"]);
    expect(await exists("sweeptest_tbusy0001_x")).toBe(true); // busy
    expect(await exists("sweeptestother_tdeadbeef_a")).toBe(true); // another base
    expect(await exists("sweeptest_tnothexx_x")).toBe(true); // not a run id
    expect(await exists("sweeptest_extra")).toBe(true); // not a clone name
    await busy.$disconnect();
  });
  it("a clone younger than the age limit is kept", async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "sweeptest_tabcd1234_y" TEMPLATE template0`);
    expect(await dropStaleClones(admin, "sweeptest", 2 * 3600_000)).toEqual([]);
    expect(await exists("sweeptest_tabcd1234_y")).toBe(true);
    await admin.$executeRawUnsafe(`DROP DATABASE "sweeptest_tabcd1234_y"`);
  });
});
