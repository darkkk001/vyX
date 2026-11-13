import { describe, expect, it } from "vitest";
import { engineAliveForBroker, engineHealth, parseEngineInput, validEngineId, validGatewayUrl } from "@/lib/engine-registry";

// Multi-engine control plane (owner 2026-11-13): the pure rules.
describe("engineAliveForBroker (the web's owner rule)", () => {
  it("no assigned engine, or an engine that has never written its own heartbeat: the legacy single heartbeat decides (today, inert)", () => {
    for (const legacy of [true, false]) {
      expect(engineAliveForBroker(legacy, null)).toBe(legacy);
      for (const status of ["PLANNED", "ACTIVE", "DRAINING", "RETIRED"]) expect(engineAliveForBroker(legacy, { status, started: false, fresh: false })).toBe(legacy);
    }
  });
  it("an engine that writes its own heartbeat: alive only while fresh AND serving (ACTIVE / DRAINING); otherwise the web reclaims", () => {
    expect(engineAliveForBroker(false, { status: "ACTIVE", started: true, fresh: true })).toBe(true);
    expect(engineAliveForBroker(false, { status: "DRAINING", started: true, fresh: true })).toBe(true);
    expect(engineAliveForBroker(true, { status: "ACTIVE", started: true, fresh: false })).toBe(false);   // stale: the legacy beat no longer rescues it
    expect(engineAliveForBroker(true, { status: "RETIRED", started: true, fresh: true })).toBe(false);
    expect(engineAliveForBroker(true, { status: "PLANNED", started: true, fresh: true })).toBe(false);
  });
});

describe("registry input", () => {
  it("ids, URLs and health", () => {
    expect(validEngineId("eu-fr-1")).toBe(true);
    for (const bad of ["EU", "1eu", "eu_fr", "a", "x".repeat(41), null]) expect(validEngineId(bad)).toBe(false);
    expect(validGatewayUrl("https://feed.vyxtrader.com")).toBe(true);
    for (const bad of ["http://x.test", "https://u:p@x.test", "notaurl", ""]) expect(validGatewayUrl(bad)).toBe(false);
    const now = new Date("2026-11-13T12:00:00Z");
    expect(engineHealth(null, 30, now)).toBe("never");
    expect(engineHealth(new Date("2026-11-13T11:59:45Z"), 30, now)).toBe("fresh");
    expect(engineHealth(new Date("2026-11-13T11:59:00Z"), 30, now)).toBe("stale");
  });
  it("create needs every field; an edit takes a subset; bad values are refused", () => {
    expect(() => parseEngineInput({ id: "eu-de-1", name: "Frankfurt 1", region: "Europe (Germany)" }, true)).toThrow(/gateway/);
    expect(parseEngineInput({ id: "eu-de-1", name: " Frankfurt 1 ", region: "Europe", gatewayUrl: "https://gw.example.com" }, true)).toMatchObject({ id: "eu-de-1", name: "Frankfurt 1" });
    expect(parseEngineInput({ status: "DRAINING" }, false)).toEqual({ status: "DRAINING" });
    expect(() => parseEngineInput({ status: "GONE" }, false)).toThrow(/status/);
    expect(() => parseEngineInput({ staleAfterSecs: 2 }, false)).toThrow(/stale/);
  });
});
