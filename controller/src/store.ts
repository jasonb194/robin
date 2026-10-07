import { Pool } from "pg";
import type { Policy } from "./policy.js";

export type Installation = { id: number; account_id: number; login: string; target_type: string; active: boolean; policy: Policy; credentials: string | null };
export type Job = { id: number; installation_id: number; attempts: number };
export type ManagedWorkflow = { repository: string; content_hash: string; setup_branch: string | null; pull_request: number | null };

export class Store {
  constructor(readonly pool: Pool) {}
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS installations (
        id BIGINT PRIMARY KEY, account_id BIGINT NOT NULL, login TEXT NOT NULL,
        target_type TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
        policy JSONB NOT NULL DEFAULT '{"mode":"all","selectors":[]}', credentials TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, installation_id BIGINT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_sessions (session_hash TEXT PRIMARY KEY, installation_id BIGINT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id TEXT PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS setup_rate_limits (ip_hash TEXT PRIMARY KEY, window_started TIMESTAMPTZ NOT NULL DEFAULT now(), attempts INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS jobs (id BIGSERIAL PRIMARY KEY, installation_id BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, run_after TIMESTAMPTZ NOT NULL DEFAULT now(), locked_at TIMESTAMPTZ, done_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS managed_workflows (installation_id BIGINT NOT NULL, repository TEXT NOT NULL, content_hash TEXT NOT NULL, setup_branch TEXT, pull_request INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(installation_id,repository));
      CREATE TABLE IF NOT EXISTS managed_secrets (installation_id BIGINT NOT NULL, repository TEXT NOT NULL, secret_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(installation_id,repository,secret_name));
      CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(run_after, id) WHERE done_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_open_per_installation ON jobs(installation_id) WHERE done_at IS NULL;
      CREATE INDEX IF NOT EXISTS setup_expiry_idx ON setup_sessions(expires_at);
    `);
  }
  async issueOAuthState(stateHash: string, id: number): Promise<void> { await this.pool.query("INSERT INTO oauth_states(state_hash,installation_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')", [stateHash,id]); }
  async allowSetupAttempt(ipHash: string): Promise<boolean> {
    const { rows } = await this.pool.query(`INSERT INTO setup_rate_limits(ip_hash,window_started,attempts) VALUES($1,now(),1) ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN setup_rate_limits.window_started<now()-interval '10 minutes' THEN 1 ELSE setup_rate_limits.attempts+1 END,window_started=CASE WHEN setup_rate_limits.window_started<now()-interval '10 minutes' THEN now() ELSE setup_rate_limits.window_started END RETURNING attempts`, [ipHash]);
    return Number(rows[0]?.attempts || 0) <= 20;
  }
  async pruneExpired(): Promise<void> {
    await this.pool.query("DELETE FROM oauth_states WHERE expires_at<now()");
    await this.pool.query("DELETE FROM setup_sessions WHERE expires_at<now()");
    await this.pool.query("DELETE FROM webhook_deliveries WHERE received_at<now()-interval '30 days'");
    await this.pool.query("DELETE FROM setup_rate_limits WHERE window_started<now()-interval '1 day'");
    await this.pool.query("DELETE FROM jobs WHERE done_at<now()-interval '30 days'");
  }
  async consumeOAuthState(stateHash: string): Promise<number | null> {
    const { rows } = await this.pool.query("DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING installation_id", [stateHash]);
    return rows[0] ? Number(rows[0].installation_id) : null;
  }
  async createSession(tokenHash: string, id: number): Promise<void> { await this.pool.query("INSERT INTO setup_sessions(session_hash,installation_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [tokenHash,id]); }
  async sessionInstallation(tokenHash: string): Promise<number | null> {
    const { rows } = await this.pool.query("SELECT installation_id FROM setup_sessions WHERE session_hash=$1 AND expires_at>now()", [tokenHash]);
    return rows[0] ? Number(rows[0].installation_id) : null;
  }
  async saveInstallation(input: { id: number; accountId: number; login: string; targetType: string; policy: Policy; credentials: string }): Promise<void> {
    await this.pool.query(`INSERT INTO installations(id,account_id,login,target_type,active,policy,credentials,updated_at) VALUES($1,$2,$3,$4,true,$5,$6,now()) ON CONFLICT(id) DO UPDATE SET account_id=EXCLUDED.account_id,login=EXCLUDED.login,target_type=EXCLUDED.target_type,active=true,policy=EXCLUDED.policy,credentials=EXCLUDED.credentials,updated_at=now()`, [input.id,input.accountId,input.login,input.targetType,JSON.stringify(input.policy),input.credentials]);
  }
  async getInstallation(id: number): Promise<Installation | null> {
    const { rows } = await this.pool.query("SELECT id,account_id,login,target_type,active,policy,credentials FROM installations WHERE id=$1", [id]);
    if (!rows[0]) return null;
    return { ...rows[0], id: Number(rows[0].id), account_id: Number(rows[0].account_id), policy: rows[0].policy };
  }
  async suspend(id: number): Promise<void> { await this.pool.query("UPDATE installations SET active=false,updated_at=now() WHERE id=$1", [id]); }
  async uninstall(id: number): Promise<void> { await this.pool.query("UPDATE installations SET active=false,credentials=NULL,updated_at=now() WHERE id=$1", [id]); }
  async reactivate(id: number): Promise<boolean> { const { rowCount } = await this.pool.query("UPDATE installations SET active=true,updated_at=now() WHERE id=$1 AND credentials IS NOT NULL", [id]); return Boolean(rowCount); }
  async managedWorkflow(id: number, repository: string): Promise<{ content_hash: string; setup_branch: string | null; pull_request: number | null } | null> {
    const { rows } = await this.pool.query("SELECT content_hash,setup_branch,pull_request FROM managed_workflows WHERE installation_id=$1 AND repository=$2", [id,repository]);
    return rows[0] || null;
  }
  async listManagedWorkflows(id: number): Promise<ManagedWorkflow[]> {
    const { rows } = await this.pool.query("SELECT repository,content_hash,setup_branch,pull_request FROM managed_workflows WHERE installation_id=$1", [id]);
    return rows;
  }
  async managedRepositories(id: number): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT repository FROM managed_workflows WHERE installation_id=$1 UNION SELECT repository FROM managed_secrets WHERE installation_id=$1", [id]);
    return rows.map((row) => row.repository as string);
  }
  async listManagedSecrets(id: number, repository: string): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT secret_name FROM managed_secrets WHERE installation_id=$1 AND repository=$2", [id,repository]);
    return rows.map((row) => row.secret_name as string);
  }
  async recordManagedSecret(id: number, repository: string, secretName: string): Promise<void> {
    await this.pool.query("INSERT INTO managed_secrets(installation_id,repository,secret_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id,repository,secretName]);
  }
  async removeManagedSecret(id: number, repository: string, secretName: string): Promise<void> {
    await this.pool.query("DELETE FROM managed_secrets WHERE installation_id=$1 AND repository=$2 AND secret_name=$3", [id,repository,secretName]);
  }
  async forgetManagedSecrets(id: number, repository: string): Promise<void> { await this.pool.query("DELETE FROM managed_secrets WHERE installation_id=$1 AND repository=$2", [id,repository]); }
  async removeManagedWorkflow(id: number, repository: string): Promise<void> { await this.pool.query("DELETE FROM managed_workflows WHERE installation_id=$1 AND repository=$2", [id,repository]); }
  async saveManagedWorkflow(id: number, repository: string, contentHash: string, branch: string | null = null, pullRequest: number | null = null): Promise<void> {
    await this.pool.query("INSERT INTO managed_workflows(installation_id,repository,content_hash,setup_branch,pull_request) VALUES($1,$2,$3,$4,$5) ON CONFLICT(installation_id,repository) DO UPDATE SET content_hash=EXCLUDED.content_hash,setup_branch=EXCLUDED.setup_branch,pull_request=EXCLUDED.pull_request,updated_at=now()", [id,repository,contentHash,branch,pullRequest]);
  }
  async enqueue(id: number): Promise<void> { await this.pool.query("INSERT INTO jobs(installation_id) VALUES($1) ON CONFLICT DO NOTHING", [id]); }
  async recordDeliveryAndEnqueue(deliveryId: string, id: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query("INSERT INTO webhook_deliveries(delivery_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING delivery_id", [deliveryId]);
      if (!inserted.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query("INSERT INTO jobs(installation_id) VALUES($1) ON CONFLICT DO NOTHING", [id]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async claimJob(): Promise<Job | null> {
    const { rows } = await this.pool.query(`WITH candidate AS (SELECT id FROM jobs WHERE done_at IS NULL AND run_after<=now() AND (locked_at IS NULL OR locked_at<now()-interval '5 minutes') ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs SET locked_at=now() WHERE id=(SELECT id FROM candidate) RETURNING id,installation_id,attempts`);
    return rows[0] ? { id: Number(rows[0].id), installation_id: Number(rows[0].installation_id), attempts: rows[0].attempts } as Job : null;
  }
  async finishJob(id: number): Promise<void> { await this.pool.query("UPDATE jobs SET done_at=now(),locked_at=NULL,last_error=NULL WHERE id=$1", [id]); }
  async failJob(id: number, attempts: number, error: string): Promise<void> { await this.pool.query("UPDATE jobs SET attempts=attempts+1,locked_at=NULL,last_error=$3,run_after=now()+make_interval(secs => LEAST(3600, power(2,LEAST($2,10))::int)) WHERE id=$1", [id,attempts,error.slice(0,2000)]); }
}
