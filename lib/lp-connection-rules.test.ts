import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { checkSymbolRow, parseConnectionFields, parseSymbolFields } from "@/lib/lp-connection-input";
import { draftBody, draftProblem, newDraft, symbolProblem, type ConnectionDraft, type SymbolDraft } from "@/lib/lp-connection-rules";

// The browser's LP connection checks (lib/lp-connection-rules.ts) must refuse exactly what the server
// (lib/lp-connection-input.ts) refuses, in the same words. Neither server parser touches the database here: no provider
// id and no symbol id is sent.
const noDb = {} as never;

async function serverConnection(d: ConnectionDraft): Promise<string | null> {
  try {
    await parseConnectionFields(noDb, "b1", draftBody(d), false);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
async function serverSymbol(s: SymbolDraft, dialect: string): Promise<string | null> {
  try {
    const f = await parseSymbolFields(noDb, "b1", { ...s }, false);
    checkSymbolRow({ venueId: f.venueId!, minUnits: f.minUnits as Prisma.Decimal, stepUnits: f.stepUnits as Prisma.Decimal }, dialect);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const good: ConnectionDraft = { ...newDraft(), host: "fix.lp.test", port: "5201", senderCompId: "BROKER1", targetCompId: "LPX" };

describe("LP connection form checks match the server", () => {
  const cases: [string, Partial<ConnectionDraft>][] = [
    ["valid", {}],
    ["no host", { host: "" }],
    ["host with scheme", { host: "https://fix.lp.test" }],
    ["port 0", { port: "0" }],
    ["port 70000", { port: "70000" }],
    ["port text", { port: "abc" }],
    ["sender with space", { senderCompId: "BRO KER" }],
    ["no target", { targetCompId: "" }],
    ["long username", { username: "u".repeat(65) }],
    ["sub id with space", { senderSubId: "a b" }],
    ["tls name with tls off", { tls: "OFF", tlsServerName: "fix.lp.test" }],
    ["bad tls name", { tlsServerName: "fix lp" }],
    ["heartbeat 0", { heartbeatSecs: "0" }],
    ["heartbeat 301", { heartbeatSecs: "301" }],
    ["heartbeat 1.5", { heartbeatSecs: "1.5" }],
  ];
  for (const [name, patch] of cases) {
    it(name, async () => {
      const d = { ...good, ...patch };
      expect(draftProblem(d, 1)).toBe(await serverConnection(d));
    });
  }

  it("an enabled cTrader session without symbols is refused (the server's 409 words)", () => {
    expect(draftProblem({ ...good, dialect: "CSERVER", enabled: true }, 0)).toBe("a cTrader connection needs at least one symbol before it can be enabled");
    expect(draftProblem({ ...good, dialect: "CSERVER", enabled: false }, 0)).toBeNull();
  });
});

describe("symbol row checks match the server", () => {
  const ok: SymbolDraft = { venueId: "EURUSD", contractSize: "100000", minUnits: "1000", stepUnits: "1000" };
  const cases: [string, Partial<SymbolDraft>, string][] = [
    ["valid", {}, "FIX44"],
    ["no venue", { venueId: "" }, "FIX44"],
    ["venue with space", { venueId: "EUR USD" }, "FIX44"],
    ["contract 0", { contractSize: "0" }, "FIX44"],
    ["contract negative", { contractSize: "-1" }, "FIX44"],
    ["contract text", { contractSize: "abc" }, "FIX44"],
    ["5 decimals", { minUnits: "0.00001", stepUnits: "0.00001" }, "FIX44"],
    ["4 decimals", { minUnits: "0.0001", stepUnits: "0.0001" }, "FIX44"],
    ["min not on step", { minUnits: "1500", stepUnits: "1000" }, "FIX44"],
    ["fractional step", { minUnits: "0.03", stepUnits: "0.01" }, "FIX44"],
    ["too large", { contractSize: "100000000000000" }, "FIX44"],
    ["cTrader name venue", {}, "CSERVER"],
    ["cTrader numeric venue", { venueId: "41" }, "CSERVER"],
  ];
  for (const [name, patch, dialect] of cases) {
    it(name, async () => {
      const s = { ...ok, ...patch };
      expect(symbolProblem(s, dialect as "FIX44" | "CSERVER")).toBe(await serverSymbol(s, dialect));
    });
  }
});
