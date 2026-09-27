import { test } from "node:test";
import assert from "node:assert/strict";
import { internalSecretOk, rotationInProgress } from "./internal-secret.js";

test("current secret accepted; old refused unless a rotation keeps it as PREVIOUS", () => {
  const env = { INTERNAL_SERVICE_SECRET: "new" } as NodeJS.ProcessEnv;
  assert.equal(internalSecretOk("new", env), true);
  assert.equal(internalSecretOk("old", env), false);
  assert.equal(rotationInProgress(env), false);
  const rotating = { INTERNAL_SERVICE_SECRET: "new", INTERNAL_SERVICE_SECRET_PREVIOUS: "old" } as NodeJS.ProcessEnv;
  assert.equal(internalSecretOk("old", rotating), true);
  assert.equal(internalSecretOk("new", rotating), true);
  assert.equal(internalSecretOk("other", rotating), false);
  assert.equal(rotationInProgress(rotating), true);
});

test("never matches an empty or missing value; a header array uses its first value", () => {
  assert.equal(internalSecretOk(undefined, { INTERNAL_SERVICE_SECRET: "x" } as NodeJS.ProcessEnv), false);
  assert.equal(internalSecretOk("", { INTERNAL_SERVICE_SECRET: "" } as NodeJS.ProcessEnv), false);
  assert.equal(internalSecretOk("", {} as NodeJS.ProcessEnv), false);
  assert.equal(internalSecretOk(["x", "y"], { INTERNAL_SERVICE_SECRET: "x" } as NodeJS.ProcessEnv), true);
});
