import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertNotProductionDatabase } from "@/scripts/lib/assert-not-production.mjs";

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

type PermKey =
  | "ANY_MANAGER"
  | "BROKER_ADMIN_ONLY"
  | "ANY_ADMIN"
  | "RISK_OR_EMERGENCY"
  | "KYC_REVIEW"
  | "RISK_SETTINGS"
  | "EMERGENCY_CONTROLS"
  | "ACCOUNT_FINANCE"
  | "FUNDS_APPROVAL"
  | "INTERNAL_TRANSFERS"
  | "IB_PAYOUTS"
  | "MIRROR_MANAGE";

type PersonaKey = "readonly" | "dealer" | "finance" | "support";

const PERSONA_DEFS: Record<PersonaKey, { role: "MANAGER" | "SUPPORT"; extraPermissions: string[] }> = {
  readonly: { role: "MANAGER", extraPermissions: [] },
  dealer: { role: "MANAGER", extraPermissions: ["RISK_SETTINGS", "EMERGENCY_CONTROLS"] },
  finance: { role: "MANAGER", extraPermissions: ["ACCOUNT_FINANCE", "FUNDS_APPROVAL", "INTERNAL_TRANSFERS", "IB_PAYOUTS"] },
  support: { role: "SUPPORT", extraPermissions: [] },
};

function expectedAllowed(perm: PermKey, persona: PersonaKey): boolean {
  const def = PERSONA_DEFS[persona];
  switch (perm) {
    case "ANY_MANAGER":
      return def.role === "MANAGER";
    case "BROKER_ADMIN_ONLY":
      return false; // none of the 4 personas is BROKER_ADMIN -- deliberate, see file header
    case "ANY_ADMIN":
      return true; // any signed-in admin, SUPPORT included (theme/route.ts)
    case "RISK_OR_EMERGENCY":
      return def.role === "MANAGER" && (def.extraPermissions.includes("RISK_SETTINGS") || def.extraPermissions.includes("EMERGENCY_CONTROLS"));
    default:
      return def.role === "MANAGER" && def.extraPermissions.includes(perm);
  }
}

type Row = {
  mod: string; // relative to app/api/manage/
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  perm: PermKey;
  needsId?: boolean;
  body?: Record<string, unknown>;
};

const FAKE_ID = "cnonexistenttestid00001";

// One row per DISTINCT permission requirement found in each route.ts
// (by direct reading -- see the file header). Ordered to match
// alphabetical file layout under app/api/manage/.
const MANIFEST: Row[] = [
  { mod: "account-types/[id]/pricing/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "account-types/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "account-types/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "accounts/[id]/activity/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "accounts/[id]/adjust-balance/route", method: "POST", perm: "ACCOUNT_FINANCE", needsId: true, body: {} },
  { mod: "accounts/[id]/positions/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "accounts/[id]/pricing/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "accounts/[id]/reset-password/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "accounts/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "accounts/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "admins/[id]/route", method: "PATCH", perm: "BROKER_ADMIN_ONLY", needsId: true, body: {} },
  { mod: "admins/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "audit/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "balance-adjustment-requests/[id]/approve/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "balance-adjustment-requests/[id]/reject/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "balance-adjustment-requests/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "client-kyc-requests/[id]/document/route", method: "GET", perm: "KYC_REVIEW", needsId: true },
  { mod: "client-kyc-requests/[id]/route", method: "PATCH", perm: "KYC_REVIEW", needsId: true, body: {} },
  { mod: "client-kyc-requests/route", method: "GET", perm: "KYC_REVIEW" },
  { mod: "dashboard/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "dealing-desk-toggle/route", method: "GET", perm: "RISK_SETTINGS" },
  { mod: "dealing-desk/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "dealing-queue/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "dealing-queue/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "deals/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "feed-health/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "funds-requests/[id]/route", method: "PATCH", perm: "FUNDS_APPROVAL", needsId: true, body: {} },
  { mod: "funds-requests/route", method: "GET", perm: "FUNDS_APPROVAL" },
  { mod: "groups/[id]/halt/route", method: "PATCH", perm: "EMERGENCY_CONTROLS", needsId: true, body: {} },
  { mod: "groups/[id]/pricing/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "groups/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "groups/[id]/route", method: "DELETE", perm: "BROKER_ADMIN_ONLY", needsId: true },
  { mod: "groups/[id]/symbols/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "groups/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "ib-relationships/[id]/route", method: "PATCH", perm: "IB_PAYOUTS", needsId: true, body: {} },
  { mod: "ib-relationships/route", method: "GET", perm: "IB_PAYOUTS" },
  { mod: "kyc-requests/[id]/document/route", method: "GET", perm: "KYC_REVIEW", needsId: true },
  { mod: "kyc-requests/[id]/route", method: "PATCH", perm: "KYC_REVIEW", needsId: true, body: {} },
  { mod: "kyc-requests/route", method: "GET", perm: "KYC_REVIEW" },
  { mod: "leads/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "leads/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "liquidity-providers/[id]/route", method: "PATCH", perm: "BROKER_ADMIN_ONLY", needsId: true, body: {} },
  { mod: "liquidity-providers/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "liquidity/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "live-account-requests/[id]/route", method: "PATCH", perm: "KYC_REVIEW", needsId: true, body: {} },
  { mod: "live-account-requests/route", method: "GET", perm: "KYC_REVIEW" },
  { mod: "live-activity/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "lp-routing/[id]/route", method: "DELETE", perm: "BROKER_ADMIN_ONLY", needsId: true },
  { mod: "lp-routing/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "margin/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "mirror-rules/[id]/route", method: "GET", perm: "MIRROR_MANAGE", needsId: true },
  { mod: "mirror-rules/route", method: "GET", perm: "MIRROR_MANAGE" },
  { mod: "notifications/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "notifications/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "order-latency/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "payment-methods/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "position-action-requests/[id]/approve/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "position-action-requests/[id]/reject/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "position-action-requests/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "positions/[id]/close/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/[id]/delete/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/[id]/replay/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "positions/[id]/reverse/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/[id]/route", method: "PATCH", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/[id]/void/route", method: "POST", perm: "ANY_MANAGER", needsId: true, body: {} },
  { mod: "positions/close-bulk/route", method: "POST", perm: "ANY_MANAGER", body: {} },
  { mod: "positions/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "pricing-shadow-compare/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/client/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/financial/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/ib/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/lp/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "reports/risk/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/summary/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "reports/trading/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "risk-radar/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "risk/route", method: "GET", perm: "RISK_OR_EMERGENCY" },
  { mod: "risk/route", method: "PATCH", perm: "EMERGENCY_CONTROLS", body: { tradingHalted: true } },
  { mod: "risk/route", method: "PATCH", perm: "RISK_SETTINGS", body: { maxOpenPositionsPerAccount: 10 } },
  { mod: "search/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "settings/route", method: "GET", perm: "BROKER_ADMIN_ONLY" },
  { mod: "shell-info/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "symbols/[id]/sessions/route", method: "GET", perm: "ANY_MANAGER", needsId: true },
  { mod: "symbols/route", method: "GET", perm: "ANY_MANAGER" },
  { mod: "theme/route", method: "PATCH", perm: "ANY_ADMIN", body: { theme: "dark" } },
  { mod: "transfers/route", method: "GET", perm: "INTERNAL_TRANSFERS" },
];

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
      const allowed = expectedAllowed(row.perm, persona);
      const label = `${row.method} ${row.mod} [${row.perm}] -- ${persona} should be ${allowed ? "let through" : "blocked (403)"}`;
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
