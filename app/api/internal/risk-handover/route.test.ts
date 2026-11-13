import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The two things this route is made of: what the engine's heartbeat says, and the web's own pass.
let heartbeat: { present: boolean; alive: boolean; ageSecs: number | null; staleAfterSecs: number | null; engineVersion: string | null; instance: string | null } | Error;
let passes: string[];

vi.mock("@/lib/risk-fallback", () => ({
  readEngineHeartbeat: async () => {
    if (heartbeat instanceof Error) throw heartbeat;
    return heartbeat;
  },
}));
vi.mock("@/lib/margin-pass", () => ({
  runFullMarginPass: async (trigger: string) => {
    passes.push(trigger);
    return { accountsEvaluated: 7, errors: 0 };
  },
}));

const alive = { present: true, alive: true, ageSecs: 3, staleAfterSecs: 30, engineVersion: "e1", instance: "i1" };
const released = { present: true, alive: false, ageSecs: 95, staleAfterSecs: 30, engineVersion: "e1", instance: "i1" };

beforeEach(() => {
  heartbeat = released;
  passes = [];
});
afterEach(() => vi.unstubAllEnvs());

const call = async (secret?: string) => {
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "s3");
  const { GET } = await import("./route");
  return GET(
    new NextRequest("http://x/api/internal/risk-handover", {
      headers: { ...(secret ? { "x-internal-secret": secret } : {}), "x-engine-id": "frankfurt-1" },
    })
  );
};

describe("GET /api/internal/risk-handover", () => {
  it("refuses without the internal secret", async () => {
    expect((await call()).status).toBe(403);
    expect((await call("wrong")).status).toBe(403);
    expect(passes).toEqual([]);
  });

  it("REFUSES TO CONFIRM while the engine is still beating, and runs no pass", async () => {
    // The check that makes the answer mean something: confirming here would leave both sides believing
    // they own the same accounts.
    heartbeat = alive;
    const res = await call("s3");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tookOver: false, ageSecs: 3 });
    expect(passes).toEqual([]);
  });

  it("takes over once the engine has released, and proves it by running the pass", async () => {
    const res = await call("s3");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tookOver: true, accountsEvaluated: 7, errors: 0, ageSecs: 95 });
    expect(passes).toEqual(["engine-handover"]);
  });

  it("does not claim a takeover it cannot stand behind when the database is unreadable", async () => {
    // Unreadable is not "stale": the web cannot own accounts it cannot read, and the engine must keep
    // acting. 503 so the engine logs a problem rather than a plain no.
    heartbeat = new Error("neon down");
    const res = await call("s3");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ tookOver: false });
    expect(passes).toEqual([]);
  });

  it("never answers tookOver true without having run a pass", async () => {
    // The property the engine relies on, stated once as an invariant over all four cases above.
    for (const hb of [alive, released, new Error("x")] as const) {
      heartbeat = hb;
      passes = [];
      const body = await (await call("s3")).json().catch(() => ({}));
      if (body?.tookOver === true) expect(passes).toEqual(["engine-handover"]);
      else expect(passes).toEqual([]);
    }
  });
});
