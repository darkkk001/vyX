import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRedis } from "@/lib/redis";
import { checkRateLimit, recordFailure } from "@/lib/rate-limit";
import { LOGIN_PER_IP, PASSWORD_LOCKOUT, loginFailed, loginRefusal, loginSucceeded } from "@/lib/login-guard";

// Login hardening (owner 2026-10-28) on the test Redis: the per-IP limit, the wrong-password lockout, the atomic
// counter (a key never left without an expiry) and fail-open when Redis is down.

vi.mock("server-only", () => ({}));
const ip = (n: number) => ({ get: (h: string) => (h === "x-real-ip" ? `198.51.100.${n}` : null) });
const noIp = { get: () => null };
const id = (n: string) => `lg-test:${n}`;

beforeEach(async () => {
  const r = getRedis();
  const keys = [...(await r.keys("ratelimit:*lg-test*")), ...(await r.keys("ratelimit:login-ip:*198.51.100.*")), ...(await r.keys("lockout:*lg-test*"))];
  if (keys.length) await r.del(...keys);
});
afterAll(() => getRedis().disconnect());

describe("atomic counter", () => {
  it("every counted key carries an expiry, and a key stuck without one is healed on its next count", async () => {
    const r = getRedis();
    await checkRateLimit("lg-test:a", 5, 60);
    expect(await r.ttl("ratelimit:lg-test:a")).toBeGreaterThan(0);
    await r.set("ratelimit:lg-test:stuck", "99"); // the old INCR-then-EXPIRE bug: a count with no expiry
    expect(await r.ttl("ratelimit:lg-test:stuck")).toBe(-1);
    const res = await checkRateLimit("lg-test:stuck", 5, 60);
    expect(res.allowed).toBe(false);
    expect(await r.ttl("ratelimit:lg-test:stuck")).toBeGreaterThan(0); // it now runs out
  });

  it("the failure that locks restarts the window, so the lock lasts the full window", async () => {
    const r = getRedis();
    for (let i = 0; i < 4; i++) await recordFailure("lg-test:w", 900, 5);
    await r.expire("lockout:lg-test:w", 30); // the first failures were long ago
    await recordFailure("lg-test:w", 900, 5);
    expect(await r.ttl("lockout:lg-test:w")).toBeGreaterThan(890);
  });

  it("Redis down: the request goes through and a warning is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi.spyOn(getRedis(), "eval").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await checkRateLimit("lg-test:down", 1, 60)).toEqual({ allowed: true, remaining: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Redis unavailable"));
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe("login guard", () => {
  it(`locks an account for ${PASSWORD_LOCKOUT.windowSeconds / 60} minutes after ${PASSWORD_LOCKOUT.failures} wrong passwords, from any address`, async () => {
    for (let i = 0; i < PASSWORD_LOCKOUT.failures - 1; i++) {
      expect(await loginRefusal("trade", ip(1), id("acct"))).toBeNull();
      await loginFailed("trade", id("acct"));
    }
    expect(await loginRefusal("trade", ip(1), id("acct"))).toBeNull();
    await loginFailed("trade", id("acct")); // the 5th wrong password
    const locked = await loginRefusal("trade", ip(2), id("acct"));
    expect(locked).toMatchObject({ status: 429, code: "LOGIN_LOCKED", error: "too many wrong passwords, try again in 15 minutes" });
    expect(locked!.retryAfterSeconds).toBeGreaterThan(890);
    // another account and another kind of login are not affected
    expect(await loginRefusal("trade", ip(2), id("other"))).toBeNull();
    expect(await loginRefusal("portal", ip(2), id("acct"))).toBeNull();
  });

  it("the right password clears the failures so far", async () => {
    for (let i = 0; i < PASSWORD_LOCKOUT.failures - 1; i++) await loginFailed("manage", id("s"));
    await loginSucceeded("manage", id("s"));
    await loginFailed("manage", id("s"));
    expect(await loginRefusal("manage", ip(3), id("s"))).toBeNull();
  });

  it(`refuses attempts past ${LOGIN_PER_IP.limit} a minute from one address, whatever the account`, async () => {
    for (let i = 0; i < LOGIN_PER_IP.limit; i++) expect(await loginRefusal("portal", ip(4), id(`spray-${i}`))).toBeNull();
    expect(await loginRefusal("portal", ip(4), id("spray-x"))).toMatchObject({ status: 429, code: "LOGIN_IP_LIMIT", retryAfterSeconds: 60 });
    expect(await loginRefusal("portal", ip(5), id("spray-x"))).toBeNull(); // another address
    expect(await loginRefusal("admin", ip(4), id("spray-x"))).toBeNull(); // per kind of login
  });

  it("no trusted address: no shared per-IP bucket (it would lock everyone out), the lockout still applies", async () => {
    for (let i = 0; i < LOGIN_PER_IP.limit + 5; i++) expect(await loginRefusal("admin", noIp, id(`n-${i}`))).toBeNull();
    for (let i = 0; i < PASSWORD_LOCKOUT.failures; i++) await loginFailed("admin", id("n-0"));
    expect(await loginRefusal("admin", noIp, id("n-0"))).toMatchObject({ code: "LOGIN_LOCKED" });
  });
});
