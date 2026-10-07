export type RepositoryFailure = { repository: string; phase: string; message: string };

function sanitizeMessage(error: unknown): string {
  let message = "Unexpected controller error";
  if (error instanceof Error && error.constructor === Error) message = error.message;
  else if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    message = `GitHub request failed (HTTP ${error.status})`;
  }
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}

export async function processRepositoriesIndependently<T extends { full_name: string }>(
  repositories: T[],
  phase: string,
  process: (repository: T) => Promise<void>,
): Promise<RepositoryFailure[]> {
  const failures: RepositoryFailure[] = [];
  for (const repository of repositories) {
    try { await process(repository); }
    catch (error) { failures.push({ repository: repository.full_name.slice(0, 200), phase, message: sanitizeMessage(error) }); }
  }
  return failures;
}

export function summarizeRepositoryFailures(failures: RepositoryFailure[]): string | null {
  if (failures.length === 0) return null;
  const shown = failures.slice(0, 5).map(({ repository, phase, message }) => `${repository} (${phase}): ${message}`);
  const omitted = failures.length - shown.length;
  const suffix = omitted > 0 ? `; ${omitted} more failure(s) omitted` : "";
  return `Repository reconciliation had ${failures.length} failure(s): ${shown.join("; ")}${suffix}`.slice(0, 1800);
}
