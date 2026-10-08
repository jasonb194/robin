import { test } from "node:test";
import assert from "node:assert/strict";
import { createAndTrackSecret, skipExistingSecret } from "./managed-secret.js";

test("ownership recording failure reports the possibly untracked secret without deleting it", async () => {
  const calls: string[] = [];
  await assert.rejects(createAndTrackSecret({
    secretName: "ROBIN_ACCOUNT_LLM_API_KEY",
    create: async () => { calls.push("create"); return 201; },
    recordOwnership: async () => { calls.push("record"); throw new Error("database down"); },
  }), /database ownership recording failed after HTTP 201; the secret may remain untracked and requires manual cleanup before retrying/);
  assert.deepEqual(calls, ["create", "record"]);
});

test("pre-existing secret response is not tracked or deleted", async () => {
  const calls: string[] = [];
  await assert.rejects(createAndTrackSecret({
    secretName: "ROBIN_ACCOUNT_LLM_API_KEY",
    create: async () => 204,
    recordOwnership: async () => { calls.push("record"); },
  }), /HTTP 204/);
  assert.deepEqual(calls, []);
});

test("existing secret is skipped only when Robin has an ownership record", () => {
  const name = "ROBIN_ACCOUNT_LLM_API_KEY";
  assert.equal(skipExistingSecret(name, "acme/repo", false, false), false);
  assert.equal(skipExistingSecret(name, "acme/repo", true, true), true);
  assert.throws(() => skipExistingSecret(name, "acme/repo", true, false), /already exists without a Robin ownership record/);
});
