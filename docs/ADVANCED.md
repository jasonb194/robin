# Advanced guide

This document is for maintainers and power users. For a short setup, see the [README](../README.md).

## GitHub App account controller

The GitHub App controller is Robin's one-time account installation path. Install the App
once for an organization or user account, set a repository policy, and the controller
configures matching repositories it can access. It also reconciles periodically and when
GitHub sends installation or repository events, so matching repositories created later are
picked up. This control plane is separate from the existing GitHub Action: review jobs
still run in each repository through Robin's reusable workflow.

Robin does not operate a hosted controller service. The package in `controller/` is a
self-hostable service; you provide its server, public HTTPS endpoint, PostgreSQL database,
and operations. The existing [bulk CLI bootstrap](#account-level-bootstrap) remains a
one-time alternative if you do not want to maintain a service.

### Register the GitHub App

Create a GitHub App for your GitHub.com account and set:

- **Webhook URL:** `https://<your-controller-host>/webhooks/github`
- **Webhook secret:** a generated secret matching `WEBHOOK_SECRET` in the controller
- **Setup URL:** `https://<your-controller-host>/setup`
- **Callback URL:** `https://<your-controller-host>/setup/callback` in the App's OAuth
  settings
- **Repository permissions:** Metadata (read), Contents (read and write), Actions (read
  and write), Workflows (write), and Pull requests (write)
- **Organization permissions:** Members (read), so setup can verify the signed-in user is
  an active organization admin before applying an account-wide policy
- **Subscribe to events:** `installation`, `installation_repositories`, and `repository`

At installation, grant the App access to **all repositories** in the organization or user
account. The App must be able to discover future repositories; the controller applies the
policy locally before writing a workflow. Granting access to all repositories does not
mean all repositories will be reviewed when the policy is `none`, `only`, or `all-but`.

The controller setup page asks the installing account to authorize access to the
installation, then presents the repository policy and LLM credentials. The user must own a
personal-account installation or be an active organization admin. The setup flow requests
`read:user read:org`, binds its one-time OAuth state to a short-lived secure browser cookie,
verifies org membership using the App's Organization Members (read) permission, and revokes
the temporary user token before saving a setup session. The form shows the verified account
and requires an explicit confirmation before accepting policy and credentials. The GitHub
App installation ID in a setup URL is not proof of authority. An organization owner must
approve the Members (read) permission when installing the App. Use an HTTPS deployment URL,
and configure GitHub's webhook endpoint and OAuth callback exactly as above.

### Repository policy

The setup form accepts four modes:

| Mode | Effect |
| --- | --- |
| `all` | Configure every eligible repository accessible to the App. |
| `none` | Do not configure any repositories. |
| `all-but` | Configure all eligible repositories except those matching a selector. |
| `only` | Configure only eligible repositories matching a selector. |

Selectors are entered one per line as `name:<repo>` or `regex:<pattern>`. Exact names are
case-insensitive and compare only the repository name, not `owner/name`. Regex patterns
use RE2 syntax, are case-insensitive, match any part of the name, and may contain up to
512 characters. `all` and `none` take no selectors; `all-but` and `only` require at least
one. For example, select `all-but` in the mode field and enter these selectors:

```text
name:website
regex:^archive-
```

Eligible repositories must be unarchived, enabled, and have a default branch. GitHub
installation scope still controls which repositories the App can see.

Enter an HTTPS LLM base URL. HTTP is accepted only for localhost or loopback test
endpoints; use TLS for external providers.

### Deploy with Docker Compose

The self-hostable deployment is in [`controller/`](../controller/). It runs the service
and PostgreSQL with a persistent database volume. Compose binds the controller to
`127.0.0.1:3000` by default. Put a TLS reverse proxy or equivalent HTTPS ingress in front
of it; configure `PUBLIC_URL` with that public HTTPS URL. The service expects GitHub's
webhooks and the setup OAuth callback to reach that URL.

```bash
cd controller
cp .env.example .env
```

Edit `.env` with the GitHub App credentials, webhook secret, public URL, and database
password. Generate the encryption key with `openssl rand -base64 32`; use it as
`ENCRYPTION_KEY`. Generate a separate strong `POSTGRES_PASSWORD`. Percent-encode its value
in `DATABASE_URL`, including literal `%` as `%25` and reserved characters such as `@` as
`%40`. Keep `POSTGRES_PASSWORD` unencoded for Docker Compose and quote it as needed by Compose's
`.env` syntax (single-quoted values preserve literal `$` characters). Both values must refer
to the same password. Keep `.env` private and
back up the PostgreSQL volume and encryption key separately. The database contains
encrypted LLM credentials and installation policy; losing the encryption key makes saved
credentials unreadable. Do not commit `.env` or put the App private key, OAuth secret,
webhook secret, or encryption key in a repository.

```bash
docker compose up -d --build
```

The required environment variables are:

| Variable | Purpose |
| --- | --- |
| `APP_ID` | GitHub App ID. |
| `APP_PRIVATE_KEY` | GitHub App private key PEM; literal `\n` line breaks are accepted. |
| `APP_CLIENT_ID` | GitHub App OAuth client ID. |
| `APP_CLIENT_SECRET` | GitHub App OAuth client secret. |
| `WEBHOOK_SECRET` | Secret used to verify GitHub webhook signatures. |
| `PUBLIC_URL` | Public HTTPS base URL, without a trailing slash. |
| `DATABASE_URL` | PostgreSQL connection URL. Percent-encode its password, including literal `%` as `%25` and reserved characters (for example, `@` as `%40`). Compose's example uses the `db` service. |
| `ENCRYPTION_KEY` | Base64 encoding of exactly 32 random bytes for stored credentials. |
| `POSTGRES_PASSWORD` | Database password used by the Compose PostgreSQL service. |
| `TRUST_PROXY_CIDRS` | Optional comma-separated IPs/CIDRs for trusted reverse proxies; empty by default. |

`PORT` defaults to `3000`. For a managed/external PostgreSQL service, set `DATABASE_URL`
accordingly and configure `PGSSL=true` when TLS is required by that service. The controller
does not provide TLS termination, hosting, backups, or key rotation. If the reverse proxy
connects from another address, set `TRUST_PROXY_CIDRS` to the exact proxy IP or CIDR ranges;
never trust broad or untrusted networks. The controller defaults to trusting no proxy
headers. Without a configured trusted proxy, clients behind one proxy share the same setup
rate-limit bucket. Back up the database and `ENCRYPTION_KEY` as a pair, restrict access to
both, and plan a maintenance window for key rotation because no automatic rotation workflow
is provided.

After deployment, create the App's installation link and install it on the target account.
The `/setup` page verifies the signed-in GitHub user's access to the selected installation
before accepting a policy and credentials. It then queues repository reconciliation.
`GET /healthz` reports service and database availability; webhook work is queued and
processed asynchronously, and periodic reconciliation repairs missed events. Check
container logs for per-repository conflicts or permission failures.

### Workflow and secret behavior

For each selected repository, the controller creates or updates
`.github/workflows/robin-account.yml` on the default branch. It only updates that path when
it finds Robin's managed marker and the file still matches the last version the controller
wrote. An unrelated file or a locally edited managed file is left untouched and reported
as a conflict. The generated workflow calls Robin's reusable workflow at `@main` and runs
on pull request open/reopen/ready-for-review plus new issue comments.

The controller first tries to write directly to the default branch. If GitHub rejects the
write with a branch-protection or repository-rule conflict, it creates or updates the
`robin/account-setup-<installation-id>` branch and opens a setup pull request against the
default branch. The installation-specific branch name avoids collisions between accounts;
the controller checks that an existing branch is its own before changing it. The App needs
Pull requests write permission for this fallback. Review and merge the setup PR to enable
Robin; the controller does not bypass repository rules. If a prior setup PR is closed
without merging, check the controller log and repository state before retrying.

LLM values are stored encrypted in PostgreSQL and set as repository Actions secrets using
GitHub's repository public key. The account workflow reads `ROBIN_ACCOUNT_LLM_API_KEY`,
`ROBIN_ACCOUNT_LLM_BASE_URL`, `ROBIN_ACCOUNT_LLM_MODEL`,
`ROBIN_ACCOUNT_CF_ACCESS_CLIENT_ID`, and `ROBIN_ACCOUNT_CF_ACCESS_CLIENT_SECRET`. Treat
these `ROBIN_ACCOUNT_*` names as reserved for the controller. Existing standard
`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `CF_ACCESS_CLIENT_ID`, and
`CF_ACCESS_CLIENT_SECRET` values are left untouched. Before writing each Robin secret, the
controller checks for that name and records ownership only when GitHub confirms a new
secret was created; an upsert/update response is treated as a conflict. GitHub's API does
not offer an atomic create-only operation, so a narrow race remains between the check and
write. If credentials change, update the `ROBIN_ACCOUNT_*` secrets manually when they
already exist.
If a reserved `ROBIN_ACCOUNT_*` secret exists but the controller has no ownership record
for it, setup stops for that repository and leaves the value untouched. Remove or rename
that secret manually, then retry setup. If GitHub creates a secret but PostgreSQL fails to
record ownership, the secret may remain untracked. Robin reports the failure without
deleting by name, since an administrator could replace the secret before cleanup. Remove or
rename the untracked secret manually, then retry setup.
User-account installations also use repository secrets, because ordinary repositories
cannot consume a user-level Actions secret.

When a repository stops matching the saved policy, the controller removes its generated
workflow only if the file still exactly matches the last version Robin wrote. It then
removes only `ROBIN_ACCOUNT_*` names it recorded as created by Robin. Existing standard or
pre-existing namespaced secrets are not recorded or deleted. If someone edited the
workflow, Robin preserves the edit and its associated secrets. A branch rule that blocks
workflow deletion also leaves the workflow and secrets in place and is reported in
controller logs; clean those up manually if needed. Do not edit the reserved
`ROBIN_ACCOUNT_*` secrets if you want Robin to remove them when their repository is
deselected.

Suspending the App pauses controller reconciliation but retains its encrypted credentials;
workflows already installed in repositories continue to run reviews while suspended. An
`unsuspend` event reactivates a configured installation and queues reconciliation. When the
App is uninstalled, the controller clears its stored credentials; GitHub access is revoked,
so generated workflow files and repository secrets may remain and continue running reviews.
Removing a repository from the App's installation scope can also leave its workflow and
secrets in place because the controller no longer has permission to clean them up. Remove
these files and secrets manually if you want to stop reviews. Per-repository failures do
not stop reconciliation of other repositories.

## Account-level bootstrap

The CLI bootstrap is a one-time fallback for users who do not want to deploy the GitHub App
controller. It installs the workflow and optionally configures Actions secrets in currently
accessible repositories; repositories created later require running the command again.

Use `npx robin-review --org <owner>` or `--user <login>` to bootstrap Robin across
repositories accessible to an organization or owned by a user. This is a bulk installer
that writes the workflow to each selected repository's default branch. It does not set up
an ongoing GitHub App or automatically enroll repositories created in the future; rerun
the command when you want to include those repositories.

The GitHub CLI (`gh`) must be installed and authenticated. The account needs access to
the selected repositories and permission to write their default branches. For `--user`,
the target login must match the authenticated `gh` account. Setting organization Actions
secrets also requires permission to manage those secrets in the organization. Check the
active login with `gh auth status` and authenticate with `gh auth login` if needed.

### Repository selection

Choose one of four policies with `--mode`:

| Mode | Effect |
| --- | --- |
| `all` | Select every repository returned for the target account. |
| `none` | Make no repository changes. |
| `all-but` | Select all repositories except those matching any selector. |
| `only` | Select repositories matching at least one selector. |

Pass repeatable `--select name:<repo>` or `--select regex:<pattern>` options with `all-but`
and `only`. Name matching is case-insensitive and compares the repository name (not
`owner/name`). Regex uses RE2 syntax, matches any part of the repository name, and is
limited to 512 characters. For example:

```bash
# Include all repositories except exact name `website` and names starting `archive-`
npx robin-review --org acme --mode all-but \
  --select name:website --select regex:^archive-

# Include only the `api` repository and names containing `service`
npx robin-review --org acme --mode only \
  --select name:api --select regex:service
```

In an interactive terminal, omit `--mode` to choose a policy at a prompt. If `all-but`
or `only` has no `--select` arguments, the installer prompts for selectors. In
non-interactive runs, pass `--mode` and supply selectors explicitly for those two modes.
`--dry-run` prints the workflow plan without writing workflows or setting secrets. The
installer previews the changes and asks for confirmation; `--yes` skips the final
confirmation.

### Workflow changes and exclusions

The installer lists repositories currently accessible from the account, then applies the
selection policy. It skips archived repositories and repositories without a default
branch. For each remaining selected repository, it creates
`.github/workflows/robin.yml` if that path is unused. If the file already contains the
current generated workflow, it leaves it as-is; any other existing file at that path is
preserved and reported as skipped. It does not open pull requests for these workflow
changes. Repository-level errors are reported while setup continues for other repos.

### Actions secrets

Unless `--skip-secrets` is given, the installer offers to add missing secrets after it
previews the workflow changes. It checks secret names before writing and skips names it
finds. For an organization,
each missing secret is added once as an organization Actions secret, scoped to repositories
with the current workflow or where workflow creation succeeds. For a user target, missing
secrets are set separately in each such repository because GitHub user-level Actions
secrets are not available for ordinary repositories. If the secret already exists at the
relevant scope, it is preserved; an existing organization secret's repository visibility
is not changed by this command. Check that existing organization secrets are scoped to the
selected repositories; otherwise those workflows cannot read them. GitHub secret writes
replace a value by name, so a concurrent admin change between the check and write can
still race; coordinate simultaneous secret setup.

The required values are `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`. Optional
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are read from environment variables;
provide both if both secrets are missing. In an interactive terminal, enter missing LLM
values at the hidden prompts or answer `n` to leave secrets unchanged. The installer
checks secret names before requesting any values and
does not ask for values when every target already has the configured secrets. Secret
values are passed to GitHub CLI through standard input and are not written to the
repository or printed in the installer's output. Use `--skip-secrets` to defer setup.

For non-interactive execution, provide environment values for any missing secrets and
`--yes`, or use `--skip-secrets`:

```bash
LLM_API_KEY='…' LLM_BASE_URL='https://openrouter.ai/api/v1' LLM_MODEL='openrouter/free' \
  npx robin-review --org acme --mode all --yes

npx robin-review --org acme --mode all --skip-secrets --yes
```

Optional Cloudflare credentials are read from environment variables. Existing values
found during the checks remain unchanged.

## Repository config file

Copy [`.github/robin.yml.example`](../.github/robin.yml.example) to `.github/robin.yml` on your default branch.

```yaml
max-diff-size: 25000
max-comments: 10
json-response-mode: true
request-changes: true
# reasoning-effort: high   # unset: no reasoning control is sent (provider default). Set low/medium/high/… to send it, or "off" to be explicit
# agent-mode: auto   # unset: single-shot diff review. Set auto for the multi-turn agent review
# agent-max-turns: 40
# agent-max-diff-size: 200000
skip-paths:
  - "**/generated/**"
```

| Key | Purpose |
| --- | --- |
| `max-diff-size` | Used when the workflow still passes the action default (`50000`) |
| `max-comments` | Used when the workflow still passes the action default (`15`) |
| `json-response-mode` | Used when `use-json-response-mode` is empty (action default defers to this file) |
| `request-changes` | Used when `request-changes` input is empty. `true` (default) blocks on high findings; `false` posts advisor-only comments |
| `reasoning-effort` | Used when the `reasoning-effort` action/workflow input is empty. Provider-dependent reasoning value; when both are unset no reasoning control is sent and the provider/model decides, `off` also sends no reasoning configuration |
| `agent-mode` | Used when the `agent-mode` input is empty. `auto` runs the [multi-turn agent review](#agent-mode-multi-turn-review-with-repository-context); when both are unset (or `off`) the single-shot diff review runs |
| `agent-max-turns` | Used when the `agent-max-turns` input is empty. Tool-calling turns before the final review is requested (default `40`, max `100`) |
| `agent-max-diff-size` | Used when the `agent-max-diff-size` input is empty. Diff characters sent up front in agent mode (default `200000`); `max-diff-size` still applies to the single-shot fallback |
| `skip-paths` | Extra paths removed from the diff before the LLM call |

Lockfiles (npm, yarn, pnpm, Cargo, Gemfile, poetry), `dist/`, `node_modules/`, and minified assets are always skipped automatically. If every changed file is skipped, the action posts a status comment and skips the LLM call.

The config file uses a small YAML subset (line-based keys only), not full YAML nesting.

## Pinning the action

| Ref | When to use |
| --- | --- |
| `@main` | Latest changes on the default branch |
| `@v1` | Latest `1.x` release (floating tag, updated each release) |
| `@v1.2.3` | Exact semver from [GitHub Releases](https://github.com/antongulin/robin/releases) |
| Full commit SHA | Maximum supply-chain safety in regulated environments |
| `@v0` | **Do not use** — outdated; workflows often fail |

```yaml
uses: antongulin/robin/.github/workflows/review.yml@v1
```

## Releases

Releases are automated with [Release Please](https://github.com/googleapis/release-please) (`.github/workflows/release.yml`):

1. Conventional commits on `main` accumulate in a **Release** pull request (`chore: release X.Y.Z`).
2. Release PRs are verified, merged, and published automatically by the workflow.
3. The workflow updates `package.json`, `CHANGELOG.md`, creates tag `vX.Y.Z`, and publishes [GitHub release notes](https://github.com/antongulin/robin/releases).
4. Floating tags `v1` and `v1.0` (major.minor) are updated so `@v1` stays current within the major version.

Maintainers: do not tag releases by hand unless the workflow failed; fix or rerun the workflow instead.

## Low-cost and free setups

### OpenRouter free router

| Secret | Value |
| --- | --- |
| `LLM_API_KEY` | OpenRouter API key |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | `openrouter/free` |

Smaller diffs help free models stay fast and accurate:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      max-diff-size: "25000"
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Save GitHub Actions minutes

- Leave `synchronize` out of the trigger (the shipped default) so Robin reviews once when the PR opens and you comment `/review` after fixes (see [Review every push (opt-in)](#review-every-push-opt-in)).
- Use a smaller `max-diff-size` for huge PRs.
- **Free tier:** GitHub Free includes about **2,000 Actions minutes/month** for public and private repos; GitHub Pro about **3,000 minutes/month** (limits can change — see [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) for your account).
- **Heavy usage:** use a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners) so LLM wait time does not consume hosted minutes.

To use a self-hosted runner with the reusable workflow, pass `runner` as valid JSON. A single label is a JSON string; multiple labels are a JSON array.

Coolify example:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      runner: '["self-hosted", "linux", "coolify"]'
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

## All workflow inputs

Available on the [direct action](../action.yml) and the [reusable workflow](../.github/workflows/review.yml), unless noted. LLM credentials are action inputs / reusable-workflow secrets respectively. For Cloudflare Access-protected LLM endpoints, create a Cloudflare Access service token and configure an Access application and policy for the proxy to require it, then set both optional `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` secrets; Robin sends them as service-token headers only on LLM requests. The headers alone do not turn on Access protection. These credentials require an `https://` base URL; `http://localhost` and loopback addresses are allowed for local testing.

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Token for PR API and comments (direct action only; reusable workflow uses `github.token`) |
| `llm-api-key` / `LLM_API_KEY` | `ollama` | Provider API key |
| `llm-base-url` / `LLM_BASE_URL` | — | OpenAI-compatible base URL (required) |
| `cf-access-client-id` / `CF_ACCESS_CLIENT_ID` | empty | Optional Cloudflare Access service-token client ID; set with its secret |
| `cf-access-client-secret` / `CF_ACCESS_CLIENT_SECRET` | empty | Optional Cloudflare Access service-token client secret; set with its ID |
| `model` / `LLM_MODEL` | — | Model name (required) |
| `fail-on-high` | `false` | Fail the check if high-severity issues are found |
| `request-changes` | omit → `true` (defer to repo config) | `true` submits a blocking REQUEST_CHANGES review on high findings; `false` posts a non-blocking COMMENT (advisor mode). Reusable workflow input is a boolean with no default — omit it to let `.github/robin.yml` win |
| `max-diff-size` | `50000` | Max diff characters sent to the model |
| `max-output-tokens` | empty | Cap response tokens (optional) |
| `reasoning-effort` | empty (defer to repo config; unset anywhere sends nothing) | Provider reasoning effort, provider-dependent (for example `low`, `medium`, `high`). Empty defers to `.github/robin.yml`; if that is also unset, no reasoning control is sent and the provider/model default applies. `off` also sends no reasoning configuration |
| `llm-timeout-ms` | `600000` | LLM timeout (10 minutes) |
| `llm-temperature` | `0.1` | Sampling temperature (0–2). Raise only if your model rejects the default — some models accept a single fixed value (Kimi requires `1`) |
| `max-comments` | `15` | Max inline comments |
| `review-on-synchronize` | `false` | Reusable workflow / action input. When the workflow triggers on `synchronize`, set `true` to review every push to an existing PR; default `false` skips pushes and re-reviews with `/review` |
| `runner` | `'"ubuntu-latest"'` | Reusable workflow only: runner as a JSON string or JSON array |
| `min-command-permission` | `write` | Who can run `/review` |
| `review-instructions` | empty | Extra prompt text |
| `review-instructions-file` | `.github/code-reviewer.md` | Rules file on the base branch |
| `config-file` | `.github/robin.yml` | Repo config path on the base branch |
| `use-json-response-mode` | empty (defer to repo config, else true) | Request strict JSON-schema output (`response_format: json_schema`) for reviews, stepping down to `json_object` and then to no `response_format` if the provider rejects it. Pass `"true"` / `"false"` on the reusable workflow |
| `agent-mode` | empty (defer to repo config, then single-shot) | `auto` lets the model read the repository with tools before reviewing, falling back to the single-shot diff review when the model has no tool support; unset or `off` always uses the single-shot review |
| `agent-max-turns` | empty (defer to repo config, then `40`) | Maximum tool-calling turns in agent mode (capped at 100) |
| `agent-max-diff-size` | empty (defer to repo config, then `200000`) | Diff characters sent up front in agent mode. The model reads any truncated files with its tools; `max-diff-size` still applies to the single-shot fallback |

## Agent mode (multi-turn review with repository context)

When enabled (`agent-mode: auto`), `/review` is a multi-turn conversation instead of a
single request. Agent mode is opt-in: when neither the input nor `.github/robin.yml` sets
`agent-mode`, Robin runs the classic single-shot diff review. Set `auto` to enable the
investigation below; set `off` to force the single-shot review.

1. Robin downloads the PR head commit as a tarball through the GitHub API and unpacks it
   into the runner's temp directory. No `actions/checkout` step is needed, and the code is
   only read, never executed.
2. The model gets the line-numbered diff plus three read-only tools: `read_file`, `grep`,
   and `list_files`. It uses them to read full files, find callers of changed functions,
   and look up definitions before it decides something is a bug.
3. When it has enough context it returns the usual JSON review. Findings can include an
   exact replacement for the affected lines, which Robin posts as a one-click GitHub
   **suggested change** when every line in the range is in the same diff hunk.

The defaults favor finding bugs over saving tokens, sized for frontier models with
200k-token or larger context windows:

| Limit | Default |
| --- | --- |
| Tool-calling turns | 40 (`agent-max-turns`, max 100) |
| Diff sent up front | 200k characters (`agent-max-diff-size`); the single-shot fallback keeps `max-diff-size` (50k) so small-context models still fit |
| Tool calls per turn | 16 |
| Investigation time | 30 minutes |
| Output per tool call | about 50k characters (`read_file` returns up to 2000 lines and says where to continue) |
| `grep` | 300 matches, optional `context_lines` (0-5), files up to 2 MB, up to 100k files scanned |
| `list_files` | 2000 entries |
| Repository snapshot | 500 MB compressed |

When the turn or time limit runs out, Robin asks the model for its final review without
tools.

**Context compaction.** The diff and the tool output kept in the conversation share a
budget of about 450k characters (roughly 115-150k tokens). Tool output always gets at least
150k of it, so the larger the diff, the sooner compaction starts. Once tool output passes
its share, or whenever the provider reports that the context window is full, Robin compacts the conversation the way Cursor does. The model writes
notes about the investigation so far: suspected bugs with evidence, facts it established,
what it already checked, and what's left. Robin then continues from those notes plus the
latest tool turn. If the summary request itself fails, Robin falls back to dropping the
oldest tool results. A review can compact up to six times.

**Fallback.** If the model or provider rejects tool calling (for example OpenRouter's
"No endpoints found that support tool use", or Ollama's "does not support tools"), the
snapshot download fails, or the agent loop errors, Robin logs a warning and runs the
single-shot diff review instead, so the PR still gets a review. `/summary` is always
single-shot.

Agent mode sends more tokens than a single-shot review (the model reads extra files) and
takes longer. The reusable workflow's job timeout is 45 minutes to leave room for a full
investigation plus the final answer. Lower `agent-max-turns` if you want faster or cheaper
reviews. Leave `agent-mode` unset (or set `agent-mode: off`) in `.github/robin.yml` to keep
diff-only reviews.

## Usage patterns

### Advisor mode (never block the PR)

Useful when Robin is an assistant and humans own merge decisions. Prefer `.github/robin.yml` for repo-wide defaults; use the workflow input to override per workflow:

```yaml
# .github/robin.yml
request-changes: false
```

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      request-changes: false   # boolean; omit this line to defer to .github/robin.yml
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Review every push (opt-in)

The shipped template reviews once when the PR opens (and on `/review`). To also review
every push to a PR, add `synchronize` to the trigger and set `review-on-synchronize: true`:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      review-on-synchronize: true
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Manual review only

Useful for public repos with many forks (controls when the LLM runs):

```yaml
on:
  issue_comment:
    types: [created]

jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Direct action (full control in one file)

```yaml
jobs:
  review:
    if: |
      github.event_name == 'pull_request' ||
      (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
        (
          startsWith(github.event.comment.body, '/review') ||
          startsWith(github.event.comment.body, '/robin') ||
          startsWith(github.event.comment.body, '/summary') ||
          startsWith(github.event.comment.body, '/help')
        )
      )
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: antongulin/robin@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-base-url: ${{ secrets.LLM_BASE_URL }}
          model: ${{ secrets.LLM_MODEL }}
          max-comments: "10"
```

### Strict mode (fail on high severity)

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      fail-on-high: true
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

If you raise `llm-timeout-ms` above 10 minutes, also raise the job `timeout-minutes`.

### Provider notes

Every provider is reached through the OpenAI chat-completions wire format. Robin
normalizes the base URL (trailing slash, a pasted `/chat/completions` or `/messages`
suffix, a missing `/v1` on the OpenAI and Anthropic hosts) and adjusts the request shape
for the hosts below. Self-hosted and proxy URLs are passed through unchanged.

| Provider | `LLM_BASE_URL` | Notes |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `reasoning-effort` is sent as OpenAI-native `reasoning_effort`. Reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5*`, `codex-*`) are sent without `temperature` and with `max_completion_tokens` instead of `max_tokens`, because they reject both |
| Anthropic (Claude) | `https://api.anthropic.com/v1` | Uses Anthropic's [OpenAI SDK compatibility](https://docs.anthropic.com/en/api/openai-sdk) endpoint with your regular Anthropic API key (`LLM_API_KEY`). `https://api.anthropic.com` without `/v1` is accepted. JSON mode sends Robin's review schema as a best-effort `response_format: json_schema`, but Anthropic's compatibility endpoint ignores `response_format` (guaranteed structured output requires the native Claude API), so the review relies on the prompt plus the markdown fallback parser. If a model rejects the field, Robin drops it and falls back the same way. Anthropic ignores reasoning controls — Robin sends none there and Claude picks its own thinking depth. `temperature` above `1` is capped by Anthropic |
| OpenRouter | `https://openrouter.ai/api/v1` | `reasoning-effort` uses the OpenRouter `reasoning: { effort, exclude }` object; router models get stall detection and provider fallbacks |
| Anything else (Groq, Ollama, vLLM, gateways) | provider URL | Default request shape; unsupported parameters are recovered as described below |

### Models that reject request parameters

Newer models refuse parameters older ones accepted — OpenAI reasoning models return
`Unsupported value: 'temperature' does not support 0.1 with this model` and
`Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead`. When a
400/422 response names one of the optional parameters Robin sent (`temperature`,
`max_tokens`, `max_completion_tokens`, `response_format`), Robin logs a warning, adjusts
that one parameter (omits `temperature`, renames the token cap between
`max_tokens`/`max_completion_tokens`, or steps `response_format` down from `json_schema` to `json_object`
and then drops it), re-sends once, and keeps the adjusted shape for the rest of the run.
Each parameter is adjusted at most once per run (`response_format` gets its one extra
step down), so a provider that keeps rejecting surfaces its real error instead of looping.
The token cap is never silently dropped: Robin tries the other field name first, and if the
endpoint rejects both spellings it surfaces the provider error rather than running uncapped.
A genuine token-limit **value** error (for example below a provider's minimum) surfaces too,
instead of being mistaken for an unsupported field.
Known OpenAI reasoning families skip the round trip and start with the right shape.

Dropping `temperature` or `response_format` is safe: the model falls back to its own default
sampling, and the review parser already handles non-JSON output. Auth, rate-limit, server,
and unrelated validation errors do not trigger this path.

### Models that require a fixed temperature

Robin samples at `0.1` so reviews stay near-deterministic. Some providers reject that and
accept only one value — Kimi models require `1`. Robin recovers automatically by
retrying without `temperature` (see above); set `llm-temperature` only when you want a
specific value sent rather than the model default:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      llm-temperature: "1"
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

Accepted range is 0–2. Out-of-range or non-numeric values log a warning and fall back to
`0.1`. Raising temperature makes findings less repeatable, so change it only when the
provider requires it. Re-running the installer preserves this and any other `with:`
overrides in your workflow.

### Reasoning effort (provider-dependent)

Some providers and models accept a reasoning-effort control. Robin sends none unless you
ask for one: when `reasoning-effort` is unset or whitespace everywhere, the request carries
no reasoning control and the provider/model default applies. Set a value to send it in the
provider's shape (below); set `off` to be explicit about sending nothing. Providers that do
not understand the control reject it and Robin falls back quietly (see the end of this
section).

Set it per repository in `.github/robin.yml` — the normal location, because reasoning is
configuration, not a credential:

```yaml
# .github/robin.yml
reasoning-effort: high   # or low / medium / a provider-specific name, or off
```

The workflow input overrides the repo config when non-empty, so consumers can scope an
effort to a single caller:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      reasoning-effort: "high"
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

Common values are `low`, `medium`, and `high`; exact names are provider-dependent (some
providers also use `minimal`, `xhigh`, or `max`). Robin forwards the trimmed value
unchanged. The request shape depends on the host in `LLM_BASE_URL`:

- `api.openai.com`: OpenAI-native `reasoning_effort: "<value>"`.
- `api.anthropic.com`: nothing is sent — Anthropic's compatibility endpoint ignores
  reasoning controls and Claude decides its own thinking depth. Robin logs this once.
- Everything else: OpenRouter-style `reasoning: { effort: "<value>", exclude: true }` —
  hidden reasoning is excluded from the response and never parsed; only the review text is
  used. Providers that expect a different native parameter reject it, and the fallback
  below then runs the review without reasoning controls.

If a provider rejects the parameter itself as unknown or unsupported, or clearly rejects
the configured effort value (a 400/422 response such as `Unsupported parameter: reasoning`
or `reasoning effort must be one of low, medium, high`), Robin logs a warning and retries
that completion once without the `reasoning` property. It then keeps running without a
reasoning override for the rest of the run. When the retry succeeds, the review completes
normally. If you set the value yourself (input or `.github/robin.yml`), the final status
comment also keeps a visible warning telling you to update `reasoning-effort`. With no value
configured, no reasoning control is sent in the first place, so this fallback only ever runs
for a value you configured.

Auth, rate-limit, server, timeout, and unrelated validation errors do not trigger this
fallback. The retry omits the optional reasoning override; it does not guess a different
provider-specific effort value.

## Review flow

1. PR opened, reopened, or marked ready for review → automatic review.
2. Status comment appears, then updates when done.
3. Author pushes fixes → no automatic re-review (by default).
4. Maintainer comments `/robin` or `/review` for another pass.

The action fetches diffs and, in agent mode, a read-only tarball of the PR head through the GitHub API. `actions/checkout` is not required unless other steps need local files.

## Model robustness

Robin is built to give good reviews even when the LLM is a weak, free, or
randomly-routed model (e.g. OpenRouter's free tier). The prompt and parser do the
heavy lifting so the model doesn't have to. If you change `src/prompts/`, keep these
constraints in mind — they are why reviews stay usable across models:

- **Line-numbered diff.** The diff sent to the model is annotated with real new-file
  line numbers (`src/diff-annotate.ts`), and the prompt tells the model to copy those
  exact numbers. Weak models are bad at counting lines; handing them the numbers keeps
  inline comments anchored to the right place instead of drifting or being dropped.
- **Few-shot severity calibration.** The prompt includes worked HIGH/MEDIUM/LOW/
  SUGGESTION examples plus an explicit rule: *impact ≠ confidence; never inflate
  severity*. Without calibration, weak models flag everything as HIGH. The examples
  pin the scale.
- **`confidence` field.** Each finding carries `high|medium|low` confidence separate
  from severity. The parser ignores invalid values, and the Robin skill uses confidence
  to decide how hard to verify a finding before acting on it. Severity orders effort;
  confidence gates trust.
- **"You only see the diff" guard.** The single-shot prompt reminds the model it sees
  changed lines only, not the whole file — so it doesn't invent bugs about code it can't
  see. The agent-mode prompt replaces this with "verify with the tools before flagging".
  The companion skill mirrors this: it treats findings as hypotheses to verify, not orders.
- **Graceful tool fallback.** Agent mode is only used when the model accepts tool calls;
  otherwise the same single-shot prompt runs, so weak or free models keep working.

The parser (`src/review-parser.ts`) is deliberately forgiving — it normalizes severity,
drops unparseable findings, and falls back to a markdown review if JSON mode fails — so a
malformed response from a weak model degrades instead of crashing the run.

## Security and privacy

PR diffs are sent to **your** configured LLM endpoint. In agent mode, any repository file the model reads with its tools is sent there too.

| Setup | Where code goes |
| --- | --- |
| Hosted API (OpenAI, Groq, OpenRouter, …) | That provider |
| Self-hosted Ollama | Your server |
| Self-hosted runner + local model | Your infrastructure |

Practices:

- Store keys in GitHub Secrets only.
- Use `permissions: actions: read`, `contents: read`, and `pull-requests: write`.
- Do not use `pull_request_target` with this action.
- Keep slash commands at `min-command-permission: write` unless you accept cost/abuse risk.
- Fork PRs from outsiders may not receive secrets — use manual `/review` from a maintainer.
- Agent-mode tools are read-only and confined to the extracted snapshot: paths and symlinks that resolve outside it are rejected, and PR code is never executed.

## Limits

No daily quota from this action. Real limits:

- GitHub Actions minutes (while the job waits on the model).
- Provider rate limits and model context size.
- `max-diff-size` truncation on very large PRs.

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| Workflow can't resolve `@v0` | Wrong tag | Use `@main` |
| `Connection refused` | Runner can't reach LLM URL | Public URL, tunnel, or self-hosted runner |
| `Input required: model` | Missing secret | Add `LLM_MODEL` |
| `Input required: llm-base-url` | Missing secret | Add `LLM_BASE_URL` |
| `Empty response from LLM` | Free/unstable model returned no text | Action retries with backoff; comment `/review` again |
| `OpenRouter stall: no first response` | Auto-router hung before picking a provider | Action retries every 45s (up to 5×); PR status comment updates each attempt |
| Job cancelled / 45 min with no review | Hung LLM or concurrency cancel while waiting | Status comment should say interrupted — comment `/robin` again; pin `@v2.0.4`+ for stall detect |
| `404 Provider returned error` | OpenRouter free route missed one provider | Keep `LLM_MODEL=openrouter/free` — action retries (5×) with provider fallbacks; no secret updates when models rotate |
| `Request timed out` | Large PR or slow free model | Lower `max-diff-size` or raise `llm-timeout-ms` (router models default to 2 min per attempt) |
| `temperature` / `max_tokens` / `response_format` rejected | Newer model refuses an optional parameter (OpenAI reasoning models, Kimi) | Action warns, retries once with the parameter renamed or omitted (`max_tokens` ↔ `max_completion_tokens`, `temperature` dropped), and keeps that shape for the run. If the endpoint rejects both token-cap spellings, the provider error surfaces instead of running uncapped. Set `llm-temperature` only to pin a specific value (Kimi: `1`) |
| `404` on `https://api.anthropic.com` | Base URL missing `/v1` on an older Robin | Use `https://api.anthropic.com/v1`; `@v2`/`@main` normalize it automatically |
| `reasoning-effort` rejected as unsupported or invalid | Provider/model does not accept the reasoning control or configured value | The action warns and retries once with no reasoning override. If that succeeds, the review completes; a user-set value also gets a status-comment notice to update `.github/robin.yml` or the workflow `with:` block. Set `reasoning-effort: off` to stop sending it |
| `Resource not accessible by integration` | Missing permissions | Add `pull-requests: write` |
| Slash command ignored | Wrong format or permission | `/robin` or `/review` as first line; need write access |
| `/robin` does nothing on `@v1` | Stale `v1` tag before v1.4.0 | Use `/review`, pin `@v1.4.0`+, or `@v2`; floating `v1` tracks latest `1.x` on release |
| Shallow review | Small model or truncated diff | Stronger model or higher `max-diff-size` |

## Comparison

| Option | Best when |
| --- | --- |
| Robin | You want any model/provider and no SaaS lock-in |
| GitHub Copilot review | You already pay for Copilot |
| Hosted review bots | You want a managed product |
| Custom scripts | You want full control and will maintain it |

## Roadmap

- `.github/robin.yml` config file
- Provider presets
- Large PR chunking by file
- GitHub App install flow
