import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vercel Firewall rules for the CRM (firewall/crm-rules.json, owner 2026-11-13): only the sign-in pages are
// challenged; every API, update feed and static file stays outside; the rate limits are on the two POSTs only.
type Cond = { type: string; op: string; value: string };
type Rule = { name: string; conditionGroup: { conditions: Cond[] }[]; enforce: { mitigate: { action: string; rateLimit?: { limit: number; window: number; keys: string[]; action: string } } } };
const cfg = JSON.parse(readFileSync("firewall/crm-rules.json", "utf8")) as { project: string; rules: Rule[] };

const hit = (c: Cond, req: { path: string; method: string }) => {
  const v = c.type === "path" ? req.path : c.type === "method" ? req.method : "";
  if (c.op === "eq") return v.toLowerCase() === c.value.toLowerCase();
  if (c.op === "pre") return v.toLowerCase().startsWith(c.value.toLowerCase());
  throw new Error(`operator not modelled: ${c.op}`);
};
const matches = (r: Rule, path: string, method = "GET") => r.conditionGroup.some((g) => g.conditions.every((c) => hit(c, { path, method })));
const rule = (name: string) => cfg.rules.find((r) => r.name === name)!;

describe("CRM firewall rules", () => {
  it("challenges the sign-in pages: /login, /register, /portal and every /portal page", () => {
    const r = rule("CRM pages challenge");
    expect(r.enforce.mitigate.action).toBe("challenge");
    for (const p of ["/login", "/register", "/portal", "/portal/forgot-password", "/portal/reset-password", "/portal/login"]) expect(matches(r, p)).toBe(true);
  });

  it("never touches APIs, WebTrader, update feeds or static files", () => {
    const outside = [
      "/api/trade/login", "/api/trade/me", "/api/manage/login", "/api/portal/login", "/api/room/money", "/api/auth/google/callback",
      "/api/bitmoji/callback", "/api/health", "/trade", "/trade/login", "/native-terminal-updates/qoretrader/releases.win.json",
      "/native-backoffice-updates/futurixglobal/RELEASES", "/_next/static/chunks/main.js", "/favicon.ico", "/apple-touch-icon.png",
      "/brand-logo/abc/140@2x.webp", "/room", "/room/deposit", "/",
    ];
    for (const p of outside) for (const m of ["GET", "POST"]) expect(cfg.rules.filter((r) => r.enforce.mitigate.action === "challenge" && matches(r, p, m)).map((r) => r.name), `${m} ${p}`).toEqual([]);
  });

  it("per-IP rate limits on the login and register POSTs only, answered with 429", () => {
    const login = rule("Login API per-IP limit");
    const register = rule("Register API per-IP limit");
    for (const [r, path, limit] of [[login, "/api/portal/login", 30], [register, "/api/portal/register", 10]] as const) {
      expect(matches(r, path, "POST")).toBe(true);
      expect(matches(r, path, "GET")).toBe(false);
      expect(matches(r, "/api/trade/login", "POST")).toBe(false);
      expect(r.enforce.mitigate.rateLimit).toEqual({ algo: "fixed_window", window: 60, limit, keys: ["ip"], action: "rate_limit" });
    }
  });

  it("Log mode turns every rule into Log (rate limits keep counting)", () => {
    const src = readFileSync("scripts/firewall-apply.mjs", "utf8");
    expect(src).toContain('return rl\n    ? { mitigate: { action: "rate_limit", rateLimit: { ...rl, action: "log" } } }\n    : { mitigate: { action: "log" } };');
  });
});
