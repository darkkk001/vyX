import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findMany: vi.fn(async ({ where }: { where: Record<string, string> }) =>
        where.groupId === "g-big" ? Array.from({ length: 45 }, (_, i) => ({ id: `acc${i}` })) : []
      ),
    },
  },
}));

import { fanOutAccountUpdated, publishAccountUpdated, publishAccountsUpdatedAfterResponse } from "@/lib/account-events";
import { prisma } from "@/lib/prisma";

function captureGateway() {
  const sent: { subject?: string; payload?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 202 });
  });
  return sent;
}

// 2026-09-24: backoffice changes to an account's terms (leverage, status, group, pricing, allowed symbols, halt)
// published nothing, so an open terminal kept the old terms until something else made it refetch.
describe("AccountUpdated", () => {
  afterEach(() => vi.restoreAllMocks());

  it("goes to the gateway as account.updated, scoped by account_id, carrying the reason", async () => {
    const sent = captureGateway();
    await publishAccountUpdated("b1", "acc1", "account");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("account.updated");
    expect(sent[0].payload).toMatchObject({ type: "AccountUpdated", account_id: "acc1", broker_id: "b1", reason: "account" });
  });

  it("a group change reaches every account in the group, scoped to the broker", async () => {
    const sent = captureGateway();
    const n = await fanOutAccountUpdated("b1", { groupId: "g-big" }, "group_pricing");
    expect(n).toBe(45);
    expect(sent).toHaveLength(45);
    expect(new Set(sent.map((s) => s.payload?.account_id)).size).toBe(45);
    expect(sent.every((s) => s.subject === "account.updated" && s.payload?.reason === "group_pricing")).toBe(true);
    expect(vi.mocked(prisma.account.findMany)).toHaveBeenCalledWith({ where: { brokerId: "b1", groupId: "g-big" }, select: { id: true } });
  });

  it("outside a request scope the fan-out still runs (no next/server after() context)", async () => {
    const sent = captureGateway();
    publishAccountsUpdatedAfterResponse("b1", { groupId: "g-big" }, "group");
    await vi.waitFor(() => expect(sent).toHaveLength(45));
  });

  it("a gateway that is down never throws into the backoffice save", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(publishAccountUpdated("b1", "acc1", "account")).resolves.toBeUndefined();
  });

  it("every backoffice route that changes an account's terms publishes it", () => {
    const routes: [string, RegExp][] = [
      ["app/api/manage/accounts/[id]/route.ts", /publishAccountUpdated\(brokerId, id, "account"\)/],
      ["app/api/manage/accounts/[id]/pricing/route.ts", /publishAccountUpdated\(brokerId, id, "account_pricing"\)/],
      ["app/api/manage/groups/[id]/route.ts", /publishAccountsUpdatedAfterResponse\(brokerId, \{ groupId: id \}, "group"\)/],
      ["app/api/manage/groups/[id]/pricing/route.ts", /publishAccountsUpdatedAfterResponse\(brokerId, \{ groupId: id \}, "group_pricing"\)/],
      ["app/api/manage/groups/[id]/symbols/route.ts", /publishAccountsUpdatedAfterResponse\(brokerId, \{ groupId: id \}, "group_symbols"\)/],
      ["app/api/manage/groups/[id]/halt/route.ts", /publishAccountsUpdatedAfterResponse\(brokerId, \{ groupId: id \}, "group_halt"\)/],
      ["app/api/manage/account-types/[id]/route.ts", /publishAccountsUpdatedAfterResponse\(brokerId, \{ accountTypeId: id \}, "account_type"\)/],
      ["app/api/manage/account-types/[id]/pricing/route.ts", /publishAccountsUpdatedAfterResponse\(brokerId, \{ accountTypeId: id \}, "account_type_pricing"\)/],
    ];
    for (const [file, re] of routes) {
      const src = readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
      // the pricing routes publish on BOTH the reset and the upsert branch
      // account-types/[id] also publishes from its enabled-only Enable/Disable path (Phase 2 batch 1)
      const expected = file.endsWith("pricing/route.ts") || file.endsWith("account-types/[id]/route.ts") ? 2 : 1;
      expect(src.match(new RegExp(re.source, "g"))?.length ?? 0, file).toBe(expected);
    }
  });
});
