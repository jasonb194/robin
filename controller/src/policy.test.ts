import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRepositories, validatePolicy } from "./policy.js";
import { decryptSecret, encryptSecret, encryptionKey, verifySignature } from "./crypto.js";
import { createHmac, randomBytes } from "node:crypto";

test("policy supports all, none, exact names, and safe regex selectors", () => {
  const repos = [{ name: "Docs" }, { name: "api-service" }, { name: "web" }];
  assert.deepEqual(selectRepositories(repos, validatePolicy({ mode: "all", selectors: [] })).map((r) => r.name), ["api-service", "Docs", "web"]);
  assert.deepEqual(selectRepositories(repos, validatePolicy({ mode: "none", selectors: [] })), []);
  assert.deepEqual(selectRepositories(repos, validatePolicy({ mode: "only", selectors: [{ type: "name", value: "DOCS" }, { type: "regex", value: "^api-" }] })).map((r) => r.name), ["api-service", "Docs"]);
  assert.deepEqual(selectRepositories(repos, validatePolicy({ mode: "all-but", selectors: [{ type: "name", value: "web" }] })).map((r) => r.name), ["api-service", "Docs"]);
});

test("policy rejects malformed and oversized selector expressions", () => {
  assert.throws(() => validatePolicy({ mode: "only", selectors: [] }), /requires at least one selector/);
  assert.throws(() => validatePolicy({ mode: "all", selectors: [{ type: "name", value: "x" }] }), /does not accept selectors/);
  assert.throws(() => validatePolicy({ mode: "only", selectors: [{ type: "regex", value: "[" }] }), /invalid regex/);
  assert.throws(() => validatePolicy({ mode: "only", selectors: [{ type: "regex", value: "x".repeat(513) }] }), /512 characters/);
});

test("database secrets use authenticated encryption and webhook signatures bind exact bytes", () => {
  const key = encryptionKey(randomBytes(32).toString("base64"));
  const sealed = encryptSecret("credential-value", key);
  assert.equal(decryptSecret(sealed, key), "credential-value");
  assert.throws(() => decryptSecret(sealed, randomBytes(32)));
  const body = Buffer.from('{"action":"created"}');
  const signature = `sha256=${createHmac("sha256", "hook-key").update(body).digest("hex")}`;
  assert.equal(verifySignature(body, signature, "hook-key"), true);
  assert.equal(verifySignature(Buffer.from("changed"), signature, "hook-key"), false);
  assert.equal(verifySignature(body, undefined, "hook-key"), false);
});
