// node --test tools/feeds/prune-r2.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, cmpVersion } from "./prune-r2.mjs";

const full = (v) => ({ Type: "Full", Version: v, FileName: `App-${v}-full.nupkg`, Size: 1 });
const delta = (v) => ({ Type: "Delta", Version: v, FileName: `App-${v}-delta.nupkg`, Size: 1 });

test("versions sort numerically, not as text", () => {
  assert.ok(cmpVersion("1.0.10", "1.0.9") > 0);
  assert.ok(cmpVersion("1.0.95", "1.0.100") < 0);
  assert.ok(cmpVersion("1.0.9-beta", "1.0.9") < 0);
});

test("the newest 5 fulls stay, deltas newer than the oldest kept full stay, everything else goes", () => {
  const assets = ["1.0.8", "1.0.9", "1.0.10", "1.0.11", "1.0.12", "1.0.13", "1.0.14"].flatMap((v) => [full(v), delta(v)]);
  const p = plan(assets, 5);
  assert.equal(p.floor, "1.0.10");
  assert.deepEqual(p.keep.filter((a) => a.Type === "Full").map((a) => a.Version).sort(cmpVersion), ["1.0.10", "1.0.11", "1.0.12", "1.0.13", "1.0.14"]);
  assert.deepEqual(p.keep.filter((a) => a.Type === "Delta").map((a) => a.Version).sort(cmpVersion), ["1.0.11", "1.0.12", "1.0.13", "1.0.14"]);
  assert.deepEqual(p.drop.map((a) => a.FileName).sort(), ["App-1.0.10-delta.nupkg", "App-1.0.8-delta.nupkg", "App-1.0.8-full.nupkg", "App-1.0.9-delta.nupkg", "App-1.0.9-full.nupkg"]);
});

test("a feed with 5 or fewer fulls loses nothing; unknown asset types are never pruned", () => {
  const assets = [full("1.0.1"), full("1.0.2"), delta("1.0.2"), { Type: "Installer", FileName: "Setup.exe" }];
  const p = plan(assets, 5);
  assert.equal(p.drop.length, 0);
  assert.equal(p.keep.length, 4);
});
