import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertNotProductionDatabase } from "@/scripts/lib/assert-not-production.mjs";
import { expectedAllowed, FAKE_ID, MANIFEST, PERSONA_DEFS, type PersonaKey, type Row } from "@/lib/manage-permission-manifest";

// Real-request coverage of the actual RBAC boundary every /api/manage/*
// route enforces -- not a re-derivation of each route's own gating code
// (that would be circular: testing that a route agrees with itself),
// but a hand-authored expectation per route (the `perm` field below,
// assigned by reading each route.ts's own requireAdminRole/forbidUnless
// call) checked against real HTTP-shaped calls into the real handler,
// with real DB-backed AdminUser rows for each persona's extraPermissions.
//
// Motivated by a 2026-09 investigation into a 403 that turned out to
// have nothing to do with the permission MAP (BROKER_ADMIN already
// bypasses it entirely, unconditionally, everywhere) -- this test exists
// to keep that map itself honest for the role it actually governs:
// MANAGER-role delegates. BROKER_ADMIN is deliberately NOT one of the
// four personas below for exactly that reason: it would pass every row
// trivially and prove nothing.
//
// Only GET (or the cheapest available body-bearing method) is exercised
// per distinct permission requirement in a file -- a route with two
// methods gated by the SAME requireAdminRole/forbidUnless call only
// needs one row; risk/route.ts's PATCH is the one file with genuinely
// different per-field gates, so it gets three rows (GET, tradingHalted,
// maxOpenPositionsPerAccount). This is about the authorization BOUNDARY,
// not full business-logic coverage of every route -- a disallowed
// persona must get exactly 403, before touching any real logic; an
// allowed persona must get PAST that check (any non-403 status,
// including a 400/404 from the deliberately-minimal {} body or dummy id
// this test sends -- reaching validation/not-found IS the proof the
// authorization gate let them through).

vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

let dbReachable = false;
let brokerId = "";
const adminIds: Record<PersonaKey, string> = { readonly: "", dealer: "", finance: "", support: "" };
const createdBrokerIds: string[] = [];

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("permission-matrix.test.ts: DB unreachable, skipping");
    return;
  }
  // See this file's own header + the 2026-09-10 investigation: refuses
  // outright against a DATABASE_URL that resolves to production, same
  // guard accounts/route.test.ts already relies on. Deliberately NOT
  // caught -- a reachable production DB must fail this suite loudly.
  await assertNotProductionDatabase(prisma);

  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Permission Matrix Test ${suffix}`, subdomain: `permtest-${suffix}` } });
  brokerId = broker.id;
  createdBrokerIds.push(broker.id);

  for (const [key, def] of Object.entries(PERSONA_DEFS) as [PersonaKey, (typeof PERSONA_DEFS)[PersonaKey]][]) {
    const admin = await prisma.adminUser.create({
      data: {
        brokerId,
        email: `permtest-${key}-${suffix}@test.local`,
        passwordHash: "x",
        role: def.role,
        status: "ACTIVE",
        extraPermissions: def.extraPermissions,
      },
    });
    adminIds[key] = admin.id;
  }
}, 30000);

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.$disconnect();
}, 30000);

async function callRoute(row: Row, persona: PersonaKey): Promise<number | "THREW"> {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({
    adminId: adminIds[persona],
    role: PERSONA_DEFS[persona].role,
    brokerId,
  });

  const mod = await import(`./${row.mod}.ts`);
  const handler = mod[row.method] as (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  const url = `https://test.local/api/manage/${row.mod.replace(/\/route$/, "")}`;
  const request = new NextRequest(
    url,
    row.body !== undefined
      ? { method: row.method, headers: { "content-type": "application/json" }, body: JSON.stringify(row.body) }
      : { method: row.method }
  );

  try {
    const response = await handler(request, { params: Promise.resolve({ id: FAKE_ID }) });
    return response.status;
  } catch {
    // A disallowed persona reaching real business logic and throwing
    // (rather than a clean 403 before it) is itself a bug this test
    // wants to catch -- see the assertion below, which only accepts a
    // throw as "the gate passed" for personas expected to be ALLOWED.
    return "THREW";
  }
}

describe("permission matrix -- every /api/manage/* endpoint x every non-BROKER_ADMIN persona (live DB)", () => {
  const personas: PersonaKey[] = ["readonly", "dealer", "finance", "support"];

  for (const row of MANIFEST) {
    for (const persona of personas) {
      const allowed = expectedAllowed(row.perm, persona, row.supportRead);
      const label = `${row.method} ${row.mod} [${row.perm}${row.supportRead ? "+SUPPORT_READ" : ""}] -- ${persona} should be ${allowed ? "let through" : "blocked (403)"}`;
      it(label, async () => {
        if (!dbReachable) return;
        const status = await callRoute(row, persona);
        if (allowed) {
          expect(status).not.toBe(403);
        } else {
          expect(status).toBe(403);
        }
      });
    }
  }
});

// Phase 2 batch 4 (owner decision: SUPPORT is READ-ONLY). The manifest above is
// hand-authored and only lists one row per distinct gate, so it cannot by itself
// prove "SUPPORT is refused on EVERY write". This sweep discovers every route.ts
// under app/api/manage/ from the filesystem and every method it exports, and
// asserts SUPPORT gets exactly 403 on all of them except the GETs the manifest
// marks supportRead -- a new route or method is covered the day it is added.
// Exempt, with reasons: login + login/verify-2fa (pre-auth, no session at all),
// two-factor-required (answers 403 to everyone by design), theme PATCH (the
// signed-in admin's own light/dark preference, ANY_ADMIN).
const SWEEP_EXEMPT = new Set(["login/route POST", "login/verify-2fa/route POST", "theme/route PATCH"]);
function discoverManageRoutes(): { mod: string; method: Row["method"] }[] {
  const root = path.join(process.cwd(), "app", "api", "manage");
  const out: { mod: string; method: Row["method"] }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        const mod = path.relative(root, full).split(path.sep).join("/").replace(/\.ts$/, "");
        if (mod.startsWith("two-factor-required/")) continue;
        const src = fs.readFileSync(full, "utf8");
        for (const m of src.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PATCH|PUT|DELETE)\b/g)) {
          out.push({ mod, method: m[1] as Row["method"] });
        }
      }
    }
  };
  walk(root);
  return out;
}

describe("SUPPORT is read-only -- every /api/manage/* route x method, auto-discovered (live DB)", () => {
  const supportReads = new Set(MANIFEST.filter((r) => r.supportRead).map((r) => `${r.mod} ${r.method}`));
  const routes = discoverManageRoutes();
  it("discovers the route tree", () => {
    expect(routes.length).toBeGreaterThan(100);
  });
  for (const r of routes) {
    const key = `${r.mod} ${r.method}`;
    if (SWEEP_EXEMPT.has(key)) continue;
    const allowed = supportReads.has(key);
    it(`${key} -- SUPPORT ${allowed ? "may read" : "refused (403)"}`, async () => {
      if (!dbReachable) return;
      // a field-gated write (risk PATCH) answers 400 to an empty body before any gate -- reuse the manifest's body
      const body = r.method === "GET" ? undefined : (MANIFEST.find((m) => m.mod === r.mod && m.method === r.method && m.body)?.body ?? {});
      const status = await callRoute({ mod: r.mod, method: r.method, perm: "ANY_MANAGER", needsId: true, body }, "support");
      if (allowed) expect(status).not.toBe(403);
      else expect(status).toBe(403);
    });
  }
});
