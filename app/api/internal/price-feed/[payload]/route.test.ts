// The price feed's path transport is closed (owner 2026-10-23): even a payload carrying the right secret is a 400, and
// nothing is decoded or forwarded.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("price-feed/[payload]: closed", () => {
  it("the right secret in the path -> 400 PATH_SECRET_REFUSED, nothing forwarded", async () => {
    const forward = vi.fn();
    vi.stubGlobal("fetch", forward);
    process.env.PRICE_FEED_SECRET = "feed-secret";
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PATH_SECRET_REFUSED");
    expect(forward).not.toHaveBeenCalled();
  });
  it("the handler reads no request: it cannot decode a secret", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).toMatch(/export async function GET\(\)/);
    expect(src).not.toContain("ingestTicks");
    expect(src).not.toContain("Buffer.from");
  });
});
