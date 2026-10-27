import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attemptFreshConnection, CACHE_MS, classifyDbError, LOG_REPEAT_MS, probeDatabase, resetDbProbe } from "@/lib/db-probe";

vi.mock("server-only", () => ({}));

describe("db probe (incident 2026-10-27)", () => {
  let errors: string[];
  let warns: string[];
  beforeEach(() => {
    resetDbProbe();
    errors = [];
    warns = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation((m: unknown) => void warns.push(String(m)));
  });
  afterEach(() => vi.restoreAllMocks());

  it("probes once per 10 s per instance; concurrent requests share one probe", async () => {
    const attempt = vi.fn(async () => null);
    const t0 = 1_000_000;
    await Promise.all([probeDatabase({ now: t0, attempt }), probeDatabase({ now: t0, attempt }), probeDatabase({ now: t0, attempt })]);
    expect(attempt).toHaveBeenCalledTimes(1);
    await probeDatabase({ now: t0 + CACHE_MS - 1, attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(await probeDatabase({ now: t0 + CACHE_MS, attempt })).toEqual({ ok: true });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("a failure: down with the reason and how long; logged once, again after a minute, recovery once", async () => {
    let result: "auth" | null = "auth";
    const attempt = async () => result;
    const t0 = 1_000_000;
    expect(await probeDatabase({ now: t0, attempt })).toEqual({ ok: false, reason: "auth", downSecs: 0 });
    for (let s = 10; s < 60; s += 10) await probeDatabase({ now: t0 + s * 1000, attempt });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("refuses NEW connections (auth)");
    expect(await probeDatabase({ now: t0 + LOG_REPEAT_MS, attempt })).toEqual({ ok: false, reason: "auth", downSecs: 60 });
    expect(errors).toHaveLength(2);
    result = null;
    expect(await probeDatabase({ now: t0 + 70_000, attempt })).toEqual({ ok: true });
    expect(warns).toEqual(["DB PROBE: the book database accepts new connections again after 70 s"]);
  });

  it("classifies Prisma's connection errors", () => {
    expect(classifyDbError({ errorCode: "P1000", message: "Authentication failed against database server" })).toBe("auth");
    expect(classifyDbError({ message: 'password authentication failed for user "vyx_web"' })).toBe("auth");
    expect(classifyDbError({ errorCode: "P1001", message: "Can't reach database server at `x`" })).toBe("unreachable");
    expect(classifyDbError({ errorCode: "P1002", message: "timed out" })).toBe("timeout");
    expect(classifyDbError({ errorCode: "P2002", message: "unique" })).toBe("error");
  });

  it("a fresh connection: the test database answers; a closed port does not, within the limit", async () => {
    expect(await attemptFreshConnection(process.env.DATABASE_URL)).toBeNull();
    const t = Date.now();
    const r = await attemptFreshConnection("postgresql://nobody:x@127.0.0.1:1/none", 2_000);
    expect(["unreachable", "timeout"]).toContain(r);
    expect(Date.now() - t).toBeLessThan(2_500);
  });

  // A real refusal of the credentials: VYX_TEST_PG_URL = a reachable Postgres with password auth (the password is swapped).
  it.skipIf(!process.env.VYX_TEST_PG_URL)("a wrong password is auth", async () => {
    const url = new URL(process.env.VYX_TEST_PG_URL!);
    expect(await attemptFreshConnection(url.toString())).toBeNull();
    url.password = "definitely-not-the-password";
    expect(await attemptFreshConnection(url.toString())).toBe("auth");
  });
});
