import type { PrismaClient } from "@prisma/client";

// A killed vitest run never reaches its teardown and leaves `<base>_t<8 hex run id>_*` clone databases behind (a full run leaves
// ~160). At setup start the next run drops the leftovers of the SAME base: names exactly `<base>_t<8 hex>` + `_...` or end, no
// active connection, and created more than minAgeMs ago (the creation time is the modification time of the database directory's
// PG_VERSION file, which needs the superuser the scratch server's postgres role is; if it cannot be read nothing is dropped).
// Another base's clones, and any database that does not match the pattern, are never touched.
export async function dropStaleClones(admin: Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">, baseDb: string, minAgeMs = 2 * 3600_000): Promise<string[]> {
  const base = baseDb.toLowerCase();
  const pattern = new RegExp(`^${base.replace(/[^a-z0-9_]/g, "\$&")}_t[0-9a-f]{8}(_|$)`);
  const rows = await admin.$queryRawUnsafe<{ datname: string; oid: number; busy: number; created: Date | null }[]>(
    `SELECT d.datname, d.oid::int AS oid,
            (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS busy,
            (SELECT (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification) AS created
       FROM pg_database d WHERE d.datname LIKE '${base.replace(/_/g, "\_")}\_t%'`
  ).catch(() => []);
  const dropped: string[] = [];
  for (const r of rows) {
    if (!pattern.test(r.datname) || r.busy > 0 || !r.created) continue;
    if (Date.now() - new Date(r.created).getTime() < minAgeMs) continue;
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${r.datname}"`); // no FORCE: a database somebody connected to meanwhile survives
      dropped.push(r.datname);
    } catch {
      /* in use after all: leave it */
    }
  }
  return dropped;
}
