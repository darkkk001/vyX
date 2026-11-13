// Live cutover (owner 2026-11-13): a LIVE account routes to the engine when the live allowlist switches it on (broker
// flag + account toggle). The read behind it, proved fail-closed: no gateway URL = no read and no route, a failed read =
// no route (and not cached), a DEMO-list account never reads, and the per-instance set is re-read after its TTL.

import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { account: { findMany: db.findMany } } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));

const DEMO = "cmdemoonthelist000000001";
const LIVE = "cmliveallowlisted0000001";
const row = (id: string, over: Partial<{ accountMode: string; engineLiveEnabled: boolean; flag: boolean }> = {}) => ({
  id,
  accountMode: over.accountMode ?? "LIVE",
  engineLiveEnabled: over.engineLiveEnabled ?? true,
  broker: { engineLiveAllowlistOn: over.flag ?? true },
});

async function load(env: { ids?: string; url?: string }) {
  vi.resetModules();
  if (env.ids === undefined) delete process.env.ENGINE_INGRESS_ACCOUNT_IDS;
  else process.env.ENGINE_INGRESS_ACCOUNT_IDS = env.ids;
  if (env.url === undefined) delete process.env.ENGINE_INGRESS_GATEWAY_URL;
  else process.env.ENGINE_INGRESS_GATEWAY_URL = env.url;
  return import("./engine-ingress");
}

afterEach(() => {
  db.findMany.mockReset();
  vi.useRealTimers();
  delete process.env.ENGINE_INGRESS_ACCOUNT_IDS;
  delete process.env.ENGINE_INGRESS_GATEWAY_URL;
});

describe("engineRoutesFor: the DEMO ingress list OR the live allowlist", () => {
  it("the read asks exactly the rule: LIVE + account toggle + broker flag", async () => {
    const m = await load({ url: "https://feed.example" });
    db.findMany.mockResolvedValue([row(LIVE)]);
    expect(await m.engineRoutesFor(LIVE)).toBe(true);
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountMode: "LIVE", engineLiveEnabled: true, broker: { engineLiveAllowlistOn: true } } })
    );
  });

  it("the shared rule re-checks every row: a row that does not meet it never routes, whatever the query returned", async () => {
    const m = await load({ url: "https://feed.example" });
    db.findMany.mockResolvedValue([
      row("a-demo", { accountMode: "DEMO" }),
      row("a-off", { engineLiveEnabled: false }),
      row("a-flagoff", { flag: false }),
      row(LIVE),
    ]);
    for (const id of ["a-demo", "a-off", "a-flagoff"]) expect(await m.engineRoutesFor(id)).toBe(false);
    expect(await m.engineRoutesFor(LIVE)).toBe(true);
  });

  it("no gateway URL: nothing routes and nothing is read", async () => {
    const m = await load({ ids: DEMO });
    db.findMany.mockResolvedValue([row(LIVE)]);
    expect(await m.engineRoutesFor(LIVE)).toBe(false);
    expect(await m.engineRoutesFor(DEMO)).toBe(false);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("a DEMO-list account routes as before, with no read", async () => {
    const m = await load({ ids: DEMO, url: "https://feed.example" });
    expect(await m.engineRoutesFor(DEMO)).toBe(true);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("a failed read: fail closed, nothing cached, the next request reads again", async () => {
    const m = await load({ url: "https://feed.example" });
    db.findMany.mockRejectedValueOnce(new Error("db down")).mockResolvedValue([row(LIVE)]);
    expect(await m.engineRoutesFor(LIVE)).toBe(false);
    expect(await m.engineRoutesFor(LIVE)).toBe(true);
    expect(db.findMany).toHaveBeenCalledTimes(2);
  });

  it("one read per TTL per instance; concurrent requests share it; a toggle shows after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    const m = await load({ url: "https://feed.example" });
    db.findMany.mockResolvedValue([row(LIVE)]);
    const answers = await Promise.all([m.engineRoutesFor(LIVE), m.engineRoutesFor(LIVE), m.engineRoutesFor("other")]);
    expect(answers).toEqual([true, true, false]);
    expect(db.findMany).toHaveBeenCalledTimes(1);

    db.findMany.mockResolvedValue([]); // switched off
    vi.setSystemTime(Date.now() + m.LIVE_SET_TTL_MS - 1);
    expect(await m.engineRoutesFor(LIVE)).toBe(true); // still inside the window (the gateway re-checks: 403 = web path)
    vi.setSystemTime(Date.now() + 2);
    expect(await m.engineRoutesFor(LIVE)).toBe(false);
    expect(db.findMany).toHaveBeenCalledTimes(2);
  });

  it("nothing switched on (today): no account routes through the live allowlist", async () => {
    const m = await load({ url: "https://feed.example" });
    db.findMany.mockResolvedValue([]);
    expect(await m.engineLiveRoutesFor(LIVE)).toBe(false);
    expect(await m.engineRoutesFor("")).toBe(false);
  });
});
