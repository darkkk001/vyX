// Security re-audit 2026-10-23: audit-retention fails CLOSED without its secret (unset, empty, wrong) and never reaches its work;
// the right secret is accepted; the compare is constant-time (bearerMatches from lib/internal-auth.ts), not a plain !==.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit-retention", () => ({ purgeExpiredAuditLogs: vi.fn().mockResolvedValue([]) }));

const KEY = "CRON_SECRET";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  vi.clearAllMocks();
});

const URL_ = "https://t.local/api/internal/audit-retention";
const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("./route");
  return GET(new NextRequest(URL_, { headers }));
};
const auth = (v: string): Record<string, string> => ({ authorization: `Bearer ${v}` });
const work = async () => (await import("@/lib/audit-retention")).purgeExpiredAuditLogs;

describe("audit-retention: no secret, no work", () => {
  it("secret unset: no header, an empty one, or any value -> 401, work never runs", async () => {
    for (const h of [{}, auth(""), auth("anything")]) expect((await call(h)).status).toBe(401);
    expect(await work()).not.toHaveBeenCalled();
  });
  it("secret set: missing, empty, wrong, same-length wrong, prefix -> 401, work never runs", async () => {
    process.env[KEY] = "s3cret-value";
    for (const h of [{}, auth(""), auth("nope"), auth("s3cret-valuX"), auth("s3cret")]) expect((await call(h)).status).toBe(401);
    expect(await work()).not.toHaveBeenCalled();
  });
  it("the right secret is accepted and the work runs", async () => {
    process.env[KEY] = "s3cret-value";
    expect((await call(auth("s3cret-value"))).status).toBe(200);
    expect(await work()).toHaveBeenCalled();
  });
  it("the compare is constant-time: bearerMatches, no !== on a secret", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).toContain("bearerMatches(");
    expect(src).not.toMatch(/!==\s*(expected|expectedSecret|secret|configured)/i);
  });
});
