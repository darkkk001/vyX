import { describe, expect, it } from "vitest";
import { brokerServers, compactBrokerName } from "./broker-servers";

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
