import { test } from "node:test";
import assert from "node:assert/strict";
import { readOnlyWrite } from "./auth.js";

// The read-only (investor) password: a session from it can read through the gateway and never place, change or cancel.
test("a read-only session writes nothing", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(readOnlyWrite({ readOnly: true }, m), true);
});
test("a read-only session reads", () => {
  assert.equal(readOnlyWrite({ readOnly: true }, "GET"), false);
  assert.equal(readOnlyWrite({ readOnly: true }, "HEAD"), false);
});
test("a normal session is not touched", () => {
  assert.equal(readOnlyWrite({}, "POST"), false);
  assert.equal(readOnlyWrite({ readOnly: false }, "POST"), false);
});
