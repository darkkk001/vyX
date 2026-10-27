import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { attempt, classify, healthBody, LOG_REPEAT_MS, Probe, PROBE_TIMEOUT_MS, STALE_AFTER_MS } from "./db-probe.js";

test("a failure raises once, repeats every minute, recovers once", () => {
  const p = new Probe();
  const t0 = 1_000_000;
  assert.deepEqual(p.reading(t0), { kind: "starting" });
  assert.equal(p.record(null, t0), null);
  assert.deepEqual(p.reading(t0), { kind: "ok" });
  const t1 = t0 + 10_000;
  assert.deepEqual(p.record("auth", t1), { kind: "raise", reason: "auth" });
  assert.deepEqual(p.reading(t1 + 5_000), { kind: "down", reason: "auth", secs: 5 });
  for (let i = 1; i < 6; i++) assert.equal(p.record("auth", t1 + 10_000 * i), null, `probe ${i}`);
  assert.deepEqual(p.record("auth", t1 + LOG_REPEAT_MS), { kind: "repeat", reason: "auth", secs: 60 });
  assert.deepEqual(p.record(null, t1 + 70_000), { kind: "recovered", secs: 70 });
  assert.equal(p.record(null, t1 + 80_000), null);
});

test("an idle pool skips the probe only while the database was good; a stuck probe reads as down", () => {
  const p = new Probe();
  const t0 = 1_000_000;
  assert.equal(p.due(false), true, "the first probe always runs");
  p.record(null, t0);
  assert.equal(p.due(false), false);
  p.skipped(t0 + 10_000);
  assert.deepEqual(p.reading(t0 + 10_000), { kind: "idle" });
  p.record("unreachable", t0 + 20_000);
  assert.equal(p.due(false), true, "down: keep probing so the recovery is seen");
  p.skipped(t0 + 30_000);
  assert.equal(p.reading(t0 + 30_000).kind, "down", "a skip never hides a failure");
  const q = new Probe();
  q.record(null, t0);
  assert.deepEqual(q.reading(t0 + STALE_AFTER_MS + 1_000), { kind: "down", reason: "probe-stale", secs: 31 });
});

test("/health: 200 {ok:true, db} unless down; down is 503 naming the database", () => {
  assert.deepEqual(healthBody(null), { status: 200, body: { ok: true } });
  assert.deepEqual(healthBody({ kind: "ok" }), { status: 200, body: { ok: true, db: "ok" } });
  assert.deepEqual(healthBody({ kind: "idle" }), { status: 200, body: { ok: true, db: "idle" } });
  assert.deepEqual(healthBody({ kind: "down", reason: "auth", secs: 42 }), { status: 503, body: { ok: false, status: "down", db: "down", reason: "auth", down_secs: 42 } });
});

test("classify: the auth codes and message, network codes", () => {
  assert.equal(classify({ code: "28P01", message: "x" }), "auth");
  assert.equal(classify({ message: 'password authentication failed for user "neondb_owner"' }), "auth");
  assert.equal(classify({ code: "ECONNREFUSED" }), "unreachable");
  assert.equal(classify({ code: "42P01" }), "error");
});

test("a server that accepts and never answers is a timeout, within the limit", async () => {
  const held: unknown[] = [];
  const srv = createServer((s) => { held.push(s); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const t = Date.now();
  assert.equal(await attempt(`postgres://nobody:x@127.0.0.1:${port}/none`, 500), "timeout");
  assert.ok(Date.now() - t < 500 + 500);
  for (const s of held) (s as { destroy(): void }).destroy();
  srv.close();
});

test("a refused port fails within the timeout", async () => {
  const t = Date.now();
  const r = await attempt("postgres://nobody:x@127.0.0.1:1/none", PROBE_TIMEOUT_MS);
  assert.ok(r === "unreachable" || r === "timeout", String(r));
  assert.ok(Date.now() - t <= PROBE_TIMEOUT_MS + 500);
});

// A real refusal of the credentials: VYX_TEST_PG_URL = a reachable Postgres with password auth (the password is swapped).
test("a wrong password is auth", { skip: !process.env.VYX_TEST_PG_URL }, async () => {
  const url = new URL(process.env.VYX_TEST_PG_URL!);
  assert.equal(await attempt(url.toString()), null);
  url.password = "definitely-not-the-password";
  assert.equal(await attempt(url.toString()), "auth");
});
