// Shadow bot, the read-only staff observer (S5): its TOTP is the web's, it can send exactly three requests, its
// credentials file is checked, its sign-in works end to end against a stubbed server and never journals a secret, and
// S5 checks the coverage leg appearing and closing. No network, no database.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTotp } from "../../../lib/totp";
import { assertObserverRequest, COVERAGE_ACCOUNT, GuardRefused, TRADE_HOST } from "../src/guards";
import { HttpObserver, loadObserverCreds } from "../src/observer";
import { totp } from "../src/totp";
import { Journal } from "../src/journal";
import { loadConfig, loadScenario } from "../bot";

// RFC 6238 appendix B, SHA1, key "12345678901234567890" (base32 below); the RFC's 8-digit codes, last 6 digits
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

describe("observer TOTP", () => {
  it("matches the RFC 6238 SHA1 test vectors (6 digits)", () => {
    expect(totp(RFC_SECRET, 59_000)).toBe("287082"); // 94287082
    expect(totp(RFC_SECRET, 1_111_111_109_000)).toBe("081804"); // 07081804
    expect(totp(RFC_SECRET, 1_234_567_890_000)).toBe("005924"); // 89005924
    expect(totp(RFC_SECRET, 2_000_000_000_000)).toBe("279037"); // 69279037
  });
  it("the web's own lib/totp.ts verifyTotp accepts the bot's code", () => {
    expect(verifyTotp(SECRET, totp(SECRET))).toBe(true);
    expect(verifyTotp(SECRET, totp(SECRET, Date.now() - 5 * 60_000))).toBe(false);
  });
});

describe("observer guard: exactly three requests", () => {
  it("allows sign-in, the 2FA step and the coverage account's positions", () => {
    expect(() => assertObserverRequest("POST", `${TRADE_HOST}/api/manage/login`)).not.toThrow();
    expect(() => assertObserverRequest("POST", `${TRADE_HOST}/api/manage/login/verify-2fa`)).not.toThrow();
    expect(() => assertObserverRequest("GET", `${TRADE_HOST}/api/manage/accounts/${COVERAGE_ACCOUNT}/positions`)).not.toThrow();
  });
  it("refuses every other account, every write, a query string, another host and the trade API", () => {
    for (const [m, u] of [
      ["GET", `${TRADE_HOST}/api/manage/accounts/49990007/positions`],
      ["POST", `${TRADE_HOST}/api/manage/accounts/${COVERAGE_ACCOUNT}/positions`],
      ["GET", `${TRADE_HOST}/api/manage/accounts/${COVERAGE_ACCOUNT}/positions?x=1`],
      ["POST", `${TRADE_HOST}/api/manage/positions/abc/close`],
      ["PATCH", `${TRADE_HOST}/api/manage/theme`],
      ["GET", `https://futurixglobal.vyxtrader.com/api/manage/accounts/${COVERAGE_ACCOUNT}/positions`],
      ["POST", `${TRADE_HOST}/api/trade/orders`],
      ["GET", `${TRADE_HOST}/api/manage/login`],
    ]) expect(() => assertObserverRequest(m, u), `${m} ${u}`).toThrow(GuardRefused);
  });
});

describe("observer credentials file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "obsbot-"));
  const file = (o: unknown) => { const f = path.join(dir, `${Math.random()}.json`); writeFileSync(f, JSON.stringify(o)); return f; };
  const good = { email: "observer@zzshadowbot.local", password: "p".repeat(48), totpSecret: SECRET, tenant: "zzshadowbot", createdAt: "x" };
  it("loads the seed's file", () => {
    expect(loadObserverCreds(file(good)).email).toBe("observer@zzshadowbot.local");
  });
  it("refuses a missing file, another tenant's user, and incomplete credentials", () => {
    expect(() => loadObserverCreds(path.join(dir, "none.json"))).toThrow(GuardRefused);
    expect(() => loadObserverCreds(file({ ...good, tenant: "futurixglobal", email: "observer@futurixglobal.local" }))).toThrow(GuardRefused);
    expect(() => loadObserverCreds(file({ ...good, email: "admin@zzshadowbot.local" }))).toThrow(GuardRefused);
    expect(() => loadObserverCreds(file({ ...good, totpSecret: "not base32!" }))).toThrow(GuardRefused);
    expect(() => loadObserverCreds(file({ ...good, password: "short" }))).toThrow(GuardRefused);
  });
});

describe("observer sign-in (stubbed server)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const creds = { email: "observer@zzshadowbot.local", password: "pw-" + "x".repeat(40), totpSecret: SECRET, tenant: "zzshadowbot" };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  it("password, then the TOTP code from the secret, then reads the coverage positions with the session cookie", async () => {
    const calls: { method: string; url: string; body: any; cookie: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init.method ?? "GET", url, body, cookie: (init.headers as Record<string, string> | undefined)?.cookie ?? null });
      if (url.endsWith("/api/manage/login")) return json(200, { requiresTwoFactor: true, pendingToken: "pending-1" });
      if (url.endsWith("/login/verify-2fa")) return body?.code === totp(SECRET) ? json(200, { ok: true }, { "set-cookie": "vyx_admin=sess-1; Path=/; HttpOnly" }) : json(401, { error: "invalid code" });
      if (url.endsWith(`/accounts/${COVERAGE_ACCOUNT}/positions`)) return json(200, { positions: [{ id: "leg-1", ticket: 7, symbol: "vGOLD", side: "BUY", volume: "0.1", openPrice: "2000.3", openedAt: "2026-09-29T10:00:00.000Z" }] });
      return json(404, {});
    });
    const legs = await new HttpObserver(creds).coveragePositions();
    expect(legs).toEqual([{ id: "leg-1", ticket: 7, symbol: "vGOLD", side: "BUY", volume: 0.1, openPrice: 2000.3, openedAt: "2026-09-29T10:00:00.000Z" }]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /api/manage/login", "POST /api/manage/login/verify-2fa", `GET /api/manage/accounts/${COVERAGE_ACCOUNT}/positions`]);
    expect(calls[1].body).toEqual({ pendingToken: "pending-1", code: totp(SECRET) });
    expect(calls[2].cookie).toBe("vyx_admin=sess-1");
  });

  it("stops if the observer signs in WITHOUT two-step verification (not the user the seed made)", async () => {
    vi.stubGlobal("fetch", async () => json(200, { ok: true }, { "set-cookie": "vyx_admin=s; Path=/" }));
    await expect(new HttpObserver(creds).coveragePositions()).rejects.toBeInstanceOf(GuardRefused);
  });

  it("the journal never holds the password, the TOTP secret, the pending token or the cookie", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "obsjournal-"));
    const j = new Journal(dir, "t");
    j.write({ kind: "observer.ready", coverageOpen: 1, credentials: "file (not logged)" });
    j.write({ kind: "coverage.leg", ref: "c", legId: "leg-1", ticket: 7, symbol: "vGOLD", side: "BUY", volume: 0.1 });
    const text = readFileSync(j.file, "utf8");
    for (const secret of [creds.password, SECRET, "pending-1", "sess-1"]) expect(text).not.toContain(secret);
  });
});

describe("S5 scenario", () => {
  it("needs the observer and checks the leg appear, then close, around the client's own open / close", () => {
    const sc = loadScenario("s5-coverage", loadConfig());
    expect(sc.needsObserver).toBe(true);
    const ops = sc.steps.map((s) => s.op);
    const at = (op: string) => ops.indexOf(op);
    expect(at("coverageBaseline")).toBeLessThan(at("open"));
    expect(at("open")).toBeLessThan(at("expectCoverageLeg"));
    expect(at("expectCoverageLeg")).toBeLessThan(at("close"));
    expect(at("close")).toBeLessThan(at("expectCoverageClosed"));
    expect(sc.accounts).toEqual(["49990007"]); // never the coverage account itself
  });
});
