import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clientAccountInfo } from "@/lib/client-execution";

// Owner 2026-11-10: the terminal header and share card show the account's nickname (Trader's Room) when set, else the full name.
describe("/api/trade/me carries the account nickname", () => {
  it("the client allow-list passes nickname and still drops what is not on it", () => {
    const out = clientAccountInfo({ accountNumber: "1001", fullName: "Huzaifa", nickname: "The Bullion Trader", passwordHash: "x" });
    expect(out).toEqual({ accountNumber: "1001", fullName: "Huzaifa", nickname: "The Bullion Trader" });
    expect(clientAccountInfo({ fullName: "A", nickname: null })).toEqual({ fullName: "A", nickname: null });
  });
  it("the route selects it", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", "app", "api", "trade", "me", "route.ts"), "utf8");
    expect(src).toContain("nickname: true,");
  });
});
