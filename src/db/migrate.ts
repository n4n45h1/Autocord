import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const connection = await pool.connect();
try {
  await connection.query("BEGIN");
  await connection.query("SELECT pg_advisory_xact_lock(hashtext('autocord-schema-v3'))");
  await connection.query(`
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id text PRIMARY KEY, guild_id text NOT NULL, requester_id text NOT NULL,
      state text NOT NULL, instruction text NOT NULL, plan jsonb, plan_hash text,
      expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS panels (
      id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, message_id text NOT NULL,
      title text NOT NULL, description text NOT NULL, color text NOT NULL, revision integer NOT NULL DEFAULT 1,
      spec jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS panels_guild_message_idx ON panels(guild_id, message_id);
    CREATE TABLE IF NOT EXISTS panel_options (
      id text PRIMARY KEY, panel_id text NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      key text NOT NULL, label text NOT NULL, role_id text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id text PRIMARY KEY, job_id text NOT NULL, guild_id text NOT NULL, actor_id text NOT NULL,
      action text NOT NULL, outcome text NOT NULL, detail jsonb, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'mini';
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT gen_random_uuid()::text;
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS expected_revision integer;
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS lease_owner text;
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS error_detail jsonb;
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS execution_context jsonb;
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS approval_actor_id text;
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS decision_at timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_idempotency_idx ON agent_jobs(guild_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS agent_jobs_guild_state_idx ON agent_jobs(guild_id, state);
    CREATE INDEX IF NOT EXISTS panels_guild_updated_idx ON panels(guild_id, updated_at);
    UPDATE panels AS p SET spec = jsonb_build_object(
      'intent', 'edit', 'panelId', p.id, 'expectedRevision', p.revision,
      'title', p.title, 'description', p.description, 'color', p.color, 'renderMode', 'classic',
      'selectionMode', 'multiple', 'componentStyle', 'select',
      'channelId', coalesce(p.spec->'channelId', 'null'::jsonb),
      'options', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'key', option->>'key', 'label', option->>'label',
          'roleName', option->>'roleName', 'emoji', coalesce(option->'emoji', 'null'::jsonb)
        ) ORDER BY ordinal)
        FROM jsonb_array_elements(coalesce(p.spec->'options', '[]'::jsonb)) WITH ORDINALITY AS item(option, ordinal)
      ), '[]'::jsonb)
    ) WHERE NOT (p.spec ? 'expectedRevision');
    UPDATE agent_jobs SET state = 'EXPIRED', updated_at = now()
      WHERE state = 'AWAITING_APPROVAL' AND coalesce(plan->>'selectionMode', '') = '';
    UPDATE agent_jobs SET state = 'RECOVERY_REQUIRED', error_detail = '{"reason":"legacy execution without lease"}'::jsonb, updated_at = now()
      WHERE state = 'EXECUTING' AND lease_owner IS NULL;
    CREATE TABLE IF NOT EXISTS managed_roles (
      guild_id text NOT NULL, role_id text NOT NULL, owner_job_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS panel_revisions (
      id text PRIMARY KEY, panel_id text NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      guild_id text NOT NULL, job_id text NOT NULL, revision integer NOT NULL,
      before_spec jsonb, after_spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE panel_revisions ADD COLUMN IF NOT EXISTS before_bindings jsonb;
    ALTER TABLE panel_revisions ADD COLUMN IF NOT EXISTS after_bindings jsonb NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS panel_revisions_lookup_idx ON panel_revisions(guild_id, panel_id, revision);
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id text PRIMARY KEY, mini_monthly_limit integer NOT NULL DEFAULT 30,
      max_monthly_limit integer NOT NULL DEFAULT 5, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS usage_records (
      id text PRIMARY KEY, guild_id text NOT NULL, user_id text NOT NULL, job_id text NOT NULL,
      mode text NOT NULL, model text NOT NULL, input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0, estimated_cost_usd text NOT NULL DEFAULT '0',
      period text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS usage_records_guild_period_idx ON usage_records(guild_id, period, mode);
    CREATE TABLE IF NOT EXISTS giveaways (
      id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, message_id text,
      host_id text NOT NULL, prize text NOT NULL, winner_count integer NOT NULL,
      state text NOT NULL, ends_at timestamptz NOT NULL, winners jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS giveaways_due_idx ON giveaways(state, ends_at);
    CREATE INDEX IF NOT EXISTS giveaways_guild_idx ON giveaways(guild_id);
    CREATE TABLE IF NOT EXISTS giveaway_entries (
      giveaway_id text NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
      user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(giveaway_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS giveaway_notifications (
      id text PRIMARY KEY, giveaway_id text NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
      guild_id text NOT NULL, channel_id text NOT NULL, content text NOT NULL,
      allowed_users jsonb NOT NULL, state text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(), lease_owner text, lease_expires_at timestamptz,
      sent_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS giveaway_notifications_due_idx ON giveaway_notifications(state, available_at);
    CREATE INDEX IF NOT EXISTS giveaway_notifications_guild_idx ON giveaway_notifications(guild_id);
    ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS remaining_seconds integer;
    CREATE TABLE IF NOT EXISTS runtime_leases (
      guild_id text PRIMARY KEY, job_id text NOT NULL, owner text NOT NULL, expires_at timestamptz NOT NULL
    );
  `);
  await connection.query("COMMIT");
  console.info("Database schema is ready");
} catch (error) {
  await connection.query("ROLLBACK");
  throw error;
} finally {
  connection.release();
  await pool.end();
}
