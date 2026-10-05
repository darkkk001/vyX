// GET /api/manage/badges (2026-10-05): every backoffice badge count in one cheap request. Proven here against the
// real handlers on the per-file scratch DB:
//   1. each count equals what the native backoffice used to count from the old list endpoints (same seeded data,
//      counted the way MainWindow.RefreshBadgesAsync / DealingScreen counted them);
//   2. null exactly for the screens shell-info's `screens` leaves out (BROKER_ADMIN, MANAGER with and without the
//      delegated permissions, SUPPORT);
//   3. broker isolation: another broker's queue never shows up, and its own counts are its own.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...real,
    getAdminSession: vi.fn(),
    requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
  };
});

import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { assertNotProductionDatabase } from "@/scripts/lib/assert-not-production.mjs";
import { GET as badgesGET } from "@/app/api/manage/badges/route";
import { GET as shellInfoGET } from "@/app/api/manage/shell-info/route";
import { GET as dealingQueueGET } from "@/app/api/manage/dealing-queue/route";
import { GET as kycGET } from "@/app/api/manage/kyc-requests/route";
import { GET as clientKycGET } from "@/app/api/manage/client-kyc-requests/route";
import { GET as larGET } from "@/app/api/manage/live-account-requests/route";
import { GET as fundsGET } from "@/app/api/manage/funds-requests/route";
import { GET as radarGET } from "@/app/api/manage/risk-radar/route";
import { GET as balGET } from "@/app/api/manage/balance-adjustment-requests/route";
import { GET as pactGET } from "@/app/api/manage/position-action-requests/route";

const D = (v: number | string) => new Prisma.Decimal(v);
const sfx = randomUUID().replace(/-/g, "").slice(0, 8);
type Role = "BROKER_ADMIN" | "MANAGER" | "SUPPORT";
type Badges = { deal: number | null; apr: number | null; rdr: number | null; kyc: number | null; lar: number | null; dep: number | null; unread: number; computedAt: string };

let seq = 0;
let symbolId = "";

type Fixture = {
  brokerId: string;
  admins: Record<"owner" | "plain" | "delegated" | "support", string>;
};
let A: Fixture;
let B: Fixture;

function as(f: Fixture, who: keyof Fixture["admins"], role: Role) {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: f.admins[who], brokerId: f.brokerId, role } as never);
}
async function badges(f: Fixture, who: keyof Fixture["admins"], role: Role): Promise<{ status: number; body: Badges }> {
  as(f, who, role);
  const res = await badgesGET();
  return { status: res.status, body: (await res.json()) as Badges };
}
const req = (path: string) => new Request(`http://localhost${path}`);

// Seeds one broker. `n` scales every queue so two brokers have different counts (n = 1 or 2).
async function seedBroker(tag: string, n: number): Promise<Fixture> {
  const broker = await prisma.broker.create({ data: { name: `Badges ${tag} ${sfx}`, subdomain: `badges-${tag}-${sfx}` } });
  const brokerId = broker.id;
  const group = await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } });
  await prisma.brokerSymbol.create({ data: { brokerId, symbolId } });
  const mkAdmin = (k: string, role: Role, extraPermissions: string[] = []) =>
    prisma.adminUser.create({ data: { brokerId, email: `badges-${tag}-${k}-${sfx}@test.local`, passwordHash: "x", role, status: "ACTIVE", twoFactorEnabled: true, extraPermissions } });
  const owner = await mkAdmin("owner", "BROKER_ADMIN");
  const plain = await mkAdmin("plain", "MANAGER");
  const delegated = await mkAdmin("delegated", "MANAGER", ["KYC_REVIEW", "FUNDS_APPROVAL"]);
  const support = await mkAdmin("support", "SUPPORT");

  const mkAccount = () => {
    seq++;
    return prisma.account.create({
      data: { brokerId, accountNumber: `5${Date.now() % 1_000_000}${seq}`, email: `badges-${tag}-${seq}-${sfx}@x.local`, passwordHash: "x", fullName: `acc ${seq}`, accountMode: "DEMO", groupId: group.id, leverage: 100, balance: D(10_000) },
    });
  };
  const a1 = await mkAccount();
  const a2 = await mkAccount();
  const order = (accountId: string, type: "MARKET" | "LIMIT", status: "PENDING" | "REQUOTED" | "FILLED") =>
    prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type, volume: D(1), status, idempotencyKey: `bdg-${++seq}-${sfx}`, requestedPrice: type === "LIMIT" ? D(90) : null } });

  for (let i = 0; i < n; i++) {
    // DEAL: PENDING MARKET counts; requoted / pending LIMIT / filled do not
    await order(a1.id, "MARKET", "PENDING");
    await order(a2.id, "MARKET", "PENDING");
    await order(a1.id, "MARKET", "REQUOTED");
    await order(a1.id, "LIMIT", "PENDING");
    await order(a1.id, "MARKET", "FILLED");
    // APR: balance adjustments + position actions, PENDING only
    await prisma.balanceAdjustmentRequest.create({ data: { brokerId, accountId: a1.id, amount: D(10), note: "n", requestedByAdminId: plain.id } });
    await prisma.balanceAdjustmentRequest.create({ data: { brokerId, accountId: a1.id, amount: D(10), note: "n", requestedByAdminId: plain.id, status: "REJECTED" } });
    const filled = await order(a1.id, "MARKET", "FILLED");
    const pos = await prisma.position.create({ data: { brokerId, accountId: a1.id, symbolId, originOrderId: filled.id, side: "BUY", volume: D(1), openPrice: D(100) } });
    await prisma.positionActionRequest.create({ data: { brokerId, positionId: pos.id, actionType: "VOID", requestedByAdminId: plain.id } });
    await prisma.positionActionRequest.create({ data: { brokerId, positionId: pos.id, actionType: "DELETE", requestedByAdminId: plain.id, status: "APPROVED" } });
    // DEP: PENDING deposits + withdrawals; a COMPLETED one and a PENDING credit do not count
    const tx = (type: "DEPOSIT" | "WITHDRAWAL" | "CREDIT", status: "PENDING" | "COMPLETED") =>
      prisma.transaction.create({ data: { brokerId, accountId: a1.id, type, status, amount: D(100), balanceBefore: D(0), balanceAfter: D(0) } });
    await tx("DEPOSIT", "PENDING");
    await tx("WITHDRAWAL", "PENDING");
    await tx("DEPOSIT", "COMPLETED");
    await tx("CREDIT", "PENDING");
  }
  // KYC: one PENDING account record (+ one approved), one PENDING client record per n (+ one rejected)
  await prisma.kycRecord.create({ data: { accountId: a1.id, documentType: "passport", documentFrontUrl: "x" } });
  await prisma.kycRecord.create({ data: { accountId: a2.id, documentType: "passport", documentFrontUrl: "x", status: "APPROVED" } });
  for (let i = 0; i < n + 1; i++) {
    seq++;
    const c = await prisma.client.create({ data: { brokerId, email: `client-${tag}-${seq}-${sfx}@x.local`, passwordHash: "x", fullName: `client ${seq}` } });
    const pending = i < n;
    await prisma.clientKycRecord.create({ data: { clientId: c.id, documentType: "passport", documentFrontUrl: "x", status: pending ? "PENDING" : "REJECTED" } });
    // LAR: PENDING per n, one APPROVED
    await prisma.liveAccountRequest.create({ data: { brokerId, clientId: c.id, status: pending ? "PENDING" : "APPROVED" } });
  }
  // RDR: a1 scalps (closed positions held 30 s) and shares an IP with a2 (different emails): 1 flagged row + 1 cluster
  for (let i = 0; i < 2; i++) {
    const filled = await order(a1.id, "MARKET", "FILLED");
    const openedAt = new Date(Date.now() - 60 * 60_000);
    await prisma.position.create({
      data: { brokerId, accountId: a1.id, symbolId, originOrderId: filled.id, side: "BUY", volume: D(1), openPrice: D(100), status: "CLOSED", openedAt, closedAt: new Date(openedAt.getTime() + 30_000), closePrice: D(101), realizedPnl: D(1) },
    });
  }
  await prisma.loginEvent.create({ data: { brokerId, accountId: a1.id, ipAddress: `10.0.0.${n}` } });
  await prisma.loginEvent.create({ data: { brokerId, accountId: a2.id, ipAddress: `10.0.0.${n}` } });
  // unread: staff rows (accountId null), unread; one read by the owner only (NotificationRead), one read for all
  // (readAt), and a trader-facing copy that is never a staff notification
  const note = (data: Partial<Prisma.NotificationUncheckedCreateInput> = {}) => prisma.notification.create({ data: { brokerId, type: "FUNDS_REQUEST", title: "t", body: "b", ...data } });
  for (let i = 0; i < n + 1; i++) await note();
  const readByOwner = await note();
  await prisma.notificationRead.create({ data: { notificationId: readByOwner.id, adminId: owner.id } });
  await note({ readAt: new Date() });
  await note({ accountId: a1.id, type: "MARGIN_CALL" });

  return { brokerId, admins: { owner: owner.id, plain: plain.id, delegated: delegated.id, support: support.id } };
}

beforeAll(async () => {
  await assertNotProductionDatabase(prisma);
  const sym = await prisma.symbol.upsert({ where: { name: "ZBADGES" }, update: {}, create: { name: "ZBADGES", baseCurrency: "ZBG", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbolId = sym.id;
  A = await seedBroker("a", 2);
  B = await seedBroker("b", 1);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// The old way: the nine list endpoints, counted exactly as the backoffice counted them.
async function oldCounts(f: Fixture) {
  as(f, "owner", "BROKER_ADMIN");
  const json = async (r: Response) => {
    expect(r.status).toBe(200);
    return r.json();
  };
  const pending = (rows: { status: string }[]) => rows.filter((r) => r.status === "PENDING").length;
  const dq = await json(await dealingQueueGET());
  const radar = await json(await radarGET());
  const flagged = (radar.rows as { scalpFlag: boolean; martingaleFlag: boolean; latencyArbFlag: boolean; newsTraderFlag: boolean }[]).filter((r) => r.scalpFlag || r.martingaleFlag || r.latencyArbFlag || r.newsTraderFlag).length;
  const shell = await json(await shellInfoGET());
  return {
    deal: dq.rows.length,
    apr: pending(await json(await balGET(req("/api/manage/balance-adjustment-requests")))) + pending(await json(await pactGET(req("/api/manage/position-action-requests")))),
    rdr: flagged + radar.sameIpClusters.length,
    kyc: pending(await json(await kycGET())) + pending(await json(await clientKycGET())),
    lar: pending(await json(await larGET())),
    dep: pending((await json(await fundsGET())).rows),
    unread: shell.unreadNotifications as number,
  };
}

describe("GET /api/manage/badges", () => {
  it("BROKER_ADMIN: every count equals what the old list endpoints gave the backoffice", async () => {
    const { status, body } = await badges(A, "owner", "BROKER_ADMIN");
    expect(status).toBe(200);
    const { computedAt, ...counts } = body;
    expect(new Date(computedAt).toISOString()).toBe(computedAt);
    expect(counts).toEqual(await oldCounts(A));
    // and the seeded numbers themselves (n = 2): pending MARKET 4, APR 2 + 2, RDR 1 flagged + 1 cluster, KYC 1 + 2,
    // LAR 2, DEP 2 deposits + 2 withdrawals, unread 3 staff rows (one more is read by this owner)
    expect(counts).toEqual({ deal: 4, apr: 4, rdr: 2, kyc: 3, lar: 2, dep: 4, unread: 3 });
  });

  it("the second broker sees only its own queues (broker isolation)", async () => {
    const { body } = await badges(B, "owner", "BROKER_ADMIN");
    const { computedAt, ...counts } = body;
    expect(typeof computedAt).toBe("string");
    expect(counts).toEqual(await oldCounts(B));
    expect(counts).toEqual({ deal: 2, apr: 2, rdr: 2, kyc: 2, lar: 1, dep: 2, unread: 2 });
  });

  it("unread is per staff member (NotificationRead), exactly like shell-info", async () => {
    const owner = (await badges(A, "owner", "BROKER_ADMIN")).body.unread;
    const plain = (await badges(A, "plain", "MANAGER")).body.unread;
    expect(plain).toBe(owner + 1);
    as(A, "plain", "MANAGER");
    expect((await (await shellInfoGET()).json()).unreadNotifications).toBe(plain);
  });

  it("MANAGER without delegated permissions: DEAL / APR / RDR counted, KYC / LAR / DEP null", async () => {
    const { status, body } = await badges(A, "plain", "MANAGER");
    expect(status).toBe(200);
    expect(body).toMatchObject({ deal: 4, apr: 4, rdr: 2, kyc: null, lar: null, dep: null, unread: 4 });
  });

  it("MANAGER with KYC_REVIEW + FUNDS_APPROVAL: every badge counted", async () => {
    const { body } = await badges(A, "delegated", "MANAGER");
    expect(body).toMatchObject({ deal: 4, apr: 4, rdr: 2, kyc: 3, lar: 2, dep: 4 });
  });

  it("a permission revoked takes effect on the next call (read fresh, not from the session)", async () => {
    await prisma.adminUser.update({ where: { id: A.admins.delegated }, data: { extraPermissions: ["KYC_REVIEW"] } });
    try {
      const { body } = await badges(A, "delegated", "MANAGER");
      expect(body).toMatchObject({ kyc: 3, lar: 2, dep: null });
    } finally {
      await prisma.adminUser.update({ where: { id: A.admins.delegated }, data: { extraPermissions: ["KYC_REVIEW", "FUNDS_APPROVAL"] } });
    }
  });

  it("SUPPORT (read-only): KYC and DEP counted, DEAL / APR / RDR / LAR null", async () => {
    const { status, body } = await badges(A, "support", "SUPPORT");
    expect(status).toBe(200);
    expect(body).toMatchObject({ deal: null, apr: null, rdr: null, kyc: 3, lar: null, dep: 4, unread: 4 });
  });

  it("null exactly for the badge screens shell-info's `screens` leaves out, for every persona", async () => {
    const codes = { deal: "DEAL", apr: "APR", rdr: "RDR", kyc: "KYC", lar: "LAR", dep: "DEP" } as const;
    for (const [who, role] of [["owner", "BROKER_ADMIN"], ["plain", "MANAGER"], ["delegated", "MANAGER"], ["support", "SUPPORT"]] as const) {
      as(A, who, role);
      const screens = (await (await shellInfoGET()).json()).screens as string[];
      const { body } = await badges(A, who, role);
      for (const [k, code] of Object.entries(codes)) {
        expect([who, k, body[k as keyof typeof codes] === null]).toEqual([who, k, !screens.includes(code)]);
      }
    }
  });

  it("no session, or a role outside broker staff, is refused", async () => {
    vi.mocked(getAdminSession).mockResolvedValue(null);
    expect((await badgesGET()).status).toBe(403);
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: A.admins.owner, brokerId: null, role: "SUPER_ADMIN" } as never);
    expect((await badgesGET()).status).toBe(403);
  });

  it("a queue change shows on the next call (counts are live; only RDR is cached, 5 min)", async () => {
    const before = (await badges(A, "owner", "BROKER_ADMIN")).body;
    const acc = await prisma.account.findFirstOrThrow({ where: { brokerId: A.brokerId } });
    await prisma.transaction.create({ data: { brokerId: A.brokerId, accountId: acc.id, type: "DEPOSIT", amount: D(5), balanceBefore: D(0), balanceAfter: D(0) } });
    await prisma.order.create({ data: { brokerId: A.brokerId, accountId: acc.id, symbolId, side: "SELL", type: "MARKET", volume: D(1), status: "PENDING", idempotencyKey: `bdg-late-${sfx}` } });
    const after = (await badges(A, "owner", "BROKER_ADMIN")).body;
    expect(after.dep).toBe(before.dep! + 1);
    expect(after.deal).toBe(before.deal! + 1);
    // the other broker is untouched
    expect((await badges(B, "owner", "BROKER_ADMIN")).body).toMatchObject({ deal: 2, dep: 2 });
  });
});
