import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveWorkflowTemplatePath } from "./workflow-template.js";

test("template resolver finds canonical template from repository root, controller directory, and Docker cwd", async () => {
  const root = "/repo";
  const cases = [
    { cwd: root, moduleDirectory: path.join(root, "controller/dist"), expected: path.join(root, "templates/robin.yml") },
    { cwd: path.join(root, "controller"), moduleDirectory: path.join(root, "controller/dist"), expected: path.join(root, "templates/robin.yml") },
    { cwd: "/app", moduleDirectory: "/app/dist", expected: "/app/templates/robin.yml" },
  ];
  for (const item of cases) {
    const result = await resolveWorkflowTemplatePath(item, async (candidate) => candidate === item.expected);
    assert.equal(result, item.expected);
  }
});

test("explicit template path is authoritative and missing default path is clear", async () => {
  assert.equal(await resolveWorkflowTemplatePath({ cwd: "/repo/controller", configuredPath: "../custom.yml", moduleDirectory: "/repo/controller/dist" }, async () => false), "/repo/custom.yml");
  await assert.rejects(resolveWorkflowTemplatePath({ cwd: "/tmp", moduleDirectory: "/tmp/app/dist" }, async () => false), /set ROBIN_WORKFLOW_TEMPLATE/);
});
