// Owner 2026-11-10: the CRM screens are a staff permission (CRM). Every handler behind lib/crm/core.ts crmStaff (leads,
// lead import, clients, tasks, notes, tickets, settings) lets a BROKER_ADMIN and a MANAGER holding CRM through and refuses
// (exactly 403) a MANAGER without it; SUPPORT still reads, never writes. Unchanged: saving CRM settings is broker-admin
// only, the leverage queue needs ACCOUNT_FINANCE and the IB payout queue IB_PAYOUTS, whatever CRM says. The migration
// grants CRM to every MANAGER that exists, so no current manager loses access. Live scratch DB.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { allowedBackofficeScreens } from "@/lib/backoffice-screens";
import { PERMISSIONS, PERMISSION_LABELS } from "@/lib/permission-labels";

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

const FAKE_ID = "cnonexistenttestid00001";
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
const OWN_PERMISSION = { "crm/leverage-requests/route": "ACCOUNT_FINANCE", "crm/ib-payout-requests/route": "IB_PAYOUTS" } as Record<string, string>;
const SETTINGS = "crm/settings/route";

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}
const ALL = routeFiles(path.join(import.meta.dirname, "crm")).flatMap((f) => {
  const src = readFileSync(f, "utf8");
  const mod = path.relative(import.meta.dirname, f).replace(/\\/g, "/").replace(/\.ts$/, "");
  return METHODS.filter((m) => new RegExp(`export (async function ${m}\\b|const ${m}\\b|\\{[^}]*\\b${m}\\b)`).test(src)).map((method) => ({ mod, method, crmStaff: src.includes("crmStaff(") }));
});
const GATED = ALL.filter((h) => !(h.mod in OWN_PERMISSION));

type Who = "admin" | "crmManager" | "plainManager" | "financeManager" | "ibManager" | "support";
const DEFS: Record<Who, { role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT"; extraPermissions: string[] }> = {
  admin: { role: "BROKER_ADMIN", extraPermissions: [] },
  crmManager: { role: "MANAGER", extraPermissions: ["CRM"] },
  plainManager: { role: "MANAGER", extraPermissions: ["PRICING", "DEALING", "KYC_REVIEW", "LIQUIDITY_PROVIDERS"] },
  financeManager: { role: "MANAGER", extraPermissions: ["ACCOUNT_FINANCE"] },
  ibManager: { role: "MANAGER", extraPermissions: ["IB_PAYOUTS"] },
  support: { role: "SUPPORT", extraPermissions: [] },
};
const ids = {} as Record<Who, string>;
let brokerId = "";

beforeAll(async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  brokerId = (await prisma.broker.create({ data: { name: `CRM Permission Test ${suffix}`, subdomain: `crmperm-${suffix}`, crmEnabled: true } })).id;
  for (const [k, d] of Object.entries(DEFS) as [Who, (typeof DEFS)[Who]][]) {
    ids[k] = (await prisma.adminUser.create({ data: { brokerId, email: `crmperm-${k}-${suffix}@test.local`, passwordHash: "x", role: d.role, status: "ACTIVE", extraPermissions: d.extraPermissions, twoFactorEnabled: true } })).id;
  }
}, 30000);

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { brokerId } });
  await prisma.adminUser.deleteMany({ where: { brokerId } });
  await prisma.broker.deleteMany({ where: { id: brokerId } });
}, 30000);

async function call(mod: string, method: string, who: Who): Promise<number | "THREW"> {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: ids[who], role: DEFS[who].role, brokerId });
  const handler = (await import(`./${mod}.ts`))[method] as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
  const url = `https://test.local/api/manage/${mod.replace(/\/route$/, "")}`;
  const req = new NextRequest(url, method === "GET" || method === "DELETE" ? { method } : { method, headers: { "content-type": "application/json" }, body: "{}" });
  try {
    return (await handler(req, { params: Promise.resolve({ id: FAKE_ID }) })).status;
  } catch {
    return "THREW";
  }
}

describe("CRM permission", () => {
  it("is in the staff permission list with its label", () => {
    expect(PERMISSIONS).toContain("CRM");
    expect(PERMISSION_LABELS.CRM).toBe("CRM (leads pipeline, clients 360, support tickets)");
  });

  it("every CRM route but the two queues goes through crmStaff, and the gated set is the expected one", () => {
    for (const h of GATED) expect(h.crmStaff, `${h.method} ${h.mod}`).toBe(true);
    const mods = new Set(GATED.map((h) => h.mod));
    for (const m of ["crm/leads/route", "crm/leads/[id]/route", "crm/leads/import/route", "crm/clients/route", "crm/clients/[id]/route", "crm/tasks/route", "crm/notes/route", "crm/tickets/route", "crm/tickets/[id]/route", SETTINGS]) {
      expect(mods.has(m), m).toBe(true);
    }
  });

  for (const h of GATED) {
    const adminOnly = h.mod === SETTINGS && h.method !== "GET";
    it(`${h.method} ${h.mod}: ${adminOnly ? "broker admin only (unchanged)" : "admin and a CRM holder pass, a manager without it gets 403"}`, async () => {
      expect(await call(h.mod, h.method, "admin")).not.toBe(403);
      if (adminOnly) expect(await call(h.mod, h.method, "crmManager")).toBe(403);
      else expect(await call(h.mod, h.method, "crmManager")).not.toBe(403);
      expect(await call(h.mod, h.method, "plainManager")).toBe(403);
      if (h.method === "GET") expect(await call(h.mod, h.method, "support")).not.toBe(403);
      else expect(await call(h.mod, h.method, "support")).toBe(403);
    });
  }

  it("the leverage and IB payout queues keep their own permissions, CRM or not", async () => {
    for (const h of ALL.filter((x) => x.mod in OWN_PERMISSION)) {
      const holder: Who = OWN_PERMISSION[h.mod] === "ACCOUNT_FINANCE" ? "financeManager" : "ibManager";
      expect(await call(h.mod, h.method, holder), `${h.method} ${h.mod} ${holder}`).not.toBe(403);
      expect(await call(h.mod, h.method, "crmManager"), `${h.method} ${h.mod} crmManager`).toBe(403);
    }
  });

  it("the menu: CRL shows for a broker admin and a CRM holder only; the old Leads code (CRM) is unchanged", () => {
    expect(allowedBackofficeScreens("BROKER_ADMIN", [])).toContain("CRL");
    expect(allowedBackofficeScreens("MANAGER", ["CRM"])).toContain("CRL");
    expect(allowedBackofficeScreens("MANAGER", ["PRICING"])).not.toContain("CRL");
    expect(allowedBackofficeScreens("SUPPORT", [])).not.toContain("CRL");
    expect(allowedBackofficeScreens("MANAGER", [])).toContain("CRM");
  });

  it("shell-info carries the module switch for every role, so the queues need no CRM read", async () => {
    const { GET } = await import("./shell-info/route");
    const { getAdminSession } = await import("@/lib/auth");
    for (const w of ["admin", "plainManager", "financeManager", "support"] as Who[]) {
      vi.mocked(getAdminSession).mockResolvedValue({ adminId: ids[w], role: DEFS[w].role, brokerId });
      const body = await (await GET()).json();
      expect(body.crmEnabled, w).toBe(true);
    }
  });

  it("the migration grants CRM to every existing MANAGER and to no one else, and is idempotent (rolled back)", async () => {
    const sql = readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "prisma", "migrations", "20261110120000_crm_permission", "migration.sql"), "utf8");
    const stmt = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();
    const ROLLBACK = new Error("rollback");
    await expect(prisma.$transaction(async (tx) => {
      await tx.adminUser.update({ where: { id: ids.crmManager }, data: { extraPermissions: ["CRM"] } });
      await tx.$executeRawUnsafe(stmt);
      await tx.$executeRawUnsafe(stmt);
      const rows = await tx.adminUser.findMany({ where: { brokerId }, select: { id: true, role: true, extraPermissions: true } });
      for (const r of rows) {
        const crm = r.extraPermissions.filter((p) => p === "CRM").length;
        expect(crm, r.id).toBe(r.role === "MANAGER" ? 1 : 0);
      }
      const plain = rows.find((r) => r.id === ids.plainManager)!;
      expect(plain.extraPermissions).toEqual(["PRICING", "DEALING", "KYC_REVIEW", "LIQUIDITY_PROVIDERS", "CRM"]);
      const left = await tx.adminUser.count({ where: { role: "MANAGER", NOT: { extraPermissions: { has: "CRM" } } } });
      expect(left).toBe(0);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });
});
