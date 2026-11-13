import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Engine = { id: string; status: string; staleAfterSecs: number };
let engines: Engine[];
let updates: { id: string; lastBeatAt: Date; lastBeatVersion?: string }[];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    engine: {
      findUnique: async ({ where }: { where: { id: string } }) => engines.find((e) => e.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { lastBeatAt: Date; lastBeatVersion?: string } }) => {
        updates.push({ id: where.id, ...data });
        return {};
      },
    },
  },
}));

beforeEach(() => {
  engines = [{ id: "eu-fr-1", status: "ACTIVE", staleAfterSecs: 30 }];
  updates = [];
});
afterEach(() => vi.unstubAllEnvs());

const post = async (body: unknown, secret = "s3") => {
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "s3");
  const { POST } = await import("./route");
  return POST(
    new NextRequest("http://x/api/internal/engine-status", {
      method: "POST",
      headers: { "x-internal-secret": secret, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
};

describe("POST /api/internal/engine-status", () => {
  it("refuses without the internal secret, and writes nothing", async () => {
    expect((await post({ engineId: "eu-fr-1" }, "wrong")).status).toBe(403);
    expect(updates).toEqual([]);
  });

  it("refuses an unknown engine with 404 and writes nothing", async () => {
    // a typo in ENGINE_ID must look like an engine nobody registered, not a healthy one
    expect((await post({ engineId: "eu-xx-7" })).status).toBe(404);
    expect(updates).toEqual([]);
  });

  it("writes lastBeatAt for the engine -- the row the web's owner rule reads", async () => {
    const before = Date.now();
    const res = await post({ engineId: "eu-fr-1", version: "1.2.3" });
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("eu-fr-1");
    expect(updates[0].lastBeatVersion).toBe("1.2.3");
    expect(updates[0].lastBeatAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updates[0].lastBeatAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("the answer carries the current status, so a console flip acts within one beat", async () => {
    engines[0].status = "RETIRED";
    expect(await (await post({ engineId: "eu-fr-1" })).json()).toMatchObject({ status: "RETIRED", staleAfterSecs: 30 });
  });

  it("RELEASING pushes the beat past staleness instead of refreshing it", async () => {
    // Standing down on purpose: the web must own the brokers at once, not after staleAfterSecs, or
    // neither side considers itself the owner in between.
    const res = await post({ engineId: "eu-fr-1", releasing: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ releasing: true });
    const age = Date.now() - updates[0].lastBeatAt.getTime();
    expect(age).toBeGreaterThan(30 * 1000, "the beat must already be stale by the engine's own staleAfterSecs");
  });

  it("a normal beat is never stale on arrival", async () => {
    await post({ engineId: "eu-fr-1" });
    expect(Date.now() - updates[0].lastBeatAt.getTime()).toBeLessThan(5 * 1000);
  });

  it("refuses a body that is not JSON, and an invalid engine id", async () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "s3");
    const { POST } = await import("./route");
    const bad = await POST(
      new NextRequest("http://x/api/internal/engine-status", { method: "POST", headers: { "x-internal-secret": "s3" }, body: "not json" })
    );
    expect(bad.status).toBe(400);
    expect((await post({ engineId: "NOT VALID" })).status).toBe(400);
    expect(updates).toEqual([]);
  });
});
