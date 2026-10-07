import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const accountReview = (() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../bin/account-review.js") as {
    createGhAdapter: (execFileSync?: (...args: any[]) => any, environment?: Record<string, string>) => any;
    parseArgs: (argv: string[]) => any;
    parseSelector: (value: string) => { type: string; value: string };
    runAccountReview: (argv: string[], dependencies?: Record<string, any>) => Promise<any>;
    workflowStatus: (repository: any, gh: any, template: string) => any;
  };
})();

const {
  createGhAdapter,
  parseArgs,
  parseSelector,
  runAccountReview,
  workflowStatus,
} = accountReview;

const template = "name: Robin\n";
const repo = (name: string) => ({
  name,
  full_name: `acme/${name}`,
  default_branch: "main",
  archived: false,
  owner: { login: "acme" },
});
const createGh = (overrides: Record<string, any> = {}): any => ({
  authenticatedUser: jest.fn(async () => ({ login: "robin-user" })),
  repositories: jest.fn(async () => [repo("alpha")]),
  getWorkflow: jest.fn(async () => null),
  createWorkflow: jest.fn(async () => ({})),
  listRepositorySecrets: jest.fn(async () => []),
  listOrganizationSecrets: jest.fn(async () => []),
  setRepositorySecret: jest.fn(async () => undefined),
  setOrganizationSecret: jest.fn(async () => undefined),
  ...overrides,
});

describe("account review CLI parsing", () => {
  it("accepts account targets, repeated typed selectors, and safety flags", () => {
    expect(parseArgs(["--org", "acme", "--mode", "only", "--select", "name:API", "--select", "regex:^docs", "--yes"]))
      .toMatchObject({ targetType: "org", target: "acme", mode: "only", yes: true });
    expect(parseSelector("regex:^docs")).toEqual({ type: "regex", value: "^docs" });
    expect(() => parseSelector("legacy")).toThrow(/name:<repo> or regex:<pattern>/);
  });

  it("rejects account targets that cannot be a single GitHub login path segment", () => {
    for (const target of ["..", "../acme", "acme/other", "acme?admin=true", "."]) {
      expect(() => parseArgs(["--org", target, "--mode", "all"])).toThrow(/account owner\/login/);
    }
  });

  it("dispatches --help without falling through to local git installation", () => {
    const binary = path.resolve(__dirname, "..", "bin", "robin-review.js");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robin-account-help-"));
    try {
      const output = cp.execFileSync(process.execPath, [binary, "--help"], { cwd: directory, encoding: "utf8" });
      expect(output).toContain("--org <owner>");
      expect(output).toContain("New repositories created later require rerunning this bootstrap.");
      expect(output).not.toContain("Not a git repository");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes account-only flags to account argument validation", () => {
    const binary = path.resolve(__dirname, "..", "bin", "robin-review.js");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robin-account-invalid-"));
    try {
      expect(() => cp.execFileSync(process.execPath, [binary, "--mode", "all"], {
        cwd: directory,
        encoding: "utf8",
      })).toThrow(/provide --org <owner> or --user <login>/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("runAccountReview", () => {
  it("uses policy selectors to provision only matching repositories", async () => {
    const gh = createGh({ repositories: jest.fn(async () => [repo("api"), repo("docs")]) });
    await runAccountReview(["--org", "acme", "--mode", "only", "--select", "regex:api", "--yes", "--skip-secrets"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
    });
    expect(gh.createWorkflow).toHaveBeenCalledTimes(1);
    expect(gh.createWorkflow.mock.calls[0][0].name).toBe("api");
  });

  it("treats none as a no-op without listing or changing repositories", async () => {
    const gh = createGh();
    const result = await runAccountReview(["--org", "acme", "--mode", "none"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
    });
    expect(result.status).toBe("no-op");
    expect(gh.repositories).not.toHaveBeenCalled();
    expect(gh.createWorkflow).not.toHaveBeenCalled();
  });

  it("does not write in dry-run mode", async () => {
    const gh = createGh();
    const output: string[] = [];
    const result = await runAccountReview(["--org", "acme", "--mode", "all", "--dry-run"], {
      gh,
      template,
      write: (line: string) => output.push(line),
      isInteractive: false,
    });
    expect(result.status).toBe("dry-run");
    expect(output).toContain("Will create Robin workflow in acme/alpha.");
    expect(gh.createWorkflow).not.toHaveBeenCalled();
    expect(gh.listOrganizationSecrets).not.toHaveBeenCalled();
  });

  it("rejects blank required secret values before making remote changes", async () => {
    const gh = createGh();
    await expect(runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { LLM_API_KEY: "   ", LLM_BASE_URL: "url-value", LLM_MODEL: "model-value" },
    })).rejects.toThrow(/LLM_API_KEY must not be blank/);
    expect(gh.createWorkflow).not.toHaveBeenCalled();
    expect(gh.setOrganizationSecret).not.toHaveBeenCalled();
  });

  it("does not require or prompt for secret values when the target already has every secret", async () => {
    const gh = createGh({
      getWorkflow: jest.fn(async () => ({ content: Buffer.from(template).toString("base64") })),
      listOrganizationSecrets: jest.fn(async () => ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]),
    });
    const prompt = jest.fn();
    const result = await runAccountReview(["--org", "acme", "--mode", "all"], {
      gh,
      template,
      prompt,
      write: jest.fn(),
      isInteractive: false,
      env: {},
    });
    expect(result.status).toBe("complete");
    expect(prompt).not.toHaveBeenCalled();
    expect(gh.setOrganizationSecret).not.toHaveBeenCalled();
    expect(gh.createWorkflow).not.toHaveBeenCalled();
  });

  it("requires only missing secret values in a non-interactive run", async () => {
    const gh = createGh({
      listOrganizationSecrets: jest.fn()
        .mockResolvedValueOnce(["LLM_API_KEY", "LLM_BASE_URL"])
        .mockResolvedValueOnce(["LLM_API_KEY", "LLM_BASE_URL"]),
    });
    await runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { LLM_MODEL: "openrouter/free" },
    });
    expect(gh.setOrganizationSecret).toHaveBeenCalledTimes(1);
    expect(gh.setOrganizationSecret.mock.calls[0][2]).toBe("LLM_MODEL");
  });

  it("accepts only the missing Cloudflare value when its counterpart already exists", async () => {
    const existing = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "CF_ACCESS_CLIENT_ID"];
    const gh = createGh({
      getWorkflow: jest.fn(async () => ({ content: Buffer.from(template).toString("base64") })),
      listOrganizationSecrets: jest.fn(async () => existing),
    });
    await runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { CF_ACCESS_CLIENT_SECRET: "cf-secret" },
    });
    expect(gh.setOrganizationSecret).toHaveBeenCalledTimes(1);
    expect(gh.setOrganizationSecret.mock.calls[0][2]).toBe("CF_ACCESS_CLIENT_SECRET");
    expect(gh.setOrganizationSecret.mock.calls[0][3]).toBe("cf-secret");
  });

  it("requires both Cloudflare values when both target secrets are missing", async () => {
    const existing = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"];
    const gh = createGh({
      getWorkflow: jest.fn(async () => ({ content: Buffer.from(template).toString("base64") })),
      listOrganizationSecrets: jest.fn(async () => existing),
    });
    await expect(runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { CF_ACCESS_CLIENT_ID: "cf-id" },
    })).rejects.toThrow(/CF_ACCESS_CLIENT_SECRET/);
    expect(gh.setOrganizationSecret).not.toHaveBeenCalled();
  });

  it("requires and honors an explicit interactive confirmation", async () => {
    const gh = createGh();
    const prompt = jest.fn().mockResolvedValueOnce("n").mockResolvedValueOnce("no");
    const output: string[] = [];
    const result = await runAccountReview(["--org", "acme", "--mode", "all"], {
      gh,
      template,
      prompt,
      write: (line: string) => output.push(line),
      isInteractive: true,
      readSecret: jest.fn(),
    });
    expect(result.status).toBe("cancelled");
    expect(output).toContain("Will create Robin workflow in acme/alpha.");
    expect(prompt.mock.calls[1][0]).toContain("create workflows in 1 repositories");
    expect(gh.createWorkflow).not.toHaveBeenCalled();
    expect(gh.setOrganizationSecret).not.toHaveBeenCalled();
  });

  it("verifies user scope and only lists repositories owned by that user", async () => {
    const owned = { ...repo("personal"), owner: { login: "robin-user" } };
    const gh = createGh({ repositories: jest.fn(async () => [owned, repo("shared")]) });
    await runAccountReview(["--user", "Robin-User", "--mode", "all", "--yes", "--skip-secrets"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
    });
    expect(gh.authenticatedUser).toHaveBeenCalledTimes(1);
    expect(gh.createWorkflow).toHaveBeenCalledTimes(1);
    expect(gh.createWorkflow.mock.calls[0][0].name).toBe("personal");

    const wrongUser = createGh({ authenticatedUser: jest.fn(async () => ({ login: "someone-else" })) });
    await expect(runAccountReview(["--user", "robin-user", "--mode", "all", "--yes"], {
      gh: wrongUser,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: {},
    })).rejects.toThrow(/must match the authenticated/);
    expect(wrongUser.repositories).not.toHaveBeenCalled();
  });

  it("paginates repositories through gh api --paginate --slurp", () => {
    const execFile = jest.fn((command, args) => {
      expect(command).toBe("gh");
      expect(args).toEqual(["api", "--paginate", "--slurp", "orgs/acme/repos?per_page=100&sort=full_name"]);
      return JSON.stringify([[repo("a")], [repo("b")]]);
    });
    expect(createGhAdapter(execFile).repositories("org", "acme").map(({ name }: any) => name)).toEqual(["a", "b"]);
  });

  it("preserves unrelated and customized existing workflow files and recognizes the canonical file", async () => {
    const repository = repo("alpha");
    expect((await workflowStatus(repository, { getWorkflow: () => null }, template)).status).toBe("create");
    expect((await workflowStatus(repository, { getWorkflow: () => ({ content: Buffer.from(template).toString("base64") }) }, template)).status)
      .toBe("current");
    expect(await workflowStatus(repository, { getWorkflow: () => ({ content: Buffer.from("name: Custom\n").toString("base64") }) }, template))
      .toMatchObject({ status: "skipped", reason: expect.stringContaining("preserving it") });
  });

  it("continues after per-repository workflow failures", async () => {
    const gh = createGh({
      repositories: jest.fn(async () => [repo("alpha"), repo("beta")]),
      createWorkflow: jest.fn(async (repository: any) => {
        if (repository.name === "alpha") throw new Error("branch protection");
        return {};
      }),
    });
    const result = await runAccountReview(["--org", "acme", "--mode", "all", "--yes", "--skip-secrets"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
    });
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(gh.createWorkflow).toHaveBeenCalledTimes(2);
  });

  it("includes workflow inspection failures in the final failed count", async () => {
    const gh = createGh({ getWorkflow: jest.fn(async () => { throw new Error("rate limited"); }) });
    const result = await runAccountReview(["--org", "acme", "--mode", "all", "--yes", "--skip-secrets"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
    });
    expect(result.failed).toBe(1);
    expect(gh.createWorkflow).not.toHaveBeenCalled();
  });

  it("sets missing organization secrets once, scopes them, and never logs secret values", async () => {
    const key = "super-secret-api-key";
    const baseUrl = "https://llm.example.invalid";
    const model = "private-model-id";
    const lines: string[] = [];
    const gh = createGh({ repositories: jest.fn(async () => [repo("alpha"), repo("beta")]) });
    await runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: (line: string) => lines.push(line),
      isInteractive: false,
      env: { LLM_API_KEY: key, LLM_BASE_URL: baseUrl, LLM_MODEL: model },
    });
    expect(gh.listOrganizationSecrets).toHaveBeenCalledTimes(4);
    expect(gh.setOrganizationSecret).toHaveBeenCalledTimes(3);
    expect(gh.setOrganizationSecret.mock.calls[0][1].map(({ name }: any) => name)).toEqual(["alpha", "beta"]);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.join("\n")).not.toContain(baseUrl);
    expect(lines.join("\n")).not.toContain(model);
  });

  it("can set missing secrets on an already-current workflow without rewriting it", async () => {
    const gh = createGh({
      getWorkflow: jest.fn(async () => ({ content: Buffer.from(template).toString("base64") })),
    });
    await runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { LLM_API_KEY: "key-value", LLM_BASE_URL: "url-value", LLM_MODEL: "model-value" },
    });
    expect(gh.createWorkflow).not.toHaveBeenCalled();
    expect(gh.listOrganizationSecrets).toHaveBeenCalledTimes(4);
    expect(gh.setOrganizationSecret).toHaveBeenCalledTimes(3);
  });

  it("sets user secrets repository-by-repository and preserves existing names", async () => {
    const gh = createGh({
      authenticatedUser: jest.fn(async () => ({ login: "robin-user" })),
      repositories: jest.fn(async () => [{ ...repo("personal"), owner: { login: "robin-user" } }]),
      listRepositorySecrets: jest.fn(async () => ["LLM_API_KEY"]),
    });
    await runAccountReview(["--user", "robin-user", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { LLM_API_KEY: "key-value", LLM_BASE_URL: "url-value", LLM_MODEL: "model-value" },
    });
    expect(gh.setRepositorySecret).toHaveBeenCalledTimes(2);
    expect(gh.setRepositorySecret.mock.calls.map(([repository, name]: any[]) => [repository.name, name])).toEqual([
      ["personal", "LLM_BASE_URL"],
      ["personal", "LLM_MODEL"],
    ]);
  });

  it("passes Actions secret values only through stdin, never command arguments", () => {
    const secret = "do-not-show-this";
    const execFile = jest.fn<string, any[]>(() => "");
    createGhAdapter(execFile).setRepositorySecret(repo("alpha"), "LLM_API_KEY", secret);
    expect(execFile.mock.calls[0][1]).toEqual(["secret", "set", "LLM_API_KEY", "--repo", "acme/alpha", "--app", "actions"]);
    expect(execFile.mock.calls[0][2].input).toBe(secret);
    expect(JSON.stringify(execFile.mock.calls[0][1])).not.toContain(secret);
  });

  it("uses a selected-repositories organization secret command and stdin for values", () => {
    const secret = "org-secret-value";
    const execFile = jest.fn<string, any[]>(() => "");
    createGhAdapter(execFile).setOrganizationSecret("acme", [repo("alpha"), repo("beta")], "LLM_API_KEY", secret);
    expect(execFile.mock.calls[0][1]).toEqual([
      "secret", "set", "LLM_API_KEY", "--org", "acme", "--repos", "alpha,beta", "--app", "actions",
    ]);
    expect(execFile.mock.calls[0][2].input).toBe(secret);
    expect(JSON.stringify(execFile.mock.calls[0][1])).not.toContain(secret);
  });

  it("does not expose configured secrets to unrelated gh child processes", () => {
    const execFile = jest.fn<string, any[]>(() => "{}");
    const environment = {
      GH_TOKEN: "gh-auth-token",
      LLM_API_KEY: "llm-key",
      LLM_BASE_URL: "llm-url",
      LLM_MODEL: "llm-model",
      CF_ACCESS_CLIENT_ID: "cf-id",
      CF_ACCESS_CLIENT_SECRET: "cf-secret",
      PATH: "/usr/bin",
    };
    createGhAdapter(execFile, environment).authenticatedUser();
    expect(execFile.mock.calls[0][2].env).toEqual({ GH_TOKEN: "gh-auth-token", PATH: "/usr/bin" });
  });

  it("rechecks secret names before every write to preserve newly-created values", async () => {
    const gh = createGh({
      listOrganizationSecrets: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(["LLM_API_KEY", "LLM_BASE_URL"])
        .mockResolvedValueOnce(["LLM_API_KEY", "LLM_BASE_URL"]),
    });
    const plan = await runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { LLM_API_KEY: "key-value", LLM_BASE_URL: "url-value", LLM_MODEL: "model-value" },
    });
    expect(gh.listOrganizationSecrets).toHaveBeenCalledTimes(4);
    expect(gh.setOrganizationSecret).toHaveBeenCalledTimes(2);
    expect(gh.setOrganizationSecret.mock.calls.map((call: any[]) => call[2])).toEqual([
      "LLM_API_KEY",
      "LLM_MODEL",
    ]);
    expect(plan.secrets.skipped).toBe(1);
  });

  it("treats only a GitHub 404 as a missing workflow", () => {
    const missing = createGhAdapter(jest.fn(() => { throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { stderr: "gh: Not Found (HTTP 404)" }); }));
    expect(missing.getWorkflow(repo("alpha"))).toBeNull();
    const denied = createGhAdapter(jest.fn(() => { throw Object.assign(new Error("HTTP 403"), { stderr: "HTTP 403" }); }));
    expect(() => denied.getWorkflow(repo("alpha"))).toThrow(/403/);
  });

  it("preserves secrets if existing-secret discovery fails", async () => {
    const gh = createGh({ listOrganizationSecrets: jest.fn(async () => { throw new Error("permission denied"); }) });
    const result = await runAccountReview(["--org", "acme", "--mode", "all", "--yes"], {
      gh,
      template,
      write: jest.fn(),
      isInteractive: false,
      env: { LLM_API_KEY: "key-value", LLM_BASE_URL: "url-value", LLM_MODEL: "model-value" },
    });
    expect(result.secrets.configured).toBe(0);
    expect(gh.setOrganizationSecret).not.toHaveBeenCalled();
  });
});
