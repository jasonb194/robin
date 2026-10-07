import { RE2JS } from "re2js";

export type Selector = { type: "name" | "regex"; value: string };
export type Policy = { mode: "all" | "none" | "all-but" | "only"; selectors: Selector[] };

export function validatePolicy(value: unknown): Policy {
  if (!value || typeof value !== "object") throw new Error("policy must be an object");
  const raw = value as Record<string, unknown>;
  if (!["all", "none", "all-but", "only"].includes(String(raw.mode))) throw new Error("mode must be all, none, all-but, or only");
  if (!Array.isArray(raw.selectors)) throw new Error("selectors must be an array");
  const mode = raw.mode as Policy["mode"];
  if ((mode === "all" || mode === "none") && raw.selectors.length) throw new Error(`${mode} mode does not accept selectors`);
  if ((mode === "all-but" || mode === "only") && !raw.selectors.length) throw new Error(`${mode} mode requires at least one selector`);
  const selectors = raw.selectors.map((entry): Selector => {
    if (!entry || typeof entry !== "object") throw new Error("each selector must be an object");
    const item = entry as Record<string, unknown>;
    if ((item.type !== "name" && item.type !== "regex") || typeof item.value !== "string" || !item.value.trim()) throw new Error("selector needs type name/regex and nonempty value");
    if (item.value.length > 512) throw new Error("selector values must be 512 characters or fewer");
    if (item.type === "regex") {
      try { RE2JS.compile(item.value, RE2JS.CASE_INSENSITIVE); } catch { throw new Error(`invalid regex selector: ${item.value}`); }
    }
    return { type: item.type, value: item.value };
  });
  return { mode, selectors };
}

export function selectRepositories<T extends { name: string }>(repositories: T[], policy: Policy): T[] {
  const names = new Set(policy.selectors.filter((s) => s.type === "name").map((s) => s.value.toLowerCase()));
  const regexes = policy.selectors.filter((s) => s.type === "regex").map((s) => RE2JS.compile(s.value, RE2JS.CASE_INSENSITIVE));
  const matches = (name: string) => names.has(name.toLowerCase()) || regexes.some((re) => re.test(name));
  return repositories.filter((repo) => policy.mode === "all" || (policy.mode === "only" && matches(repo.name)) || (policy.mode === "all-but" && !matches(repo.name))).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name));
}
