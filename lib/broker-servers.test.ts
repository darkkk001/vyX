import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { brokerServers, compactBrokerName, kindFromRefusal, mismatchText, serverForKind, serverMatches } from "./broker-servers";

describe("broker servers", () => {
  it("derives <BrokerName>Live and <BrokerName>Demo from the broker's name", () => {
    expect(brokerServers("Futurix Global")).toEqual([
      { name: "FuturixGlobalLive", kind: "LIVE" },
      { name: "FuturixGlobalDemo", kind: "DEMO" },
    ]);
    expect(brokerServers("QoreTrader").map((s) => s.name)).toEqual(["QoreTraderLive", "QoreTraderDemo"]);
  });

  it("keeps letters and digits only, never an empty name", () => {
    expect(compactBrokerName("Nova Markets (EU) Ltd.")).toBe("NovaMarketsEULtd");
    expect(compactBrokerName("—")).toBe("VyXTrader");
  });
});

describe("live / demo mismatch", () => {
  it("names the account's own server in one line", () => {
    expect(mismatchText("DEMO")).toBe("This account belongs to the Demo server");
    expect(mismatchText("LIVE")).toBe("This account belongs to the Live server");
  });

  it("reads the kind out of the login route's refusal", () => {
    expect(kindFromRefusal("this is a Demo account, select the Demo server and try again")).toBe("DEMO");
    expect(kindFromRefusal("this is a Live account, select the Live server and try again")).toBe("LIVE");
    expect(kindFromRefusal("invalid credentials")).toBeNull();
    expect(kindFromRefusal(undefined)).toBeNull();
  });

  it("a flag the server did not send is not a mismatch; a different one is", () => {
    expect(serverMatches("LIVE", "LIVE")).toBe(true);
    expect(serverMatches("DEMO", "demo")).toBe(true);
    expect(serverMatches("LIVE", "DEMO")).toBe(false);
    expect(serverMatches("DEMO", "LIVE")).toBe(false);
    expect(serverMatches("LIVE", undefined)).toBe(true);
    expect(serverMatches("LIVE", "")).toBe(true);
  });

  it("finds the entry of the account's kind, preferring the remembered name", () => {
    const list = [
      { name: "FuturixGlobalLive-1", kind: "LIVE" as const },
      { name: "FuturixGlobalLive-2", kind: "LIVE" as const },
      { name: "FuturixGlobalDemo", kind: "DEMO" as const },
    ];
    expect(serverForKind(list, "DEMO")?.name).toBe("FuturixGlobalDemo");
    expect(serverForKind(list, "LIVE", "FuturixGlobalLive-2")?.name).toBe("FuturixGlobalLive-2");
    expect(serverForKind(list, "LIVE")?.name).toBe("FuturixGlobalLive-1");
    expect(serverForKind([list[0]], "DEMO")).toBeNull();
  });
});

describe("the WebTrader sign-in's Server selector", () => {
  const form = readFileSync(path.join(import.meta.dirname, "..", "app/(broker)/trade/login/TradeLoginForm.tsx"), "utf8");

  it("takes its list from lib/broker-servers.ts, not from names typed into the form", () => {
    expect(form).toContain('from "@/lib/broker-servers"');
    expect(form).toContain("brokerServers(brokerName)");
    expect(form).not.toContain("-Live`");
    expect(form).not.toContain("-Demo`");
  });

  it("refuses a Live / Demo mismatch with the one line, moves the selector, and keeps the account number", () => {
    expect(form).toContain("kindFromRefusal(");
    expect(form).toContain("mismatchText(actual)");
    expect(form).toContain("serverMatches(selectedServer.type, result.accountMode)");
    expect(form).toContain('setPassword("")');
  });
});
