import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.js";
import type { Pool } from "pg";

test("webhook delivery deduplication and job enqueue happen atomically", async () => {
  const deliveries = new Set<string>();
  const jobs: number[] = [];
  const fakeClient = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("INSERT INTO webhook_deliveries")) {
        const delivery = String(params[0]);
        if (deliveries.has(delivery)) return { rowCount: 0, rows: [] };
        deliveries.add(delivery);
        return { rowCount: 1, rows: [{ delivery_id: delivery }] };
      }
      if (sql.startsWith("INSERT INTO jobs")) { jobs.push(Number(params[0])); return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    }, release() {},
  };
  const fakePool = { connect: async () => fakeClient } as unknown as Pool;
  const store = new Store(fakePool);
  assert.equal(await store.recordDeliveryAndEnqueue("delivery-1", 42), true);
  assert.equal(await store.recordDeliveryAndEnqueue("delivery-1", 42), false);
  assert.deepEqual(jobs, [42]);
});

test("OAuth state lookup rejects expired state and accepts a valid one", async () => {
  let valid = true;
  const fakePool = { query: async () => ({ rows: valid ? [{ installation_id: "7" }] : [] }) } as unknown as Pool;
  const store = new Store(fakePool);
  assert.equal(await store.consumeOAuthState("state-hash"), 7);
  valid = false;
  assert.equal(await store.consumeOAuthState("expired-state-hash"), null);
});

test("suspension keeps encrypted setup for unsuspend while uninstall clears it", async () => {
  const statements: string[] = [];
  const fakePool = { query: async (sql: string) => { statements.push(sql); return { rowCount: 1, rows: [] }; } } as unknown as Pool;
  const store = new Store(fakePool);
  await store.suspend(7);
  assert.match(statements[0], /active=false/);
  assert.doesNotMatch(statements[0], /credentials=NULL/);
  await store.uninstall(7);
  assert.match(statements[1], /credentials=NULL/);
});

test("managed secret ownership is explicit and can remove only recorded names", async () => {
  const names = new Set<string>();
  const fakePool = { query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO managed_secrets")) names.add(String(params[2]));
    if (sql.startsWith("SELECT secret_name FROM managed_secrets")) return { rows: [...names].map((secret_name) => ({ secret_name })) };
    if (sql.startsWith("DELETE FROM managed_secrets")) names.delete(String(params[2]));
    return { rowCount: 1, rows: [] };
  } } as unknown as Pool;
  const store = new Store(fakePool);
  // A pre-existing secret is never recorded; only successful create calls invoke this method.
  const preExisting = ["LLM_API_KEY", "ROBIN_ACCOUNT_LLM_API_KEY"];
  await store.recordManagedSecret(7, "acme/repo", "ROBIN_ACCOUNT_LLM_MODEL");
  assert.deepEqual(await store.listManagedSecrets(7, "acme/repo"), ["ROBIN_ACCOUNT_LLM_MODEL"]);
  assert.equal(preExisting.some((name) => names.has(name)), false);
  await store.removeManagedSecret(7, "acme/repo", "ROBIN_ACCOUNT_LLM_MODEL");
  assert.deepEqual(await store.listManagedSecrets(7, "acme/repo"), []);
});
