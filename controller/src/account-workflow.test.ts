import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_SECRET_NAMES, accountWorkflowTemplate, secretWasCreated } from "./account-workflow.js";

test("account workflow forwards only Robin-prefixed repository secret names", () => {
  const workflow = accountWorkflowTemplate("LLM: ${{ secrets.LLM_API_KEY }}\nCF: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}\n");
  assert.equal(workflow, "LLM: ${{ secrets.ROBIN_ACCOUNT_LLM_API_KEY }}\nCF: ${{ secrets.ROBIN_ACCOUNT_CF_ACCESS_CLIENT_SECRET }}\n");
  assert.equal(ACCOUNT_SECRET_NAMES.LLM_MODEL, "ROBIN_ACCOUNT_LLM_MODEL");
});

test("ownership is recorded only when GitHub reports secret creation", () => {
  assert.equal(secretWasCreated(201), true);
  assert.equal(secretWasCreated(204), false);
});
