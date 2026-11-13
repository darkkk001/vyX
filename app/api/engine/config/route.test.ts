import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Engine = { id: string; name: string; region: string; gatewayUrl: string; status: string; staleAfterSecs: number };
let engines: Engine[];
let scope: Record<string, string[]>;
let scopeCalls: string[];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    engine: {
      findUnique: async ({ where }: { where: { id: string } }) => engines.find((e) => e.id === where.id) ?? null,
    },
  },
}));
vi.mock("@/lib/engine-registry", async (orig) => ({
  ...(await orig<typeof import("@/lib/engine-registry")>()),
  servedBrokerIds: async (_db: unknown, engineId: string) => {
    scopeCalls.push(engineId);
    return scope[engineId] ?? [];
  },
}));

beforeEach(() => {
  engines = [
    { id: "eu-fr-1", name: "France 1", region: "Europe (France)", gatewayUrl: "https://feed.example", status: "ACTIVE", staleAfterSecs: 30 },
    { id: "eu-fr-9", name: "Retired", region: "Europe (France)", gatewayUrl: "https://feed.example", status: "RETIRED", staleAfterSecs: 30 },
  ];
  scope = { "eu-fr-1": ["b1", "b2"], "eu-fr-9": [] };
  scopeCalls = [];
});
afterEach(() => vi.unstubAllEnvs());

const call = async (q: string, secret?: string) => {
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "s3");
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://x/api/engine/config${q}`, { headers: secret ? { "x-internal-secret": secret } : {} }));
};

describe("GET /api/engine/config", () => {
  it("refuses without the internal secret", async () => {
    expect((await call("?engineId=eu-fr-1")).status).toBe(403);
    expect((await call("?engineId=eu-fr-1", "wrong")).status).toBe(403);
    expect(scopeCalls).toEqual([]);
  });

  it("refuses an engineId that is not a valid id, before touching the database", async () => {
    expect((await call("?engineId=", "s3")).status).toBe(400);
    expect((await call("?engineId=NOT VALID", "s3")).status).toBe(400);
    expect(scopeCalls).toEqual([]);
  });

  it("answers an unknown engine with 404, not an empty assignment", async () => {
    // A typo in ENGINE_ID must not read as "serve nothing, all is well".
    const res = await call("?engineId=eu-xx-7", "s3");
    expect(res.status).toBe(404);
    expect(scopeCalls).toEqual([]);
  });

  it("serves the assignment the view gives for THIS engine id", async () => {
    const res = await call("?engineId=eu-fr-1", "s3");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      engineId: "eu-fr-1",
      region: "Europe (France)",
      status: "ACTIVE",
      staleAfterSecs: 30,
      assignedBrokers: ["b1", "b2"],
    });
    expect(scopeCalls).toEqual(["eu-fr-1"], "the engine id it was asked about, and only that one");
  });

  it("a RETIRED engine gets an empty assignment, because the view lists only ACTIVE and DRAINING", async () => {
    const res = await call("?engineId=eu-fr-9", "s3");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "RETIRED", assignedBrokers: [] });
  });

  it("takes the engine id from the header too, so the pull need not put it in the query", async () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "s3");
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://x/api/engine/config", { headers: { "x-internal-secret": "s3", "x-engine-id": "eu-fr-1" } })
    );
    expect(await res.json()).toMatchObject({ engineId: "eu-fr-1", assignedBrokers: ["b1", "b2"] });
  });
});
