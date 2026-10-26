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
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS plan_hash_version integer NOT NULL DEFAULT 1;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_idempotency_idx ON agent_jobs(guild_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS agent_jobs_guild_state_idx ON agent_jobs(guild_id, state);
    CREATE TABLE IF NOT EXISTS agent_job_steps (
      id text PRIMARY KEY, job_id text NOT NULL, guild_id text NOT NULL, step_id text NOT NULL,
      sequence integer NOT NULL, skill_id text NOT NULL, state text NOT NULL, input jsonb NOT NULL,
      result jsonb, error_detail jsonb, attempts integer NOT NULL DEFAULT 0,
      started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(job_id, step_id)
    );
    CREATE INDEX IF NOT EXISTS agent_job_steps_job_sequence_idx ON agent_job_steps(job_id, sequence);
    CREATE INDEX IF NOT EXISTS agent_job_steps_state_idx ON agent_job_steps(state);
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
    UPDATE agent_jobs SET state = 'EXPIRED', error_detail = '{"reason":"approval hash format upgraded; re-preview required"}'::jsonb, updated_at = now()
      WHERE state = 'AWAITING_APPROVAL' AND plan_hash_version < 2;
    CREATE TABLE IF NOT EXISTS managed_roles (
      guild_id text NOT NULL, role_id text NOT NULL, owner_job_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(guild_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS managed_roles_owner_idx ON managed_roles(guild_id, owner_job_id);
    CREATE TABLE IF NOT EXISTS managed_channels (
      guild_id text NOT NULL, channel_id text NOT NULL, owner_job_id text NOT NULL,
      kind text NOT NULL, created_for_member_id text, staff_role_id text,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(guild_id, channel_id)
    );
    ALTER TABLE managed_channels ADD COLUMN IF NOT EXISTS created_for_member_id text;
    ALTER TABLE managed_channels ADD COLUMN IF NOT EXISTS staff_role_id text;
    CREATE INDEX IF NOT EXISTS managed_channels_owner_idx ON managed_channels(guild_id, owner_job_id, kind);
    CREATE INDEX IF NOT EXISTS managed_channels_ticket_owner_idx ON managed_channels(guild_id, owner_job_id, kind, created_for_member_id);
    CREATE UNIQUE INDEX IF NOT EXISTS managed_channels_ticket_member_idx ON managed_channels(guild_id, owner_job_id, created_for_member_id) WHERE kind = 'ticket' AND created_for_member_id IS NOT NULL;
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
    CREATE TABLE IF NOT EXISTS interactive_workflows (
      id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, message_id text NOT NULL,
      owner_id text NOT NULL, name text NOT NULL, version integer NOT NULL,
      state text NOT NULL DEFAULT 'ACTIVE', spec jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS interactive_workflows_guild_message_idx ON interactive_workflows(guild_id, message_id);
    CREATE INDEX IF NOT EXISTS interactive_workflows_guild_state_idx ON interactive_workflows(guild_id, state);
    CREATE TABLE IF NOT EXISTS interactive_workflow_revisions (
      id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      guild_id text NOT NULL, job_id text NOT NULL, actor_id text NOT NULL, version integer NOT NULL,
      before_spec jsonb, after_spec jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS interactive_workflow_revisions_lookup_idx ON interactive_workflow_revisions(guild_id, workflow_id, version);
    CREATE TABLE IF NOT EXISTS workflow_entries (
      workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      collection text NOT NULL, user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(workflow_id, collection, user_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_entries_count_idx ON workflow_entries(workflow_id, collection);
    CREATE TABLE IF NOT EXISTS workflow_states (
      workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      scope text NOT NULL, scope_id text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workflow_id, scope, scope_id, key)
    );
    CREATE TABLE IF NOT EXISTS workflow_collections (
      id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      guild_id text NOT NULL, scope text NOT NULL, scope_id text NOT NULL,
      collection text NOT NULL, item_key text NOT NULL, item jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(workflow_id, scope, scope_id, collection, item_key)
    );
    CREATE INDEX IF NOT EXISTS workflow_collections_count_idx ON workflow_collections(workflow_id, scope, scope_id, collection, created_at);
    CREATE TABLE IF NOT EXISTS workflow_messages (
      id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      guild_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL,
      channel_id text NOT NULL, message_id text NOT NULL, state text NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(guild_id, message_id), UNIQUE(workflow_id, run_id, step_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_messages_workflow_state_idx ON workflow_messages(workflow_id, state);
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      guild_id text NOT NULL, interaction_id text NOT NULL, trigger_id text NOT NULL, actor_id text NOT NULL,
      state text NOT NULL, cursor integer NOT NULL DEFAULT 0, result jsonb, error_detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(guild_id, interaction_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_runs_workflow_state_idx ON workflow_runs(workflow_id, state);
    CREATE TABLE IF NOT EXISTS workflow_waits (
      id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      guild_id text NOT NULL, run_id text NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      trigger_id text NOT NULL, step_id text NOT NULL, member_id text, due_at timestamptz NOT NULL,
      state text NOT NULL DEFAULT 'ACTIVE', context jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
      lease_owner text, lease_expires_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(run_id, step_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_waits_due_idx ON workflow_waits(state, due_at);
    CREATE INDEX IF NOT EXISTS workflow_waits_guild_idx ON workflow_waits(guild_id, state);
    CREATE TABLE IF NOT EXISTS workflow_schedules (
      id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      guild_id text NOT NULL, trigger_id text NOT NULL, event text NOT NULL, interval_seconds integer,
      next_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'ACTIVE', lease_owner text,
      lease_expires_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workflow_id, trigger_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_schedules_due_idx ON workflow_schedules(state, next_at);
    CREATE TABLE IF NOT EXISTS workflow_voice_channels (
      id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES interactive_workflows(id) ON DELETE CASCADE,
      guild_id text NOT NULL, source_channel_id text NOT NULL, voice_channel_id text NOT NULL,
      state text NOT NULL DEFAULT 'ACTIVE', created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
      UNIQUE(guild_id, voice_channel_id)
    );
    CREATE INDEX IF NOT EXISTS workflow_voice_channels_active_source_idx ON workflow_voice_channels(workflow_id, source_channel_id, state);
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
