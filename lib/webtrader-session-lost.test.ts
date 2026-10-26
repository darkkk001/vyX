import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Owner 2026-10-26: an expired demo.qoretrader.com WebTrader tab kept polling /api/trade/orders and /positions every
// 4 s, every answer a 401, because those reads swallowed every error. 0d6760e made the first 401 stop every poll and
// show the login once. WebTrader has no DOM test harness, so these pins hold that behaviour by source, like
// lib/trade-error.test.ts does.
const src = readFileSync(path.join(__dirname, "..", "components", "webtrader", "WebTrader.tsx"), "utf8");
const body = (name: string) => {
  const start = src.indexOf(`const ${name} = useCallback(async () => {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n  }, [", start));
};

describe("WebTrader: a 401 ends the polling", () => {
  it("the session-lost path runs once, then the login (desktop callback, else /trade or /trade/login)", () => {
    expect(src).toMatch(/sessionExpiredRef\.current = \(\) => \{\s*if \(sessionLostRef\.current\) return;\s*sessionLostRef\.current = true;/);
    expect(src).toMatch(/if \(onSessionExpired\) onSessionExpired\(\);\s*else window\.location\.href = demo \? "\/trade" : "\/trade\/login";/);
  });

  for (const name of ["refreshPositions", "refreshOrders"]) {
    it(`${name}: sends nothing once the session is lost, and a 401 ends it`, () => {
      const fn = body(name);
      expect(fn).toMatch(/^const \w+ = useCallback\(async \(\) => \{\s*if \(sessionLostRef\.current\) return;/);
      expect(fn).toContain("err instanceof ApiError && err.status === 401) sessionExpiredRef.current()");
    });
  }

  it("no account read swallows an error into an empty list (a blip would read as every position closed)", () => {
    expect(src).not.toMatch(/tradeApi\.(orders|allOrders|positions)\(\)\.catch\(/);
  });

  it("refreshAccount's 401 takes the same once-only path", () => {
    expect(body("refreshAccount")).toContain("err.status === 401) sessionExpiredRef.current()");
  });

  it("the 4 s price poll stops itself and clears its timer once the session is lost", () => {
    expect(src).toMatch(/async function poll\(\) \{\s*if \(sessionLostRef\.current\) \{\s*cancelled = true;\s*if \(timer\.id !== undefined\) clearInterval\(timer\.id\);\s*return;/);
    expect(src).toContain("timer.id = setInterval(poll, demo ? DEMO_POLL_MS : 30000);");
  });
});
