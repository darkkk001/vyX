// Owner 2026-11-10: the Liquidity providers screen is a delegatable permission. Every handler of every LP route module
// (providers, routing rules, LP connections and their symbols, the LP overview) lets a BROKER_ADMIN and a MANAGER holding
// LIQUIDITY_PROVIDERS through, and refuses (exactly 403) a MANAGER without it and SUPPORT. The small CONNECTED badge
// (liquidity/status) stays readable by any staff. The menu entry follows the same rule (lib/backoffice-screens.ts).
// Live scratch DB, same harness as permission-matrix.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { allowedBackofficeScreens } from "@/lib/backoffice-screens";
import { PERMISSIONS, PERMISSION_LABELS } from "@/lib/permission-labels";

vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

const FAKE_ID = "cnonexistenttestid00001";
const DIRS = ["liquidity", "liquidity-providers", "lp-routing", "lp-connections"];
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}
const HANDLERS: { mod: string; method: (typeof METHODS)[number] }[] = DIRS.flatMap((d) =>
  routeFiles(path.join(import.meta.dirname, d)).flatMap((f) => {
    const src = readFileSync(f, "utf8");
    const mod = path.relative(import.meta.dirname, f).replace(/\\/g, "/").replace(/\.ts$/, "");
    return METHODS.filter((m) => new RegExp(`export (async function ${m}\\b|const ${m}\\b|\\{[^}]*\\b${m}\\b)`).test(src)).map((method) => ({ mod, method }));
  })
);
const BADGE = "liquidity/status/route";

type Who = "admin" | "lpManager" | "plainManager" | "support";
const DEFS: Record<Who, { role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT"; extraPermissions: string[] }> = {
  admin: { role: "BROKER_ADMIN", extraPermissions: [] },
  lpManager: { role: "MANAGER", extraPermissions: ["LIQUIDITY_PROVIDERS"] },
  plainManager: { role: "MANAGER", extraPermissions: ["PRICING", "DEALING", "GROUPS_SYMBOLS"] },
  support: { role: "SUPPORT", extraPermissions: [] },
};
const ids: Record<Who, string> = { admin: "", lpManager: "", plainManager: "", support: "" };
let brokerId = "";

beforeAll(async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  brokerId = (await prisma.broker.create({ data: { name: `LP Permission Test ${suffix}`, subdomain: `lpperm-${suffix}` } })).id;
  for (const [k, d] of Object.entries(DEFS) as [Who, (typeof DEFS)[Who]][]) {
    ids[k] = (await prisma.adminUser.create({ data: { brokerId, email: `lpperm-${k}-${suffix}@test.local`, passwordHash: "x", role: d.role, status: "ACTIVE", extraPermissions: d.extraPermissions } })).id;
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
    return (await handler(req, { params: Promise.resolve({ id: FAKE_ID, rowId: FAKE_ID }) })).status;
  } catch {
    return "THREW";
  }
}

describe("Liquidity providers permission (LIQUIDITY_PROVIDERS)", () => {
  it("is in the staff permission list with its label", () => {
    expect(PERMISSIONS).toContain("LIQUIDITY_PROVIDERS");
    expect(PERMISSION_LABELS.LIQUIDITY_PROVIDERS).toBe("Liquidity providers (providers, routing rules, LP connections)");
  });

  it("covers every LP route module (no handler left out)", () => {
    const mods = new Set(HANDLERS.map((h) => h.mod));
    for (const m of ["liquidity/route", "liquidity-providers/route", "liquidity-providers/[id]/route", "lp-routing/route", "lp-routing/[id]/route",
      "lp-connections/route", "lp-connections/[id]/route", "lp-connections/[id]/symbols/route", "lp-connections/[id]/symbols/[rowId]/route", "lp-connections/symbol-defaults/route"]) {
      expect(mods.has(m), m).toBe(true);
    }
    expect(HANDLERS.length).toBeGreaterThanOrEqual(15);
  });

  for (const h of HANDLERS.filter((x) => x.mod !== BADGE)) {
    it(`${h.method} ${h.mod}: admin and a manager holding it pass; a manager without it and SUPPORT get 403`, async () => {
      expect(await call(h.mod, h.method, "admin")).not.toBe(403);
      expect(await call(h.mod, h.method, "lpManager")).not.toBe(403);
      expect(await call(h.mod, h.method, "plainManager")).toBe(403);
      expect(await call(h.mod, h.method, "support")).toBe(403);
    });
  }

  it("the CONNECTED badge stays readable by any staff", async () => {
    for (const w of ["admin", "lpManager", "plainManager", "support"] as Who[]) expect(await call(BADGE, "GET", w)).not.toBe(403);
  });

  it("the menu: LP shows for a broker admin and a manager holding it, never for one without it", () => {
    expect(allowedBackofficeScreens("BROKER_ADMIN", [])).toContain("LP");
    expect(allowedBackofficeScreens("MANAGER", ["LIQUIDITY_PROVIDERS"])).toContain("LP");
    expect(allowedBackofficeScreens("MANAGER", ["PRICING", "DEALING"])).not.toContain("LP");
    expect(allowedBackofficeScreens("SUPPORT", [])).not.toContain("LP");
  });
});
