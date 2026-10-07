import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Policy } from "./policy.js";

export type InstallationIdentity = { id: number; account: { id: number; login: string; type: string } };
export function userCanConfigureInstallation(account: { id: number; type: string }, user: { id: number }, membership?: { state: string; role: string } | null): boolean {
  if (account.type === "User") return account.id === user.id;
  return account.type === "Organization" && membership?.state === "active" && membership.role === "admin";
}
export function oauthStateMatches(cookieState: string | undefined, queryState: string | undefined): boolean {
  if (!cookieState || !queryState || !/^[A-Za-z0-9_-]{43}$/.test(cookieState) || !/^[A-Za-z0-9_-]{43}$/.test(queryState)) return false;
  const cookie = Buffer.from(cookieState);
  const query = Buffer.from(queryState);
  return cookie.length === query.length && timingSafeEqual(cookie, query);
}
export function accountConfirmationProvided(value: string | undefined): boolean { return value === "yes"; }
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

export function verifyInstallationOwnership(installations: InstallationIdentity[], installationId: number): InstallationIdentity {
  const match = installations.find((installation) => installation.id === installationId);
  if (!match) throw new Error("The authorized GitHub account cannot access this installation");
  return match;
}

export function setupOriginAllowed(origin: string | undefined, publicUrl: string): boolean {
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(publicUrl).origin; } catch { return false; }
}

export function validPublicUrl(value: string): boolean {
  try { const parsed = new URL(value); return parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password; } catch { return false; }
}

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

export function validLlmBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname.toLowerCase());
  } catch { return false; }
}

export function safeWorkflowDiff(files: string[]): boolean {
  return files.length === 1 && files[0] === ".github/workflows/robin-account.yml";
}

export function secretNamesToDelete(ownedNames: string[]): string[] { return [...new Set(ownedNames)]; }

export function queueableInstallationId(event: string | undefined, payload: unknown): number | null {
  if (!["installation", "installation_repositories", "repository"].includes(String(event)) || !payload || typeof payload !== "object") return null;
  const installation = (payload as Record<string, unknown>).installation;
  if (!installation || typeof installation !== "object") return null;
  const id = Number((installation as Record<string, unknown>).id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

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

export function installationTokenOptions(installationId: number, repositoryName?: string, write = false) {
  return {
    type: "installation" as const,
    installationId,
    ...(repositoryName ? { repositoryNames: [repositoryName] } : {}),
    permissions: write ? { contents: "write", workflows: "write", pull_requests: "write", actions: "write" } : { metadata: "read" },
  };
}

export function contentHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function mayUpdateManagedWorkflow(current: string | null, desired: string, priorHash: string | null): boolean {
  if (current === null) return true;
  const currentHash = contentHash(current);
  return currentHash === contentHash(desired) || (priorHash !== null && currentHash === priorHash);
}
export function shouldReconcile(active: boolean, hasCredentials: boolean, policy: Policy, managedCount = 0): boolean {
  return active && hasCredentials && (policy.mode !== "none" || managedCount > 0);
}

export function managedWorkflowsToCleanup<T extends { repository: string }>(managed: T[], selectedRepositories: string[]): T[] {
  const selected = new Set(selectedRepositories);
  return managed.filter((entry) => !selected.has(entry.repository));
}
