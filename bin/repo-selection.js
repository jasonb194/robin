"use strict";

const { RE2JS } = require("re2js");

const VALID_MODES = new Set(["all", "none", "all-but", "only"]);
const MAX_PATTERN_LENGTH = 512;

/**
 * Select repositories according to an account-level review policy.
 *
 * Name selectors compare repository.name case-insensitively. Regex selectors
 * use RE2JS, so matching has linear-time behavior even for untrusted patterns.
 * Results are sorted by repository name to stay stable across API page order.
 *
 * Regex selectors match any part of a name case-insensitively. only includes
 * matches to any selector; all-but excludes them. all/none reject selectors,
 * while only/all-but require at least one. The input array is not modified.
 *
 * @throws {TypeError} For invalid repositories, policies, or selectors, including
 * invalid RE2 patterns and regex values longer than 512 characters.
 * @param {Array<{name: string}>} repositories
 * @param {{mode: string, selectors?: Array<{type: string, value: string}>}} policy
 * @returns {Array<{name: string}>}
 */
function selectRepositories(repositories, policy) {
  if (!Array.isArray(repositories)) {
    throw new TypeError("repositories must be an array");
  }
  if (!policy || typeof policy !== "object" || !VALID_MODES.has(policy.mode)) {
    throw new TypeError("policy.mode must be one of: all, none, all-but, only");
  }

  const selectors = policy.selectors === undefined ? [] : policy.selectors;
  if (!Array.isArray(selectors)) {
    throw new TypeError("policy.selectors must be an array");
  }
  if ((policy.mode === "all" || policy.mode === "none") && selectors.length > 0) {
    throw new TypeError(`${policy.mode} mode does not accept selectors`);
  }
  if ((policy.mode === "all-but" || policy.mode === "only") && selectors.length === 0) {
    throw new TypeError(`${policy.mode} mode requires at least one selector`);
  }

  const nameSelectors = new Set();
  const regexSelectors = [];
  for (const selector of selectors) {
    if (!selector || typeof selector !== "object" || typeof selector.value !== "string") {
      throw new TypeError("each selector must have a type and string value");
    }
    const value = selector.value;
    if (value.trim().length === 0) {
      throw new TypeError("selector values must not be empty");
    }
    if (selector.type === "name") {
      nameSelectors.add(value.toLowerCase());
    } else if (selector.type === "regex") {
      if (value.length > MAX_PATTERN_LENGTH) {
        throw new TypeError(`regex selectors must be ${MAX_PATTERN_LENGTH} characters or fewer`);
      }
      try {
        regexSelectors.push(RE2JS.compile(value, RE2JS.CASE_INSENSITIVE));
      } catch (error) {
        throw new TypeError(`invalid regex selector ${JSON.stringify(value)}: ${error.message}`);
      }
    } else {
      throw new TypeError('selector.type must be "name" or "regex"');
    }
  }

  const matchesSelector = (repositoryName) => {
    if (nameSelectors.has(repositoryName.toLowerCase())) return true;
    return regexSelectors.some((pattern) => pattern.test(repositoryName));
  };

  for (const repository of repositories) {
    if (!repository || typeof repository.name !== "string" || repository.name.length === 0) {
      throw new TypeError("each repository must have a nonempty name");
    }
  }

  const sortedRepositories = repositories.slice().sort((left, right) => {
    const leftFolded = left.name.toLowerCase();
    const rightFolded = right.name.toLowerCase();
    if (leftFolded < rightFolded) return -1;
    if (leftFolded > rightFolded) return 1;
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });

  if (policy.mode === "all") return sortedRepositories;
  if (policy.mode === "none") return [];
  if (policy.mode === "only") return sortedRepositories.filter((repo) => matchesSelector(repo.name));
  return sortedRepositories.filter((repo) => !matchesSelector(repo.name));
}

module.exports = { selectRepositories };
