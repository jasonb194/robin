import Fastify from "fastify";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Pool } from "pg";
import sodium from "libsodium-wrappers";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret, encryptionKey, hash, randomToken, verifySignature } from "./crypto.js";
import { selectRepositories, validatePolicy, type Policy } from "./policy.js";
import { accountConfirmationProvided, contentHash, installationTokenOptions, managedWorkflowsToCleanup, mayUpdateManagedWorkflow, oauthStateMatches, parseTrustedProxyCidrs, queueableInstallationId, revokeOAuthUserToken, safeWorkflowDiff, secretNamesToDelete, setupOriginAllowed, shouldReconcile, uniqueCookieValue, userCanConfigureInstallation, validLlmBaseUrl, validPublicUrl, verifyInstallationOwnership } from "./github-security.js";
import { Store, type Installation } from "./store.js";
import { ACCOUNT_SECRET_NAMES, accountWorkflowTemplate, secretWasCreated, type AccountSecretKey } from "./account-workflow.js";

/** Read a required environment value, throwing if it is unset or empty. */
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const appId = required("APP_ID");
const privateKey = required("APP_PRIVATE_KEY").replace(/\\n/g, "\n");
const clientId = required("APP_CLIENT_ID");
const clientSecret = required("APP_CLIENT_SECRET");
const webhookSecret = required("WEBHOOK_SECRET");
const publicUrl = required("PUBLIC_URL").replace(/\/$/, "");
if (!validPublicUrl(publicUrl)) throw new Error("PUBLIC_URL must use HTTPS");
const encryptionSecret = encryptionKey(required("ENCRYPTION_KEY"));
const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 10, ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined });
const store = new Store(pool);
const app = Fastify({ logger: true, disableRequestLogging: true, bodyLimit: 1_000_000, trustProxy: parseTrustedProxyCidrs(process.env.TRUST_PROXY_CIDRS || "") });
app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("Cache-Control", "no-store");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return payload;
});
app.setErrorHandler((error, request, reply) => {
  // Never serialize request URLs, cookies, OAuth codes, or third-party error
  // objects that may contain authorization headers.
  app.log.error({ requestId: request.id, ...safeError(error) }, "request failed");
  return reply.code(500).send("Internal server error");
});

// Keep the exact bytes available for GitHub's HMAC signature check.
app.addContentTypeParser(["application/json", "application/x-www-form-urlencoded"], { parseAs: "buffer" }, (_request, body, done) => done(null, body));
app.get("/healthz", async (_request, reply) => {
  try { await pool.query("SELECT 1"); return { status: "ok" }; }
  catch { return reply.code(503).send({ status: "unavailable" }); }
});

app.get<{ Querystring: { installation_id?: string } }>("/setup", async (request, reply) => {
  const rateKey = hash(request.ip, clientSecret);
  if (!await store.allowSetupAttempt(rateKey)) return reply.code(429).send("Too many setup attempts; try again in ten minutes.");
  const id = Number(request.query.installation_id);
  if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send("Missing valid installation_id");
  const state = randomToken();
  await store.issueOAuthState(hash(state, clientSecret), id);
  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("client_id", clientId);
  redirect.searchParams.set("redirect_uri", `${publicUrl}/setup/callback`);
  redirect.searchParams.set("state", state);
  redirect.searchParams.set("scope", "read:user read:org");
  reply.header("Set-Cookie", `__Host-robin_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`);
  return reply.code(302).redirect(redirect.toString());
});

app.get<{ Querystring: { code?: string; state?: string } }>("/setup/callback", async (request, reply) => {
  const clearOAuthCookie = "__Host-robin_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  if (!oauthStateMatches(uniqueCookieValue(request.headers.cookie, "__Host-robin_oauth_state"), request.query.state)) return reply.code(400).send("OAuth state did not match this browser. Start setup again from the GitHub App installation page.");
  // Only clear a browser's in-progress flow after its state was matched. A
  // cross-site callback with a forged state must not cancel another tab's flow.
  reply.header("Set-Cookie", clearOAuthCookie);
  if (!request.query.code || !request.query.state) return reply.code(400).send("OAuth code and state are required");
  const id = await store.consumeOAuthState(hash(request.query.state, clientSecret));
  if (!id) return reply.code(400).send("Setup state is invalid or expired");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: request.query.code }),
  });
  const tokenBody = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) return reply.code(401).send("GitHub authorization failed");
  const userToken = tokenBody.access_token;
  const authorizedUser = new Octokit({ auth: userToken });
  let verified: { id: number; account: { id: number; login: string; type: string } } | null = null;
  let verificationError: string | null = null;
  try {
    const installationData = await authorizedUser.paginate(authorizedUser.apps.listInstallationsForAuthenticatedUser, { per_page: 100 });
  const visibleInstallations = (installationData as Array<any>).flatMap((item) => item.account && (item.account.login || item.account.slug)
    ? [{ id: item.id, account: { id: item.account.id, login: item.account.login || item.account.slug, type: item.account.type || "" } }]
      : []);
    verified = verifyInstallationOwnership(visibleInstallations, id);
    const { data: user } = await authorizedUser.users.getAuthenticated();
    let membership: { state: string; role: string } | null = null;
    if (verified.account.type === "Organization") {
      const result = await authorizedUser.orgs.getMembershipForUser({ org: verified.account.login, username: user.login });
      membership = { state: result.data.state, role: result.data.role };
    }
    if (!userCanConfigureInstallation(verified.account, user, membership)) verificationError = "Only the repository owner or an active organization owner/admin can configure Robin for this installation";
  } catch (error) { verificationError = error instanceof Error ? error.message : "Could not verify installation access for this GitHub account"; }
  // User access tokens are only needed for this ownership check. Revoke before
  // issuing a setup session or saving any credentials; never log the token.
  if (!await revokeOAuthUserToken(clientId, clientSecret, userToken)) {
    return reply.code(502).send("Robin could not revoke the temporary GitHub authorization, so setup was not saved. Revoke it in GitHub settings and retry.");
  }
  if (verificationError) return reply.code(403).send(verificationError);
  if (!verified) return reply.code(403).send(verificationError || "Installation access denied");
  const session = randomToken();
  await store.createSession(hash(session, clientSecret), id);
  reply.header("Set-Cookie", [clearOAuthCookie, `__Host-robin_setup=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`]);
  return reply.type("text/html; charset=utf-8").send(renderSetupForm(verified.account.login, verified.account.type));
});

app.post("/setup/policy", async (request, reply) => {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (!setupOriginAllowed(origin, publicUrl) || fetchSite === "cross-site") return reply.code(403).send("Setup request origin is not allowed");
  const cookie = uniqueCookieValue(request.headers.cookie, "__Host-robin_setup");
  if (!cookie) return reply.code(401).send("Setup session expired; start again from the GitHub App installation page.");
  const installationId = await store.sessionInstallation(hash(cookie, clientSecret));
  if (!installationId) return reply.code(401).send("Setup session expired; start again from the GitHub App installation page.");
  let form: Record<string, string>;
  try { form = parseForm(request.body as Buffer); } catch { return reply.code(400).send("Invalid setup form"); }
  let policy: Policy;
  try {
    const mode = form.mode;
    const selectors = (form.selectors || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const split = line.indexOf(":");
      if (split < 1) throw new Error("Selectors must use name:<repo> or regex:<pattern>, one per line");
      return { type: line.slice(0, split), value: line.slice(split + 1) };
    });
    policy = validatePolicy({ mode, selectors });
    if (!accountConfirmationProvided(form["confirm-account"])) throw new Error("Confirm the GitHub account shown above before saving setup");
    if (!form["llm-api-key"]?.trim() || !form["llm-base-url"]?.trim() || !form["llm-model"]?.trim()) throw new Error("LLM API key, base URL, and model are required");
    if (Boolean(form["cf-access-client-id"]) !== Boolean(form["cf-access-client-secret"])) throw new Error("Cloudflare Access client ID and secret must be set together");
    if (!validLlmBaseUrl(form["llm-base-url"])) throw new Error("LLM base URL must use HTTPS (HTTP is allowed only for localhost test endpoints)");
  } catch (error) { return reply.code(400).type("text/plain; charset=utf-8").send(error instanceof Error ? error.message : "Invalid setup form"); }
  const appAuth = await createAppAuth({ appId, privateKey })({ type: "app" });
  const appClient = new Octokit({ auth: appAuth.token });
  const { data: installation } = await appClient.apps.getInstallation({ installation_id: installationId });
  const encrypted = encryptSecret(JSON.stringify({ apiKey: form["llm-api-key"], baseUrl: form["llm-base-url"], model: form["llm-model"], cfClientId: form["cf-access-client-id"] || "", cfClientSecret: form["cf-access-client-secret"] || "" }), encryptionSecret);
  const account = installation.account as { id: number; login: string; type: string };
  await store.saveInstallation({ id: installationId, accountId: account.id, login: account.login, targetType: account.type, policy, credentials: encrypted });
  await store.enqueue(installationId);
  reply.header("Set-Cookie", "__Host-robin_setup=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return reply.type("text/html; charset=utf-8").send("<h1>Robin account setup saved</h1><p>Repositories matching your policy are being configured. Check the controller logs for repository conflicts.</p>");
});

app.post<{ Headers: { "x-hub-signature-256"?: string; "x-github-delivery"?: string; "x-github-event"?: string } }>("/webhooks/github", async (request, reply) => {
  const raw = request.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifySignature(raw, request.headers["x-hub-signature-256"], webhookSecret)) return reply.code(401).send("Invalid signature");
  const deliveryId = request.headers["x-github-delivery"];
  if (!deliveryId || deliveryId.length > 128) return reply.code(400).send("Missing delivery id");
  let payload: any;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return reply.code(400).send("Invalid JSON"); }
  const event = request.headers["x-github-event"];
  const installationId = queueableInstallationId(event, payload);
  if (!installationId) return reply.code(202).send({ accepted: true });
  if (event === "installation" && ["deleted", "suspend"].includes(payload.action)) {
    if (payload.action === "deleted") await store.uninstall(installationId);
    else await store.suspend(installationId);
    return reply.code(202).send({ accepted: true });
  }
  if (event === "installation" && payload.action === "unsuspend") {
    if (await store.reactivate(installationId)) await store.recordDeliveryAndEnqueue(deliveryId, installationId);
    return reply.code(202).send({ accepted: true });
  }
  if (event === "installation" && payload.action === "created") {
    // The OAuth flow creates policy and credentials; never infer opt-in from install alone.
    return reply.code(202).send({ accepted: true });
  }
  if (installationId) await store.recordDeliveryAndEnqueue(deliveryId, installationId);
  return reply.code(202).send({ accepted: true });
});

/** Render the account policy and credential form with the account login and type HTML-escaped. */
function renderSetupForm(login: string, type: string): string {
  const safe = escapeHtml(`${login} (${type})`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Set up Robin</title></head><body><main><h1>Configure Robin for ${safe}</h1><form method="post" action="/setup/policy">
    <label><input type="checkbox" name="confirm-account" value="yes" required> I confirm Robin should be configured for ${safe}.</label>
    <label>Repository policy <select name="mode"><option value="all">Review all repositories</option><option value="none">Review none</option><option value="all-but">Review all except selected repositories</option><option value="only">Review only selected repositories</option></select></label>
    <label>Selectors (one per line; name:repo or regex:pattern)<textarea name="selectors" rows="5"></textarea></label>
    <label>LLM API key <input name="llm-api-key" type="password" autocomplete="new-password" required></label>
    <label>LLM base URL <input name="llm-base-url" value="https://openrouter.ai/api/v1" required></label>
    <label>LLM model <input name="llm-model" value="openrouter/free" required></label>
    <label>Optional Cloudflare Access client ID <input name="cf-access-client-id" type="password"></label>
    <label>Optional Cloudflare Access client secret <input name="cf-access-client-secret" type="password"></label>
    <button type="submit">Save and configure repositories</button></form></main></body></html>`;
}
/** Escape ampersands, angle brackets, and both quote characters for HTML text or attributes. */
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
/** Decode a UTF-8 URL-encoded form; when keys repeat, keep the last value. */
function parseForm(body: Buffer): Record<string, string> { return Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries()); }

/**
 * Create an installation-authenticated GitHub client, optionally restricted to one repository.
 * Use metadata-only permissions unless write is true. Authentication failures propagate.
 */
function githubAppClient(installationId: number, repositoryName?: string, write = false): Promise<Octokit> {
  return createAppAuth({ appId, privateKey })(installationTokenOptions(installationId, repositoryName, write) as any).then((auth) => new Octokit({ auth: auth.token }));
}

/**
 * Return a bounded message for plain Error instances and a generic message for other errors.
 * Preserve a nonzero numeric status when present; plain Error messages are not redacted.
 */
function safeError(error: unknown): { message: string; status?: number } {
  const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
  if (error instanceof Error && error.constructor === Error) return { message: error.message.slice(0, 1000), ...(status ? { status } : {}) };
  return { message: status ? `GitHub request failed (HTTP ${status})` : "Unexpected controller error", ...(status ? { status } : {}) };
}

/**
 * Verify that a setup PR changes only robin-account.yml and its head content matches desiredHash.
 * Reject unsafe diffs or mismatched/non-file content; GitHub lookup failures propagate.
 */
async function assertSafeSetupPullRequest(client: Octokit, owner: string, repo: string, pull: { number: number; head: { sha: string } }, desiredHash: string): Promise<void> {
  const files = await client.paginate(client.pulls.listFiles, { owner, repo, pull_number: pull.number, per_page: 100 });
  if (!safeWorkflowDiff(files.map((file) => file.filename))) throw new Error(`${owner}/${repo}: setup PR contains unrelated file changes; leaving it unchanged`);
  const workflow = await client.repos.getContent({ owner, repo, path: ".github/workflows/robin-account.yml", ref: pull.head.sha });
  if (Array.isArray(workflow.data) || workflow.data.type !== "file" || contentHash(Buffer.from(workflow.data.content, "base64").toString("utf8")) !== desiredHash) throw new Error(`${owner}/${repo}: setup PR workflow does not match Robin's expected content`);
}

let workflowText = "";
const secretNames = Object.entries(ACCOUNT_SECRET_NAMES) as Array<[AccountSecretKey, string]>;

/**
 * Install or update the managed account workflow and add missing credential secrets.
 * Refuse workflow content that matches neither the desired nor recorded prior hash.
 * Direct-write HTTP 403, 409, or 422 failures trigger a setup branch/PR fallback;
 * existing setup branches and PRs must pass ownership and content checks.
 *
 * Record workflow ownership and secrets reported newly created with HTTP 201.
 * Existing secret names are skipped, but discovery and upsert are not atomic.
 * Ownership conflicts and remaining GitHub, database, or encryption errors propagate;
 * completed remote writes and ownership records are not rolled back.
 */
async function provisionRepo(installationId: number, client: Octokit, repo: { name: string; full_name: string; owner: { login: string }; default_branch: string }, credentials: Record<string, string>): Promise<void> {
  const owner = repo.owner.login;
  const name = repo.name;
  const desiredHash = contentHash(workflowText);
  const previous = await store.managedWorkflow(installationId, repo.full_name);
  let sha: string | undefined;
  let currentText: string | null = null;
  try {
    const current = await client.repos.getContent({ owner, repo: name, path: ".github/workflows/robin-account.yml", ref: repo.default_branch });
    if (Array.isArray(current.data) || current.data.type !== "file") throw new Error("workflow path is not a file");
    const decoded = Buffer.from(current.data.content, "base64").toString("utf8");
    currentText = decoded;
    if (!mayUpdateManagedWorkflow(decoded, workflowText, previous?.content_hash || null)) throw new Error(`${owner}/${name}: Robin workflow has local edits or is not managed; leaving it unchanged`);
    sha = current.data.sha;
  } catch (error: any) {
    if (error.status !== 404) throw error;
  }
  let pendingSetupPr = false;
  if (previous?.pull_request) {
    const prs = await client.pulls.list({ owner, repo: name, state: "open", head: `${owner}:${previous.setup_branch}`, base: repo.default_branch });
    const pendingPr = prs.data.find((pr) => pr.number === previous.pull_request);
    pendingSetupPr = Boolean(pendingPr);
    if (pendingPr) await assertSafeSetupPullRequest(client, owner, name, pendingPr, desiredHash);
    if (!pendingSetupPr && currentText && contentHash(currentText) === previous.content_hash) {
      await store.saveManagedWorkflow(installationId, repo.full_name, previous.content_hash);
    } else if (!pendingSetupPr) throw new Error(`${owner}/${name}: prior Robin setup PR is closed without the managed workflow; leaving it unchanged`);
  }
  try {
    if (!pendingSetupPr && currentText !== workflowText) {
      await client.repos.createOrUpdateFileContents({ owner, repo: name, path: ".github/workflows/robin-account.yml", message: "chore: manage Robin account review workflow", content: Buffer.from(workflowText).toString("base64"), branch: repo.default_branch, ...(sha ? { sha } : {}) });
    }
    if (!pendingSetupPr) await store.saveManagedWorkflow(installationId, repo.full_name, desiredHash);
  } catch (error: any) {
    // Direct writes can be blocked by branch protection or repository rules. Offer
    // a reviewable setup PR instead of weakening those controls.
    if (![403, 409, 422].includes(error.status)) throw error;
    const branch = `robin/account-setup-${installationId}`;
    const { data: baseRef } = await client.git.getRef({ owner, repo: name, ref: `heads/${repo.default_branch}` });
    let branchExists = false;
    try { await client.git.getRef({ owner, repo: name, ref: `heads/${branch}` }); branchExists = true; }
    catch (lookupError: any) { if (lookupError.status !== 404) throw lookupError; }
    if (branchExists && previous?.setup_branch !== branch) throw new Error(`${owner}/${name}: setup branch ${branch} already exists and is not managed by Robin; leaving it unchanged`);
    if (branchExists) {
      const comparison = await client.repos.compareCommits({ owner, repo: name, base: repo.default_branch, head: branch });
      if (!safeWorkflowDiff((comparison.data.files || []).map((file) => file.filename))) throw new Error(`${owner}/${name}: setup branch contains unrelated changes; leaving it unchanged`);
    }
    if (!branchExists) {
      await client.git.createRef({ owner, repo: name, ref: `refs/heads/${branch}`, sha: baseRef.object.sha });
      await store.saveManagedWorkflow(installationId, repo.full_name, desiredHash, branch, null);
    }
    let branchSha: string | undefined;
    let branchFileExists = false;
    let branchText: string | null = null;
    try {
      const branchFile = await client.repos.getContent({ owner, repo: name, path: ".github/workflows/robin-account.yml", ref: branch });
      if (!Array.isArray(branchFile.data) && branchFile.data.type === "file") {
        branchFileExists = true;
        branchText = Buffer.from(branchFile.data.content, "base64").toString("utf8");
        if (!mayUpdateManagedWorkflow(branchText, workflowText, previous?.content_hash || null)) throw new Error(`${owner}/${name}: setup branch has local edits; leaving it unchanged`);
        branchSha = branchFile.data.sha;
        if (branchText === workflowText) branchSha = undefined;
      } else throw new Error(`${owner}/${name}: setup workflow path is not a file; leaving it unchanged`);
    } catch (branchError: any) { if (branchError.status !== 404) throw branchError; }
    if (!branchFileExists || branchText !== workflowText) {
      await client.repos.createOrUpdateFileContents({ owner, repo: name, path: ".github/workflows/robin-account.yml", message: "chore: propose Robin account review workflow", content: Buffer.from(workflowText).toString("base64"), branch, ...(branchSha ? { sha: branchSha } : {}) });
    }
    const open = await client.pulls.list({ owner, repo: name, state: "open", head: `${owner}:${branch}`, base: repo.default_branch });
    const pr = open.data[0] || (await client.pulls.create({ owner, repo: name, title: "chore: install Robin review workflow", head: branch, base: repo.default_branch, body: "This setup PR adds the Robin account managed review workflow. Review and merge it to enable reviews for this repository." })).data;
    await assertSafeSetupPullRequest(client, owner, name, pr, desiredHash);
    await store.saveManagedWorkflow(installationId, repo.full_name, desiredHash, branch, pr.number);
  }
  const { data: key } = await client.actions.getRepoPublicKey({ owner, repo: name });
  await sodium.ready;
  for (const [credentialName, secretName] of secretNames) {
    const value = credentials[credentialName];
    if (!value) continue;
    const existing = await client.paginate(client.actions.listRepoSecrets, { owner, repo: name, per_page: 100 });
    if (existing.some((secret) => secret.name === secretName)) continue;
    const encrypted = sodium.crypto_box_seal(Buffer.from(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
    const result = await client.actions.createOrUpdateRepoSecret({ owner, repo: name, secret_name: secretName, encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL), key_id: key.key_id });
    if (!secretWasCreated(result.status)) throw new Error(`${repo.full_name}: ${secretName} already existed when Robin attempted to create it; it was not claimed for cleanup`);
    await store.recordManagedSecret(installationId, repo.full_name, secretName);
  }
}

/**
 * Remove an excluded repository's unchanged tracked workflow and recorded owned secrets.
 * Close its tracked open setup PR, leaving the branch intact. Preserve edited workflows
 * and their secrets while dropping ownership records. Without workflow ownership,
 * preserve an existing workflow and forget secret ownership; if absent, delete tracked secrets.
 *
 * Missing workflows or secrets (HTTP 404) permit cleanup to continue. Unsafe paths,
 * other GitHub failures, and database errors reject; cleanup may be partially applied.
 */
async function cleanupRepo(installationId: number, client: Octokit, repo: { name: string; full_name: string; owner: { login: string }; default_branch: string }): Promise<void> {
  const { owner, name } = { owner: repo.owner.login, name: repo.name };
  const deleteTrackedSecrets = async () => {
    for (const secretName of secretNamesToDelete(await store.listManagedSecrets(installationId, repo.full_name))) {
      try { await client.actions.deleteRepoSecret({ owner, repo: name, secret_name: secretName }); }
      catch (error: any) { if (error.status !== 404) throw new Error(`${repo.full_name}: could not remove Robin-managed Actions secret ${secretName}`); }
      await store.removeManagedSecret(installationId, repo.full_name, secretName);
    }
  };
  const previous = await store.managedWorkflow(installationId, repo.full_name);
  if (!previous) {
    const owned = await store.listManagedSecrets(installationId, repo.full_name);
    if (!owned.length) return;
    try {
      await client.repos.getContent({ owner, repo: name, path: ".github/workflows/robin-account.yml", ref: repo.default_branch });
      // Without the workflow ownership record, preserve both the file and its secrets.
      await store.forgetManagedSecrets(installationId, repo.full_name);
    } catch (error: any) {
      if (error.status !== 404) throw error;
      await deleteTrackedSecrets();
    }
    return;
  }
  if (previous.pull_request) {
    const prs = await client.pulls.list({ owner, repo: name, state: "open", head: `${owner}:${previous.setup_branch}`, base: repo.default_branch });
    const pending = prs.data.find((pr) => pr.number === previous.pull_request);
    if (pending) await client.pulls.update({ owner, repo: name, pull_number: pending.number, state: "closed" });
  }
  let content;
  try { content = await client.repos.getContent({ owner, repo: name, path: ".github/workflows/robin-account.yml", ref: repo.default_branch }); }
  catch (error: any) {
    if (error.status === 404) {
      await store.removeManagedWorkflow(installationId, repo.full_name);
      await deleteTrackedSecrets();
      return;
    }
    throw error;
  }
  if (Array.isArray(content.data) || content.data.type !== "file") throw new Error(`${repo.full_name}: cannot safely remove Robin workflow because the managed path is not a file`);
  const current = Buffer.from(content.data.content, "base64").toString("utf8");
  if (contentHash(current) !== previous.content_hash) {
    // Preserve owner edits, then stop claiming either the file or its secrets.
    await store.removeManagedWorkflow(installationId, repo.full_name);
    await store.forgetManagedSecrets(installationId, repo.full_name);
    return;
  }
  try {
    await client.repos.deleteFile({ owner, repo: name, path: ".github/workflows/robin-account.yml", message: "chore: remove excluded Robin account workflow", sha: content.data.sha, branch: repo.default_branch });
  } catch (error: any) {
    throw new Error(`${repo.full_name}: Robin workflow is no longer selected, but repository rules blocked its removal; remove it manually or allow the App to update workflow files${error?.status ? ` (HTTP ${error.status})` : ""}`);
  }
  await store.removeManagedWorkflow(installationId, repo.full_name);
  await deleteTrackedSecrets();
}

/**
 * Apply an active, credentialed installation's policy to accessible, eligible repositories.
 * Provision selected repositories, then clean up excluded tracked repositories; archived,
 * disabled, inaccessible, or branchless repositories retain their existing managed state.
 * None mode still cleans up tracked repositories. Database, authentication, policy,
 * credential-decryption/parsing, and repository operation failures propagate, stopping
 * this pass without rolling back completed work.
 */
async function reconcile(installation: Installation): Promise<void> {
  const managed = await store.managedRepositories(installation.id);
  if (!shouldReconcile(installation.active, Boolean(installation.credentials), installation.policy, managed.length)) return;
  const appClient = await githubAppClient(installation.id);
  const repositories = await appClient.paginate(appClient.apps.listReposAccessibleToInstallation, { per_page: 100 });
  const available = repositories.filter((repo) => !repo.archived && !repo.disabled && repo.default_branch).map((repo) => ({ name: repo.name, full_name: repo.full_name, owner: { login: repo.owner.login }, default_branch: repo.default_branch }));
  const selected = selectRepositories(available, installation.policy);
  if (selected.length > 0) {
    const credentialData = JSON.parse(decryptSecret(installation.credentials!, encryptionSecret)) as { apiKey: string; baseUrl: string; model: string; cfClientId: string; cfClientSecret: string };
    const credentials: Record<string, string> = { LLM_API_KEY: credentialData.apiKey, LLM_BASE_URL: credentialData.baseUrl, LLM_MODEL: credentialData.model, CF_ACCESS_CLIENT_ID: credentialData.cfClientId, CF_ACCESS_CLIENT_SECRET: credentialData.cfClientSecret };
    for (const repo of selected) {
      const client = await githubAppClient(installation.id, repo.name, true);
      await provisionRepo(installation.id, client, repo, credentials);
    }
  }
  const selectedNames = new Set(selected.map((repo) => repo.full_name));
  const byName = new Map(available.map((repo) => [repo.full_name, repo]));
  for (const repositoryName of managedWorkflowsToCleanup(managed.map((repository) => ({ repository })), [...selectedNames]).map((record) => record.repository)) {
    const repo = byName.get(repositoryName);
    if (!repo) continue; // Archived or no longer accessible: retain state and never guess at a write.
    const client = await githubAppClient(installation.id, repo.name, true);
    await cleanupRepo(installation.id, client, repo);
  }
}

let workerRunning = false;
/**
 * Process at most one queued job, returning immediately if this worker is already running.
 * Missing installations complete without reconciliation. Processing failures schedule a
 * retry; job-claim or retry-recording failures propagate. Always release the local worker guard.
 */
async function workOnce(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const job = await store.claimJob();
    if (!job) return;
    try {
      const installation = await store.getInstallation(job.installation_id);
      if (installation) await reconcile(installation);
      await store.finishJob(job.id);
    } catch (error) {
      const safe = safeError(error);
      app.log.error({ jobId: job.id, installationId: job.installation_id, ...safe }, "repository reconciliation failed");
      await store.failJob(job.id, job.attempts, safe.message);
    }
  } finally { workerRunning = false; }
}

/**
 * Load the workflow template, prepare database tables, prune expired state, and listen for HTTP.
 * Start job polling every second, pruning every hour, and reconciliation scheduling
 * every 15 minutes. Reject invalid port configuration and propagate template-read,
 * database, and server-listen failures.
 */
async function start(): Promise<void> {
  const templatePath = process.env.ROBIN_WORKFLOW_TEMPLATE || [path.resolve(process.cwd(), "templates/robin.yml"), path.resolve(process.cwd(), "../templates/robin.yml")].find((candidate) => candidate.endsWith("/templates/robin.yml"));
  if (!templatePath) throw new Error("ROBIN_WORKFLOW_TEMPLATE is required when templates/robin.yml is not in the working tree");
  const template = await readFile(templatePath, "utf8");
  workflowText = accountWorkflowTemplate(`# Managed by Robin account controller. Changes made here will stop automated updates.\n${template.replace(/^# Generated by robin-review.*(?:\r?\n|$)/m, "")}`);
  await store.migrate();
  await store.pruneExpired();
  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  await app.listen({ port, host: "0.0.0.0" });
  setInterval(() => { void workOnce(); }, 1000).unref();
  setInterval(() => { void store.pruneExpired().catch((error) => app.log.error(safeError(error), "expired setup-state cleanup failed")); }, 60 * 60 * 1000).unref();
  // Repair missed events and retry setup jobs after restarts.
  setInterval(async () => {
    try {
      const { rows } = await pool.query("SELECT id FROM installations WHERE active=true AND credentials IS NOT NULL");
      for (const row of rows) await store.enqueue(Number(row.id));
    } catch (error) { app.log.error({ ...safeError(error) }, "periodic reconciliation scheduling failed"); }
  }, 15 * 60 * 1000).unref();
}

if (process.env.NODE_ENV !== "test") void start().catch((error) => { app.log.error(safeError(error), "controller startup failed"); process.exitCode = 1; });
