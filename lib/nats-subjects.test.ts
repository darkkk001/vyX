import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishTradingEvent } from "@/lib/nats";

// 2026-09-24: BalanceChanged was published with no subject (the map had no entry and the type accepted any string),
// so the gateway answered 400 and no terminal ever heard of a backoffice deposit / withdrawal / adjustment.
describe("lib/nats.ts trading event subjects", () => {
  afterEach(() => vi.restoreAllMocks());

  it("BalanceChanged goes to the gateway with subject account.balance", async () => {
    const sent: { subject?: string; payload?: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });
    await publishTradingEvent("BalanceChanged", { account_id: "acc1", broker_id: "b1", transaction_id: "t1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("account.balance");
    expect(sent[0].payload).toMatchObject({ type: "BalanceChanged", account_id: "acc1", broker_id: "b1" });
  });

  it("the gateway's TRADER stream subscribes account.> (so the event reaches that account's terminal)", () => {
    const ws = readFileSync(path.resolve(import.meta.dirname, "..", "services", "api-gateway", "src", "ws.ts"), "utf8");
    const trader = ws.slice(ws.indexOf("export async function attachTradingEventStream"), ws.indexOf("export async function attachAdminEventStream"));
    expect(trader).toContain('nc.subscribe("account.>")');
  });

  it("every backoffice route that moves a balance publishes BalanceChanged", () => {
    for (const file of [
      "app/api/manage/accounts/[id]/adjust-balance/route.ts",
      "app/api/manage/balance-adjustment-requests/[id]/approve/route.ts",
      "app/api/manage/funds-requests/[id]/route.ts",
      "app/api/manage/transfers/route.ts",
      "app/api/manage/ib-relationships/[id]/route.ts",
    ]) {
      expect(readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8"), file).toMatch(/publishTradingEvent\("BalanceChanged"/);
    }
  });
});
