// Engine actions (owner 2026-11-14): placeholders only. Every action is a disabled button, and the section never calls the server: no fetch on
// render, and no fetch / API path anywhere in its source (there is no route behind it yet; the backend comes with the engine packaging).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import EngineActions, { ENGINE_ACTION_GROUPS } from "./EngineActions";

afterEach(() => vi.unstubAllGlobals());

describe("EngineActions", () => {
  it("renders the two license tiers, the three kill-switch states and deploy, every one disabled", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const html = renderToStaticMarkup(createElement(EngineActions, { engineId: "eu-fr-1" }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const keys = [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["license-engine", "license-broker", "suspend", "resume", "revoke", "deploy"]);
    expect(buttons).toHaveLength(6);
    for (const b of buttons) expect(b).toMatch(/\sdisabled=""/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("states the license semantics: Suspended keeps risk ON, Stopped hands risk to the web", () => {
    const kill = ENGINE_ACTION_GROUPS.find((g) => g.title === "Kill switch")!.actions;
    expect(kill.map((a) => a.label)).toEqual(["Suspend", "Resume", "Revoke"]);
    expect(kill.find((a) => a.key === "suspend")!.detail).toMatch(/Suspended.*risk stays ON/);
    expect(kill.find((a) => a.key === "revoke")!.detail).toMatch(/Stopped.*risk hands off to the web/);
    const lic = ENGINE_ACTION_GROUPS.find((g) => g.title === "Licenses")!.actions;
    expect(lic.map((a) => a.detail)).toEqual([expect.stringContaining("app = engine"), expect.stringContaining("per broker")]);
  });

  it("has no server call in its source: no fetch, no API path, no click handler", () => {
    const src = readFileSync(join(__dirname, "EngineActions.tsx"), "utf8");
    expect(src).not.toMatch(/fetch\s*\(/);
    expect(src).not.toMatch(/["'`]\/api\//);
    expect(src).not.toMatch(/onClick/);
  });
});
