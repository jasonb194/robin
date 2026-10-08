import { test } from "node:test";
import assert from "node:assert/strict";
import { accountConfirmationProvided, contentHash, installationTokenOptions, managedWorkflowsToCleanup, mayUpdateManagedWorkflow, oauthStateMatches, parseTrustedProxyCidrs, queueableInstallationId, revokeOAuthUserToken, safeWorkflowDiff, secretNamesToDelete, setupOriginAllowed, shouldReconcile, uniqueCookieValue, userCanConfigureInstallation, validLlmBaseUrl, validPublicUrl, verifyInstallationOwnership } from "./github-security.js";
import { validatePolicy } from "./policy.js";

test("OAuth setup accepts only an installation visible to the authorized user", () => {
  const installations = [{ id: 7, account: { id: 70, login: "acme", type: "Organization" } }];
  assert.equal(verifyInstallationOwnership(installations, 7).account.login, "acme");
  assert.throws(() => verifyInstallationOwnership(installations, 8), /cannot access this installation/);
});

test("only the user owner or an active organization admin can set account policy", () => {
  assert.equal(userCanConfigureInstallation({ id: 70, type: "User" }, { id: 70 }), true);
  assert.equal(userCanConfigureInstallation({ id: 70, type: "User" }, { id: 71 }), false);
  assert.equal(userCanConfigureInstallation({ id: 70, type: "Organization" }, { id: 71 }, { state: "active", role: "admin" }), true);
  assert.equal(userCanConfigureInstallation({ id: 70, type: "Organization" }, { id: 71 }, { state: "active", role: "member" }), false);
  assert.equal(userCanConfigureInstallation({ id: 70, type: "Organization" }, { id: 71 }, { state: "pending", role: "admin" }), false);
  assert.equal(userCanConfigureInstallation({ id: 70, type: "Organization" }, { id: 71 }), false);
  assert.equal(userCanConfigureInstallation({ id: 70, type: "Unknown" }, { id: 70 }, { state: "active", role: "admin" }), false);
  assert.deepEqual(secretNamesToDelete(["LLM_API_KEY", "LLM_API_KEY"]), ["LLM_API_KEY"]);
});

test("setup policy posts require exact same origin", () => {
  assert.equal(setupOriginAllowed("https://robin.example.test", "https://robin.example.test"), true);
  assert.equal(setupOriginAllowed("https://evil.example.test", "https://robin.example.test"), false);
  assert.equal(setupOriginAllowed(undefined, "https://robin.example.test"), false);
});

test("OAuth state is bound to the initiating browser and account confirmation is explicit", () => {
  const state = "A".repeat(43);
  assert.equal(oauthStateMatches(undefined, state), false);
  assert.equal(oauthStateMatches(state, undefined), false);
  assert.equal(oauthStateMatches("B".repeat(43), state), false);
  assert.equal(oauthStateMatches(state, state), true);
  assert.equal(accountConfirmationProvided(undefined), false);
  assert.equal(accountConfirmationProvided("no"), false);
  assert.equal(accountConfirmationProvided("yes"), true);
});

test("host authentication cookies reject duplicate cookie names", () => {
  assert.equal(uniqueCookieValue("__Host-robin_oauth_state=abc; other=ok", "__Host-robin_oauth_state"), "abc");
  assert.equal(uniqueCookieValue("__Host-robin_oauth_state=first; __Host-robin_oauth_state=attacker", "__Host-robin_oauth_state"), undefined);
  assert.equal(uniqueCookieValue("__Host-robin_setup=session", "__Host-robin_oauth_state"), undefined);
  assert.equal(uniqueCookieValue(undefined, "__Host-robin_setup"), undefined);
});

test("public callback requires HTTPS and LLM endpoints allow only HTTPS or loopback HTTP", () => {
  assert.equal(validPublicUrl("https://robin.example.test"), true);
  assert.equal(validPublicUrl("http://robin.example.test"), false);
  assert.equal(validLlmBaseUrl("https://api.example.test/v1"), true);
  assert.equal(validLlmBaseUrl("http://127.0.0.1:1234/v1"), true);
  assert.equal(validLlmBaseUrl("http://attacker.example.test/v1"), false);
  assert.equal(validLlmBaseUrl("https://user:password@api.example.test/v1"), false);
});

test("trusted proxy ranges require explicit IP/CIDR entries", () => {
  assert.equal(parseTrustedProxyCidrs(""), false);
  assert.deepEqual(parseTrustedProxyCidrs("127.0.0.1/32, 10.0.0.0/8"), ["127.0.0.1/32", "10.0.0.0/8"]);
  assert.throws(() => parseTrustedProxyCidrs("proxy.internal"), /IP addresses only/);
  assert.throws(() => parseTrustedProxyCidrs("10.0.0.1/40"), /prefix length/);
});

test("installation credentials are scoped to one repository and minimum write permissions", () => {
  assert.deepEqual(installationTokenOptions(12), { type: "installation", installationId: 12, permissions: { metadata: "read" } });
  assert.deepEqual(installationTokenOptions(12, "private-repo", true), {
    type: "installation", installationId: 12, repositoryNames: ["private-repo"],
    permissions: { contents: "write", workflows: "write", pull_requests: "write", actions: "write" },
  });
});

test("none mode cleans previous workflows, while initial none setup schedules no writes", () => {
  const none = validatePolicy({ mode: "none", selectors: [] });
  assert.equal(shouldReconcile(true, true, none, 0), false);
  assert.equal(shouldReconcile(true, true, none, 2), true);
  assert.equal(shouldReconcile(false, true, validatePolicy({ mode: "all", selectors: [] })), false);
  const managed = [{ repository: "acme/a" }, { repository: "acme/b" }];
  assert.deepEqual(managedWorkflowsToCleanup(managed, []), managed); // all -> none
  assert.deepEqual(managedWorkflowsToCleanup(managed, ["acme/a"]), [managed[1]]); // exclusion policy changes
});

test("managed files reject manual edits", () => {
  const desired = "Robin workflow\n";
  assert.equal(mayUpdateManagedWorkflow(null, desired, null), true);
  assert.equal(mayUpdateManagedWorkflow(desired, desired, null), true);
  assert.equal(mayUpdateManagedWorkflow("edited by owner", desired, "known-managed-hash"), false);
  assert.equal(mayUpdateManagedWorkflow("old managed file", desired, contentHash("old managed file")), true);
});

test("setup PR and branch diffs contain only the generated workflow", () => {
  assert.equal(safeWorkflowDiff([".github/workflows/robin-account.yml"]), true);
  assert.equal(safeWorkflowDiff([".github/workflows/robin-account.yml", ".github/workflows/other.yml"]), false);
  assert.equal(safeWorkflowDiff(["README.md"]), false);
  assert.equal(safeWorkflowDiff([]), false);
});

test("new repository and installation repository events queue reconciliation", () => {
  assert.equal(queueableInstallationId("repository", { action: "created", installation: { id: 77 } }), 77);
  assert.equal(queueableInstallationId("installation_repositories", { action: "added", installation: { id: 88 } }), 88);
  assert.equal(queueableInstallationId("issues", { installation: { id: 77 } }), null);
  assert.equal(queueableInstallationId("repository", { action: "created", installation: { id: "invalid" } }), null);
  assert.equal(queueableInstallationId("repository", { action: "created" }), null);
});

test("temporary OAuth access token is revoked through the authenticated GitHub endpoint", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(null, { status: 204 });
  };
  assert.equal(await revokeOAuthUserToken("client-id", "client-secret", "short-lived-token", fakeFetch), true);
  assert.equal(captured?.url, "https://api.github.com/applications/client-id/token");
  assert.equal(captured?.init?.method, "DELETE");
  assert.match(String((captured?.init?.headers as Record<string, string>).Authorization), /^Basic /);
  assert.equal(JSON.parse(String(captured?.init?.body)).access_token, "short-lived-token");
  assert.equal(await revokeOAuthUserToken("client-id", "client-secret", "token", async () => { throw new Error("network failure"); }), false);
});
