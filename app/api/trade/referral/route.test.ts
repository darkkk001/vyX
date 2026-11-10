import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("server-only", () => ({}));

// Owner 2026-11-10: the share card's referral code is the partner portal's own code, read only, partners only.
const s = Date.now().toString(36);
let brokerId = "", groupId = "", n = 0;
async function account(opts: { partner: boolean; code: string | null; client?: boolean }) {
  n++;
  const c = opts.client === false ? null : await prisma.client.create({ data: { brokerId, email: `rf-${n}-${s}@t.local`, passwordHash: "x", fullName: "Rf Test", referralCode: opts.code } });
  const a = await prisma.account.create({ data: { brokerId, clientId: c?.id ?? null, accountNumber: `8${Date.now() % 1_000_000}${n}`, email: `rfa-${n}-${s}@t.local`, passwordHash: "x", fullName: "Rf Test", accountMode: "LIVE", groupId, leverage: 100 } });
  if (c && opts.partner) await prisma.client.update({ where: { id: c.id }, data: { partnerAccountId: a.id } });
  return a;
}
async function call(accountId: string) {
  vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId } as never);
  const { GET } = await import("./route");
  return (await GET(new NextRequest("https://futurixglobal.vyxtrader.com/api/trade/referral"))).json();
}

beforeAll(async () => {
  brokerId = (await prisma.broker.create({ data: { name: `Rf ${s}`, subdomain: `rf-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe("GET /api/trade/referral", () => {
  it("a partner with a code gets the code, its /r/ link and a QR", async () => {
    const code = `HA${s.slice(-4).toUpperCase()}`;
    const r = await call((await account({ partner: true, code })).id);
    expect(r.code).toBe(code);
    expect(r.link).toMatch(new RegExp(`^https?://[^/]+/r/${code}$`));   // the origin is lib/request-origin (the same as the Room partner page)
    expect(r.qr).toMatch(/^data:image\/png;base64,/);
  });
  it("not a partner, no code yet, or no client: no code, and none is created", async () => {
    const notPartner = await account({ partner: false, code: `NP${s.slice(-4).toUpperCase()}` });
    expect(await call(notPartner.id)).toEqual({ code: null });
    const noCode = await account({ partner: true, code: null });
    expect(await call(noCode.id)).toEqual({ code: null });
    const cl = await prisma.account.findUnique({ where: { id: noCode.id }, select: { client: { select: { referralCode: true } } } });
    expect(cl?.client?.referralCode).toBeNull();
    expect(await call((await account({ partner: false, code: null, client: false })).id)).toEqual({ code: null });
  });
});
