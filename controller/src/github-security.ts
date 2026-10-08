import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Policy } from "./policy.js";

export type InstallationIdentity = { id: number; account: { id: number; login: string; type: string } };
/** Allow a personal account owner or an active organization admin; reject other account types. */
export function userCanConfigureInstallation(account: { id: number; type: string }, user: { id: number }, membership?: { state: string; role: string } | null): boolean {
  if (account.type === "User") return account.id === user.id;
  return account.type === "Organization" && membership?.state === "active" && membership.role === "admin";
}
/** Return true only for equal, nonempty 43-character base64url states from the cookie and query. */
export function oauthStateMatches(cookieState: string | undefined, queryState: string | undefined): boolean {
  if (!cookieState || !queryState || !/^[A-Za-z0-9_-]{43}$/.test(cookieState) || !/^[A-Za-z0-9_-]{43}$/.test(queryState)) return false;
  const cookie = Buffer.from(cookieState);
  const query = Buffer.from(queryState);
  return cookie.length === query.length && timingSafeEqual(cookie, query);
}
/** Accept only the literal form value "yes" as account confirmation. */
export function accountConfirmationProvided(value: string | undefined): boolean { return value === "yes"; }
/** Return the trimmed, undecoded cookie value, or undefined if absent, empty, or duplicated. */
export function uniqueCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let value: string | undefined;
  let found = false;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found) return undefined;
    found = true;
    value = part.slice(separator + 1).trim();
  }
  return found && value ? value : undefined;
}

/**
 * Return the first visible installation with the requested ID.
 * @throws If the authorized user's installation list does not contain that ID.
 */
export function verifyInstallationOwnership(installations: InstallationIdentity[], installationId: number): InstallationIdentity {
  const match = installations.find((installation) => installation.id === installationId);
  if (!match) throw new Error("The authorized GitHub account cannot access this installation");
  return match;
}

/** Compare parsed URL origins; return false for a missing origin or an invalid URL. */
export function setupOriginAllowed(origin: string | undefined, publicUrl: string): boolean {
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(publicUrl).origin; } catch { return false; }
}

/** Accept an HTTPS URL with a root path and no query, fragment, or credentials; invalid URLs return false. */
export function validPublicUrl(value: string): boolean {
  try { const parsed = new URL(value); return parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password; } catch { return false; }
}

/**
 * Parse comma-separated IP addresses or CIDRs, returning false for blank input.
 * @throws For empty entries, hostnames, malformed addresses, or prefix lengths
 * outside 0-32 for IPv4 or 0-128 for IPv6.
 */
export function parseTrustedProxyCidrs(value: string): false | string[] {
  if (!value.trim()) return false;
  const ranges = value.split(",").map((entry) => entry.trim());
  if (ranges.some((entry) => !entry)) throw new Error("TRUST_PROXY_CIDRS must contain comma-separated IP addresses or CIDRs");
  for (const range of ranges) {
    const parts = range.split("/");
    if (parts.length > 2) throw new Error("TRUST_PROXY_CIDRS contains an invalid CIDR");
    const family = isIP(parts[0]);
    if (!family) throw new Error("TRUST_PROXY_CIDRS accepts IP addresses only; hostnames are not allowed");
    if (parts.length === 2) {
      const bits = Number(parts[1]);
      if (!/^\d+$/.test(parts[1]) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error("TRUST_PROXY_CIDRS contains an invalid prefix length");
    }
  }
  return ranges;
}

/**
 * Accept HTTPS or HTTP to localhost, 127.0.0.1, or ::1, with no credentials or fragment.
 * Paths and queries are allowed; invalid URLs return false.
 */
export function validLlmBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname.toLowerCase());
  } catch { return false; }
}

/** True only when the changed-file list contains exactly the account workflow path once. */
export function safeWorkflowDiff(files: string[]): boolean {
  return files.length === 1 && files[0] === ".github/workflows/robin-account.yml";
}

/** Deduplicate caller-supplied owned secret names, preserving first occurrence order. */
export function secretNamesToDelete(ownedNames: string[]): string[] { return [...new Set(ownedNames)]; }

/**
 * Extract a positive safe integer installation ID from installation,
 * installation_repositories, or repository events, without filtering actions.
 * Numeric strings are accepted; unsupported events or invalid IDs return null.
 */
export function queueableInstallationId(event: string | undefined, payload: unknown): number | null {
  if (!["installation", "installation_repositories", "repository"].includes(String(event)) || !payload || typeof payload !== "object") return null;
  const installation = (payload as Record<string, unknown>).installation;
  if (!installation || typeof installation !== "object") return null;
  const id = Number((installation as Record<string, unknown>).id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Revoke the temporary user token using GitHub App client credentials.
 * Return true on a successful response or HTTP 404; other HTTP responses and
 * request failures return false.
 */
export async function revokeOAuthUserToken(clientId: string, clientSecret: string, accessToken: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    return response.ok || response.status === 404;
  } catch { return false; }
}

/**
 * Build metadata-only or workflow, content, pull-request, and Actions write permissions.
 * A nonempty repositoryName restricts the token to that repository; otherwise no
 * repository restriction is included.
 */
export function installationTokenOptions(installationId: number, repositoryName?: string, write = false) {
  return {
    type: "installation" as const,
    installationId,
    ...(repositoryName ? { repositoryNames: [repositoryName] } : {}),
    permissions: write ? { contents: "write", workflows: "write", pull_requests: "write", actions: "write" } : { metadata: "read" },
  };
}

/** Return the hexadecimal SHA-256 of the exact UTF-8 workflow text. */
export function contentHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** Allow a missing workflow or text whose hash matches the desired content or recorded prior content. */
export function mayUpdateManagedWorkflow(current: string | null, desired: string, priorHash: string | null): boolean {
  if (current === null) return true;
  const currentHash = contentHash(current);
  return currentHash === contentHash(desired) || (priorHash !== null && currentHash === priorHash);
}
/** Require an active installation and credentials; none mode runs only when managed records remain. */
export function shouldReconcile(active: boolean, hasCredentials: boolean, policy: Policy, managedCount = 0): boolean {
  return active && hasCredentials && (policy.mode !== "none" || managedCount > 0);
}

/** Return managed entries whose full repository names are absent from the selection, using exact comparison. */
export function managedWorkflowsToCleanup<T extends { repository: string }>(managed: T[], selectedRepositories: string[]): T[] {
  const selected = new Set(selectedRepositories);
  return managed.filter((entry) => !selected.has(entry.repository));
}
