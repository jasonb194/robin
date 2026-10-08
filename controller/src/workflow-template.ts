import path from "node:path";
import { access } from "node:fs/promises";

export type PathExists = (filePath: string) => Promise<boolean>;

async function fileExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

export async function resolveWorkflowTemplatePath(input: {
  cwd: string;
  configuredPath?: string;
  moduleDirectory: string;
}, exists: PathExists = fileExists): Promise<string> {
  if (input.configuredPath !== undefined) return path.resolve(input.cwd, input.configuredPath);
  const candidates = [
    path.resolve(input.cwd, "templates/robin.yml"),
    path.resolve(input.cwd, "../templates/robin.yml"),
    path.resolve(input.moduleDirectory, "../templates/robin.yml"),
    path.resolve(input.moduleDirectory, "../../templates/robin.yml"),
  ];
  for (const candidate of [...new Set(candidates)]) if (await exists(candidate)) return candidate;
  throw new Error("Could not find templates/robin.yml; set ROBIN_WORKFLOW_TEMPLATE to its explicit path");
}
