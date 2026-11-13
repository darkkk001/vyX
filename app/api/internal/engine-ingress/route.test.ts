import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/engine-ingress", () => ({
  engineIngressScope: () => ({ enabled: true, accounts: 1 }),
  engineIngressGatewayHost: () => "feed.example",
  engineFillsFor: (id: string) => id === "acc1",
  engineLiveRoutesFor: async (id: string) => id === "live1",
}));

afterEach(() => vi.unstubAllEnvs());

const call = async (q: string, secret?: string) => {
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "s3");
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://x/api/internal/engine-ingress${q}`, { headers: secret ? { "x-internal-secret": secret } : {} }));
};

describe("GET /api/internal/engine-ingress", () => {
  it("refuses without the internal secret", async () => {
    expect((await call("")).status).toBe(403);
    expect((await call("", "wrong")).status).toBe(403);
  });
  it("answers the running scope, and per account when asked", async () => {
    expect(await (await call("", "s3")).json()).toEqual({ enabled: true, accounts: 1, gatewayHost: "feed.example" });
    expect(await (await call("?accountId=acc1", "s3")).json()).toMatchObject({ accountId: "acc1", fillsFor: true, demoList: true, liveAllowlist: false });
    expect(await (await call("?accountId=live1", "s3")).json()).toMatchObject({ accountId: "live1", fillsFor: true, demoList: false, liveAllowlist: true });
    expect(await (await call("?accountId=nope", "s3")).json()).toMatchObject({ accountId: "nope", fillsFor: false, demoList: false, liveAllowlist: false });
  });
});
