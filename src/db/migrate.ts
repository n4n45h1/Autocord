import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(`
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
  `);
  console.info("Database schema is ready");
} finally {
  await pool.end();
}
