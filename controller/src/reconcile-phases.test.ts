import { test } from "node:test";
import assert from "node:assert/strict";
import { processRepositoriesIndependently, summarizeRepositoryFailures } from "./reconcile-phases.js";

test("repository phases continue after individual failures and summarize bounded errors", async () => {
  const repositories = [{ full_name: "acme/a" }, { full_name: "acme/b" }, { full_name: "acme/c" }];
  const attempted: string[] = [];
  const providerToken = ["sk", "12345678901234567890"].join("-");
  const githubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz"].join("_");
  const failures = await processRepositoriesIndependently(repositories, "provision", async (repo) => {
    attempted.push(repo.full_name);
    if (repo.full_name !== "acme/b") return;
    throw new Error(`API rejected Bearer very-secret-value, ${providerToken}, and ${githubToken} ${"x".repeat(500)}`);
  });
  assert.deepEqual(attempted, repositories.map(({ full_name }) => full_name));
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Bearer \[redacted\]/);
  assert.doesNotMatch(failures[0].message, /very-secret-value/);
  assert.equal(failures[0].message.includes(providerToken), false);
  assert.equal(failures[0].message.includes(githubToken), false);
  assert.ok(failures[0].message.length <= 300);
  const summary = summarizeRepositoryFailures([...failures, ...Array.from({ length: 7 }, (_, index) => ({ repository: `acme/r${index}`, phase: "cleanup", message: "conflict" }))]);
  assert.ok(summary);
  assert.match(summary, /3 more failure\(s\) omitted/);
  assert.ok(summary.length <= 1800);
  assert.equal(summarizeRepositoryFailures([]), null);
});

test("nonstandard request errors are reduced to an HTTP status", async () => {
  class RequestError extends Error { status = 403; }
  const failures = await processRepositoriesIndependently([{ full_name: "acme/a" }], "cleanup", async () => {
    throw new RequestError("authorization header contains a sensitive token");
  });
  assert.equal(failures[0].message, "GitHub request failed (HTTP 403)");
});
