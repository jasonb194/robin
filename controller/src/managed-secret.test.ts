import { test } from "node:test";
import assert from "node:assert/strict";
import { createAndTrackSecret, skipExistingSecret } from "./managed-secret.js";

test("new secret ownership failure compensates by deleting the newly created secret", async () => {
  const calls: string[] = [];
  await assert.rejects(createAndTrackSecret({
    secretName: "ROBIN_ACCOUNT_LLM_API_KEY",
    create: async () => { calls.push("create"); return 201; },
    recordOwnership: async () => { calls.push("record"); throw new Error("database down"); },
    compensateDelete: async () => { calls.push("delete"); },
  }), /newly created secret was removed/);
  assert.deepEqual(calls, ["create", "record", "delete"]);
});

test("compensation failure clearly reports the untracked secret", async () => {
  await assert.rejects(createAndTrackSecret({
    secretName: "ROBIN_ACCOUNT_LLM_API_KEY",
    create: async () => 201,
    recordOwnership: async () => { throw new Error("database down"); },
    compensateDelete: async () => { throw new Error("GitHub unavailable"); },
  }), /secret may remain untracked/);
});

test("pre-existing secret response is not tracked or deleted", async () => {
  const calls: string[] = [];
  await assert.rejects(createAndTrackSecret({
    secretName: "ROBIN_ACCOUNT_LLM_API_KEY",
    create: async () => 204,
    recordOwnership: async () => { calls.push("record"); },
    compensateDelete: async () => { calls.push("delete"); },
  }), /HTTP 204/);
  assert.deepEqual(calls, []);
});

test("existing secret is skipped only when Robin has an ownership record", () => {
  const name = "ROBIN_ACCOUNT_LLM_API_KEY";
  assert.equal(skipExistingSecret(name, "acme/repo", false, false), false);
  assert.equal(skipExistingSecret(name, "acme/repo", true, true), true);
  assert.throws(() => skipExistingSecret(name, "acme/repo", true, false), /already exists without a Robin ownership record/);
});
