"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const readline = require("readline/promises");
const { Writable } = require("stream");
const { stdin, stdout } = require("process");
const { selectRepositories } = require("./repo-selection");

const MODES = ["all", "none", "all-but", "only"];
const SECRET_NAMES = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"];
const TEMPLATE_PATH = path.resolve(__dirname, "..", "templates", "robin.yml");
const normalize = (content) => content.replace(/\r\n/g, "\n").trimEnd() + "\n";
const accountHelp = `Usage:
  npx robin-review --org <owner> [options]
  npx robin-review --user <login> [options]

Options:
  --mode <all|none|all-but|only>   Repository review policy
  --select <name:repo|regex:expr>  Selector (repeatable; for all-but/only)
  --dry-run                        Preview without changing repositories
  --yes                            Skip the final confirmation prompt
  --skip-secrets                   Leave Actions secrets unchanged
  --help                           Show this help

If --mode is omitted, the policy is selected interactively. Exact names are
case-insensitive; regex patterns use RE2 syntax and match part of a repository
name. New repositories created later require rerunning this bootstrap.

Secrets are checked before values are requested and only missing values are used.
In non-interactive mode, provide environment variables for missing secrets with
--yes, or use --skip-secrets. Optional Cloudflare credentials are read from the
environment; provide both values if both secrets are missing.
`;

function parseSelector(value) {
  if (typeof value !== "string") throw new TypeError("selector must be a string");
  if (value.startsWith("name:")) return { type: "name", value: value.slice(5) };
  if (value.startsWith("regex:")) return { type: "regex", value: value.slice(6) };
  throw new TypeError(`invalid selector ${JSON.stringify(value)}; use name:<repo> or regex:<pattern>`);
}

function parseArgs(argv) {
  const options = { targetType: null, target: null, mode: null, selectors: [], dryRun: false, yes: false, skipSecrets: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--org" || arg === "--user") {
      if (options.targetType) throw new TypeError("choose either --org or --user");
      options.targetType = arg.slice(2);
      options.target = value();
    } else if (arg === "--mode") {
      options.mode = value();
    } else if (arg === "--select") {
      options.selectors.push(parseSelector(value()));
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--skip-secrets") {
      options.skipSecrets = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new TypeError(`unknown account bootstrap option: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.targetType || !options.target) throw new TypeError("provide --org <owner> or --user <login>");
  // Account names become GitHub API path segments. Restrict them to GitHub
  // login characters so dot segments or encoded path separators cannot change
  // which API resource the CLI requests.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(options.target)) {
    throw new TypeError("account owner/login must be a valid 1-39 character GitHub login");
  }
  if (options.mode && !MODES.includes(options.mode)) {
    throw new TypeError(`--mode must be one of: ${MODES.join(", ")}`);
  }
  if (options.mode && (options.mode === "all" || options.mode === "none") && options.selectors.length > 0) {
    throw new TypeError(`${options.mode} mode does not accept --select`);
  }
  return options;
}

function createGhAdapter(execFileSync = cp.execFileSync, environment = process.env) {
  const run = (args, input) => execFileSync("gh", args, {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(environment).filter(([name]) => !SECRET_NAMES.includes(name))),
    input,
    maxBuffer: 20 * 1024 * 1024,
  });
  const api = (endpoint) => JSON.parse(run(["api", endpoint]));
  return {
    authenticatedUser: () => api("user"),
    repositories: (type, target) => {
      const endpoint = type === "org"
        ? `orgs/${encodeURIComponent(target)}/repos?per_page=100&sort=full_name`
        : "user/repos?type=owner&per_page=100&sort=full_name";
      const pages = JSON.parse(run(["api", "--paginate", "--slurp", endpoint]));
      if (!Array.isArray(pages)) throw new Error("GitHub CLI returned an invalid repository page list");
      return pages.flatMap((page) => (Array.isArray(page) ? page : [page]));
    },
    getWorkflow: (repository) => {
      const endpoint = contentsEndpoint(repository);
      try {
        return api(endpoint);
      } catch (error) {
        const message = error && (error.stderr || error.message || String(error));
        if (/HTTP 404|Not Found/i.test(String(message))) return null;
        throw error;
      }
    },
    createWorkflow: (repository, content) => {
      const body = {
        message: "chore: install Robin review workflow",
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: repository.default_branch,
      };
      return JSON.parse(run(["api", "--method", "PUT", "--input", "-", contentsEndpoint(repository)], JSON.stringify(body)));
    },
    listRepositorySecrets: (repository) => {
      const result = run(["secret", "list", "--repo", repository.full_name, "--json", "name"]);
      return JSON.parse(result).map(({ name }) => name);
    },
    listOrganizationSecrets: (organization) => {
      const result = run(["secret", "list", "--org", organization, "--json", "name"]);
      return JSON.parse(result).map(({ name }) => name);
    },
    setRepositorySecret: (repository, name, value) => {
      run(["secret", "set", name, "--repo", repository.full_name, "--app", "actions"], value);
    },
    setOrganizationSecret: (organization, repositories, name, value) => {
      const repoNames = repositories.map((repository) => repository.name).join(",");
      run(["secret", "set", name, "--org", organization, "--repos", repoNames, "--app", "actions"], value);
    },
  };
}

function contentsEndpoint(repository) {
  const [owner, name] = String(repository.full_name || "").split("/");
  if (!owner || !name || repository.full_name.split("/").length !== 2) {
    throw new TypeError("repository has an invalid full_name");
  }
  const ref = repository.default_branch ? `?ref=${encodeURIComponent(repository.default_branch)}` : "";
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/.github/workflows/robin.yml${ref}`;
}

function safeSecretError(error, secretValue) {
  const message = error && (error.message || String(error));
  return typeof secretValue === "string" && secretValue.length > 0
    ? String(message).split(secretValue).join("[redacted]")
    : String(message);
}

async function collectPolicy(options, prompt, isInteractive) {
  let mode = options.mode;
  if (!mode) {
    if (!isInteractive) throw new TypeError("provide --mode when running without an interactive terminal");
    const answer = (await prompt(`Review policy (${MODES.join(" / ")}): `)).trim().toLowerCase();
    if (!MODES.includes(answer)) throw new TypeError(`invalid review policy ${JSON.stringify(answer)}`);
    mode = answer;
  }
  let selectors = options.selectors;
  if ((mode === "all-but" || mode === "only") && selectors.length === 0) {
    if (!isInteractive) throw new TypeError(`${mode} mode requires one or more --select values`);
    const answer = await prompt("Selectors (comma-separated name:<repo> or regex:<pattern>): ");
    selectors = answer.split(",").map((item) => parseSelector(item.trim()));
  }
  const policy = { mode, selectors };
  // Validate even before the GitHub CLI is called.
  selectRepositories([], policy);
  return policy;
}

async function promptSecret(message) {
  stdout.write(message);
  const hiddenOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const interface_ = readline.createInterface({ input: stdin, output: hiddenOutput, terminal: true });
  try {
    const value = await interface_.question("");
    stdout.write("\n");
    return value;
  } finally {
    interface_.close();
  }
}

function validateSecretValues(values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${name} must not be blank`);
    }
  }
  return values;
}

async function getSecretValues(options, prompt, readSecret, isInteractive, env, names) {
  if (options.skipSecrets) return null;
  const configured = names.filter((name) => env[name]);
  const cloudflareNeeded = names.some((name) => name.startsWith("CF_ACCESS_"));
  const missingCloudflareValues = names.filter((name) => name.startsWith("CF_ACCESS_") && !env[name]);
  if (missingCloudflareValues.length > 0) {
    throw new TypeError(`provide environment values for missing Cloudflare secret(s): ${missingCloudflareValues.join(", ")}`);
  }

  if (!isInteractive) {
    const missing = names.filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new Error(`non-interactive secret setup requires environment values for ${missing.join(", ")}, or --skip-secrets`);
    }
    if (!options.yes) throw new Error("non-interactive secret setup requires --yes or --skip-secrets");
    return validateSecretValues(Object.fromEntries(names.map((name) => [name, env[name]])));
  }

  const shouldSet = (await prompt(`Set missing Actions secrets now? [Y/n] `)).trim().toLowerCase();
  if (shouldSet === "n" || shouldSet === "no") return null;
  if (shouldSet && shouldSet !== "y" && shouldSet !== "yes") {
    throw new Error("answer yes or no to the Actions secrets prompt");
  }
  if (names.some((name) => !env[name]) && !readSecret) {
    throw new Error("hidden secret input is unavailable; use --skip-secrets or provide environment values");
  }
  const values = Object.fromEntries(configured.map((name) => [name, env[name]]));
  for (const name of names) {
    if (!values[name]) values[name] = await readSecret(`${name}: `);
  }
  return validateSecretValues(values);
}

async function prepareSecrets(options, repositories, dependencies) {
  const { gh, prompt, readSecret, write, isInteractive, env } = dependencies;
  if (repositories.length === 0 || options.skipSecrets) return { operations: [], skipped: 0 };
  const cloudflarePresent = Boolean(env.CF_ACCESS_CLIENT_ID || env.CF_ACCESS_CLIENT_SECRET);
  const candidateNames = [...SECRET_NAMES.slice(0, 3)];
  if (cloudflarePresent) candidateNames.push("CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET");
  let skipped = 0;
  const pending = [];
  if (options.targetType === "org") {
    let existing;
    try {
      existing = new Set(await gh.listOrganizationSecrets(options.target));
    } catch (error) {
      write(`Could not check existing organization secrets; preserving them and skipping automated secret setup (${error.message || String(error)}).`);
      return { operations: [], skipped: candidateNames.length };
    }
    const missing = candidateNames.filter((name) => !existing.has(name));
    skipped += candidateNames.length - missing.length;
    for (const name of missing) {
      pending.push({ scope: "org", name, repositories });
    }
  } else {
    for (const repository of repositories) {
      let existing;
      try {
        existing = new Set(await gh.listRepositorySecrets(repository));
      } catch (error) {
        write(`Could not check secrets for ${repository.full_name}; preserving them and skipping setup (${error.message || String(error)}).`);
        skipped += candidateNames.length;
        continue;
      }
      for (const name of candidateNames) {
        if (existing.has(name)) {
          skipped += 1;
          continue;
        }
        pending.push({ scope: "repo", name, repository });
      }
    }
  }
  const names = [...new Set(pending.map(({ name }) => name))];
  if (names.length === 0) return { operations: [], skipped };

  const values = await getSecretValues(options, prompt, readSecret, isInteractive, env, names);
  if (!values) return { operations: [], skipped, declined: true };
  const operations = pending.map((operation) => ({ ...operation, value: values[operation.name] }));
  return { operations, skipped };
}

async function executeSecretPlan(options, secretPlan, gh, write) {
  let configured = 0;
  let failed = 0;
  let skipped = secretPlan.skipped;
  const checkedScopes = new Map();
  for (const operation of secretPlan.operations) {
    try {
      // `gh secret set` is an upsert. Check again before writing each scope's
      // planned secrets to reduce the window in which a concurrent secret
      // change could be replaced.
      const scopeKey = operation.scope === "org" ? `org:${options.target}` : `repo:${operation.repository.full_name}`;
      if (!checkedScopes.has(scopeKey)) {
        const names = operation.scope === "org"
          ? await gh.listOrganizationSecrets(options.target)
          : await gh.listRepositorySecrets(operation.repository);
        checkedScopes.set(scopeKey, new Set(names));
      }
      const existing = checkedScopes.get(scopeKey);
      if (existing.has(operation.name)) {
        skipped += 1;
        continue;
      }
      if (operation.scope === "org") {
        await gh.setOrganizationSecret(options.target, operation.repositories, operation.name, operation.value);
      } else {
        await gh.setRepositorySecret(operation.repository, operation.name, operation.value);
      }
      existing.add(operation.name);
      configured += 1;
    } catch (error) {
      failed += 1;
      const target = operation.scope === "org" ? `organization ${options.target}` : operation.repository.full_name;
      write(`Could not confirm or set Actions secret ${operation.name} for ${target}: ${safeSecretError(error, operation.value)}.`);
    }
  }
  write(`Actions secret setup finished: ${configured} added, ${skipped} existing or skipped, ${failed} failed; existing values were preserved when detected.`);
  return { configured, skipped, failed };
}

async function workflowStatus(repository, gh, template) {
  if (repository.archived) return { status: "skipped", reason: "archived repository" };
  if (!repository.default_branch) return { status: "skipped", reason: "no default branch" };
  const existing = await gh.getWorkflow(repository);
  if (!existing) return { status: "create" };
  if (typeof existing.content === "string") {
    const decoded = Buffer.from(existing.content.replace(/\s/g, ""), "base64").toString("utf8");
    if (normalize(decoded) === normalize(template)) return { status: "current" };
  }
  return { status: "skipped", reason: "workflow file already exists; preserving it" };
}

async function runAccountReview(argv, dependencies = {}) {
  const options = parseArgs(argv);
  const write = dependencies.write || ((message) => stdout.write(`${message}\n`));
  if (options.help) {
    write(accountHelp.trimEnd());
    return { status: "help" };
  }
  const prompt = dependencies.prompt || (async (message) => {
    const interface_ = readline.createInterface({ input: stdin, output: stdout });
    try { return await interface_.question(message); } finally { interface_.close(); }
  });
  const readSecret = dependencies.readSecret || promptSecret;
  const interactive = dependencies.isInteractive === undefined ? Boolean(stdin.isTTY) : dependencies.isInteractive;
  const policy = await collectPolicy(options, prompt, interactive);
  const gh = dependencies.gh || createGhAdapter();
  const template = dependencies.template === undefined ? fs.readFileSync(TEMPLATE_PATH, "utf8") : dependencies.template;

  if (options.targetType === "user") {
    const authenticated = await gh.authenticatedUser();
    if (!authenticated || typeof authenticated.login !== "string" || authenticated.login.toLowerCase() !== options.target.toLowerCase()) {
      throw new Error(`--user ${options.target} must match the authenticated GitHub CLI user`);
    }
  }

  if (policy.mode === "none") {
    write("Policy is none; no repositories will be changed.");
    return { status: "no-op", selected: [] };
  }

  const listed = await gh.repositories(options.targetType, options.target);
  const owned = options.targetType === "user"
    ? listed.filter((repo) => repo.owner && typeof repo.owner.login === "string" && repo.owner.login.toLowerCase() === options.target.toLowerCase())
    : listed;
  const selected = selectRepositories(owned, policy);
  const eligibleCount = selected.filter((repo) => !repo.archived && repo.default_branch).length;
  write(`Found ${owned.length} accessible repositories; policy selected ${selected.length}, including ${eligibleCount} eligible for workflow setup.`);

  const plan = [];
  for (const repository of selected) {
    try {
      const result = await workflowStatus(repository, gh, template);
      plan.push({ repository, ...result });
    } catch (error) {
      plan.push({ repository, status: "failed", reason: error.message || String(error) });
    }
  }
  const toCreate = plan.filter(({ status }) => status === "create");
  for (const item of plan) {
    if (item.status === "create") write(`Will create Robin workflow in ${item.repository.full_name}.`);
    else if (item.status === "skipped") write(`Skip ${item.repository.full_name}: ${item.reason}.`);
    else if (item.status === "current") write(`${item.repository.full_name}: workflow is already current.`);
    else if (item.status === "failed") write(`Could not inspect ${item.repository.full_name}: ${item.reason}.`);
  }
  if (options.dryRun) {
    write(`Dry run: would create Robin workflow in ${toCreate.length} repositories.`);
    return { status: "dry-run", plan };
  }

  const secretCandidates = [
    ...plan.filter(({ status }) => status === "current").map(({ repository }) => repository),
    ...toCreate.map(({ repository }) => repository),
  ];
  const secretPlan = await prepareSecrets(options, secretCandidates, {
    gh,
    prompt,
    readSecret,
    write,
    isInteractive: interactive,
    env: dependencies.env || process.env,
  });
  const secretChanges = secretPlan.operations.length > 0;
  if (toCreate.length === 0 && !secretChanges) {
    if (options.skipSecrets || secretPlan.declined) {
      write("Actions secrets were left unchanged. Add LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL as repository secrets, or organization secrets scoped to the intended repositories.");
    }
    write("No remote changes are needed.");
    return { status: "complete", plan, created: 0, failed: plan.filter(({ status }) => status === "failed").length, secrets: { configured: 0, skipped: secretPlan.skipped } };
  }
  if (!options.yes) {
    if (!interactive) throw new Error("remote changes require --yes or an interactive confirmation");
    const actionSummary = [
      toCreate.length ? `create workflows in ${toCreate.length} repositories` : "",
      secretChanges ? `add up to ${secretPlan.operations.length} missing Actions secrets` : "",
    ].filter(Boolean).join(" and ");
    const answer = (await prompt(`Proceed to ${actionSummary}? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      write("Cancelled; no repositories were changed.");
      return { status: "cancelled", plan };
    }
  }

  let created = 0;
  let failed = plan.filter(({ status }) => status === "failed").length;
  const successful = new Map(plan.filter(({ status }) => status === "current").map(({ repository }) => [repository.full_name, repository]));
  for (const { repository } of toCreate) {
    try {
      await gh.createWorkflow(repository, template);
      created += 1;
      successful.set(repository.full_name, repository);
      write(`Installed Robin workflow in ${repository.full_name}.`);
    } catch (error) {
      failed += 1;
      write(`Could not install in ${repository.full_name}: ${error.message || String(error)}.`);
    }
  }
  write(`Workflow setup finished: ${created} installed, ${failed} failed.`);
  const uniqueSuccessful = [...successful.values()];
  const successfulNames = new Set(uniqueSuccessful.map((repository) => repository.full_name));
  secretPlan.operations = secretPlan.operations.flatMap((operation) => {
    if (operation.scope === "org") {
      const repositories = operation.repositories.filter((repository) => successfulNames.has(repository.full_name));
      return repositories.length ? [{ ...operation, repositories }] : [];
    }
    return successfulNames.has(operation.repository.full_name) ? [operation] : [];
  });
  const secrets = secretPlan.operations.length
    ? await executeSecretPlan(options, secretPlan, gh, write)
    : { configured: 0, skipped: secretPlan.skipped };
  if (options.skipSecrets || secretPlan.declined) {
    write("Actions secrets were left unchanged. Add LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL as repository secrets, or organization secrets scoped to the intended repositories.");
  }
  if (secretPlan.skipped) write(`${secretPlan.skipped} existing secret(s) were preserved.`);
  write("New repositories created later require rerunning this bootstrap.");
  return { status: "complete", plan, created, failed, secrets };
}

module.exports = { accountHelp, collectPolicy, createGhAdapter, executeSecretPlan, parseArgs, parseSelector, prepareSecrets, runAccountReview, workflowStatus };

if (require.main === module) {
  runAccountReview(process.argv.slice(2)).catch((error) => {
    console.error(`Robin account bootstrap failed: ${error.message || String(error)}`);
    process.exitCode = 1;
  });
}
