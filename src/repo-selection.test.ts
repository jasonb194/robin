// eslint-disable-next-line @typescript-eslint/no-var-requires
const { selectRepositories } = require("../bin/repo-selection.js") as {
  selectRepositories: (
    repositories: Array<{ name: string }>,
    policy: { mode: string; selectors?: Array<{ type: string; value: string }> },
  ) => Array<{ name: string }>;
};

const repos = ["zeta", "API-service", "docs", "api-client"].map((name) => ({ name }));
const names = (repositories: Array<{ name: string }>) => repositories.map(({ name }) => name);

describe("selectRepositories", () => {
  it("selects all repositories in stable name order", () => {
    expect(names(selectRepositories(repos, { mode: "all" }))).toEqual([
      "api-client",
      "API-service",
      "docs",
      "zeta",
    ]);
  });

  it("selects no repositories", () => {
    expect(selectRepositories(repos, { mode: "none" })).toEqual([]);
  });

  it("selects only exact names case-insensitively", () => {
    expect(
      names(
        selectRepositories(repos, {
          mode: "only",
          selectors: [{ type: "name", value: "API-SERVICE" }],
        }),
      ),
    ).toEqual(["API-service"]);
  });

  it("selects regex partial matches case-insensitively", () => {
    expect(
      names(
        selectRepositories(repos, {
          mode: "only",
          selectors: [{ type: "regex", value: "api" }],
        }),
      ),
    ).toEqual(["api-client", "API-service"]);
  });

  it("excludes exact names and regex matches in all-but mode", () => {
    expect(
      names(
        selectRepositories(repos, {
          mode: "all-but",
          selectors: [
            { type: "name", value: "DOCS" },
            { type: "regex", value: "^api" },
          ],
        }),
      ),
    ).toEqual(["zeta"]);
  });

  it("rejects invalid modes, missing selectors, and empty selector values", () => {
    expect(() => selectRepositories(repos, { mode: "sometimes" })).toThrow(/policy\.mode/);
    expect(() => selectRepositories(repos, { mode: "only" })).toThrow(/requires at least one selector/);
    expect(() =>
      selectRepositories(repos, { mode: "only", selectors: [{ type: "name", value: "  " }] }),
    ).toThrow(/must not be empty/);
    expect(() => selectRepositories(repos, { mode: "all", selectors: [{ type: "name", value: "docs" }] })).toThrow(
      /does not accept selectors/,
    );
  });

  it("rejects invalid regex syntax and regex features outside RE2", () => {
    expect(() =>
      selectRepositories(repos, { mode: "only", selectors: [{ type: "regex", value: "[" }] }),
    ).toThrow(/invalid regex selector/);
    expect(() =>
      selectRepositories(repos, { mode: "only", selectors: [{ type: "regex", value: "(?=api)" }] }),
    ).toThrow(/invalid regex selector/);
  });

  it("handles catastrophic-backtracking-shaped patterns with RE2 linear matching", () => {
    const longName = `${"a".repeat(50_000)}!`;
    expect(
      selectRepositories([{ name: longName }], {
        mode: "only",
        selectors: [{ type: "regex", value: "(a+)+$" }],
      }),
    ).toEqual([]);
  });
});
