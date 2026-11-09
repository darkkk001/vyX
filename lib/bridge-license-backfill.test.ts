import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";

// License enforcement 1.2: the migration's one-time backfill of ClientBuild.expiresAt / features from the
// BRIDGE_LICENSE_ISSUED audit rows. Runs exactly the migration file's UPDATE (everything after its BACKFILL marker)
// against the scratch DB, on rows of every shape the audit history can hold.
const MIGRATION = path.resolve(import.meta.dirname, "..", "prisma", "migrations", "20261109120000_bridge_license_enforcement", "migration.sql");
const backfillSql = () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const at = sql.indexOf("-- BACKFILL");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at).trim().replace(/;\s*$/, "");
};

let ready = false;
let brokerId = "";
const ids: string[] = [];
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "expiresAt", "features" FROM "ClientBuild" LIMIT 1`;
    const s = randomUUID().replace(/-/g, "").slice(0, 8);
    brokerId = (await prisma.broker.create({ data: { name: `BLB ${s}`, subdomain: `blb-${s}` } })).id;
    ready = true;
  } catch {
    console.warn("lib/bridge-license-backfill.test.ts: DB (with the 1.2 columns) unreachable, skipping");
  }
});
afterAll(async () => {
  if (ready) {
    await prisma.clientBuild.deleteMany({ where: { buildId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { brokerId } });
    await prisma.broker.deleteMany({ where: { id: brokerId } });
  }
  await prisma.$disconnect();
});

async function row(o: { app?: string; version?: string; expiresAt?: Date | null; features?: string[] } = {}) {
  const id = `blb-${randomUUID().slice(0, 8)}`;
  ids.push(id);
  await prisma.clientBuild.create({
    data: { buildId: id, brokerId, brokerSubdomain: "blb", app: o.app ?? "bridge", version: o.version ?? "license", status: "ACTIVE", createdAt: new Date(), note: "", expiresAt: o.expiresAt ?? null, features: o.features ?? [] },
  });
  return id;
}
async function issuedAudit(entityId: string, newValue: unknown, createdAt = new Date()) {
  await prisma.auditLog.create({ data: { brokerId, action: "BRIDGE_LICENSE_ISSUED", entityType: "ClientBuild", entityId, newValue: newValue as never, createdAt } });
}
const get = (id: string) => prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id }, select: { expiresAt: true, features: true } });

describe("migration 20261109120000_bridge_license_enforcement: the backfill", () => {
  it("fills expiresAt + features once from the first issue row; leaves bad shapes, filled rows and non-bridge rows alone", async () => {
    if (!ready) return;
    const good = await row();
    await issuedAudit(good, { licenseId: good, features: ["hedge", "feed"], expiresAt: "2027-11-09T10:00:00.000Z", machineId: "abcdef12..." });

    const twice = await row();
    await issuedAudit(twice, { features: ["feed"], expiresAt: "2027-01-01T00:00:00.000Z" }, new Date(Date.now() - 60_000));
    await issuedAudit(twice, { features: ["hedge"], expiresAt: "2028-01-01T00:00:00.000Z" });

    const bad = await row();
    await issuedAudit(bad, { features: "hedge", expiresAt: "soon" });
    const notObject = await row();
    await issuedAudit(notObject, ["hedge"]);
    const nullValue = await row();
    await issuedAudit(nullValue, null);

    const unknownFeature = await row();
    await issuedAudit(unknownFeature, { features: ["hedge", "mint", 7], expiresAt: "2027-06-01T00:00:00+05:00" });

    const filled = await row({ expiresAt: new Date("2030-01-01T00:00:00Z"), features: ["feed"] });
    await issuedAudit(filled, { features: ["hedge"], expiresAt: "2027-01-01T00:00:00.000Z" });

    const terminal = await row({ app: "terminal", version: "1.0.0" });
    await issuedAudit(terminal, { features: ["hedge"], expiresAt: "2027-01-01T00:00:00.000Z" });

    const noAudit = await row();

    await prisma.$executeRawUnsafe(backfillSql());

    expect(await get(good)).toEqual({ expiresAt: new Date("2027-11-09T10:00:00.000Z"), features: ["hedge", "feed"] });
    expect(await get(twice)).toEqual({ expiresAt: new Date("2027-01-01T00:00:00.000Z"), features: ["feed"] }); // the first issue row
    expect(await get(bad)).toEqual({ expiresAt: null, features: [] });
    expect(await get(notObject)).toEqual({ expiresAt: null, features: [] });
    expect(await get(nullValue)).toEqual({ expiresAt: null, features: [] });
    expect(await get(unknownFeature)).toEqual({ expiresAt: new Date("2027-05-31T19:00:00.000Z"), features: ["hedge"] });
    expect(await get(filled)).toEqual({ expiresAt: new Date("2030-01-01T00:00:00Z"), features: ["feed"] });
    expect(await get(terminal)).toEqual({ expiresAt: null, features: [] });
    expect(await get(noAudit)).toEqual({ expiresAt: null, features: [] });

    // running it again changes nothing (idempotent)
    await prisma.$executeRawUnsafe(backfillSql());
    expect(await get(good)).toEqual({ expiresAt: new Date("2027-11-09T10:00:00.000Z"), features: ["hedge", "feed"] });
    expect(await get(twice)).toEqual({ expiresAt: new Date("2027-01-01T00:00:00.000Z"), features: ["feed"] });

    // and the readers fall back to the audit row only where the backfill could not fill
    const { bridgeLicenseExpiries } = await import("@/lib/bridge-licenses");
    const m = await bridgeLicenseExpiries([good, bad, noAudit]);
    expect(m.get(good)).toBe(Date.parse("2027-11-09T10:00:00.000Z"));
    expect(m.has(bad)).toBe(false);
    expect(m.has(noAudit)).toBe(false);
  });

  it("the migration's ALTER is additive only (no DROP, no type change)", () => {
    const sql = readFileSync(MIGRATION, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    expect((sql.match(/ADD COLUMN/g) ?? []).length).toBe(12);
  });
});
