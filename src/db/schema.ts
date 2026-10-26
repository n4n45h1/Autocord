import { pgTable, text, timestamp, integer, jsonb, uniqueIndex, primaryKey, index } from "drizzle-orm/pg-core";

export const agentJobs = pgTable("agent_jobs", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  requesterId: text("requester_id").notNull(),
  state: text("state").notNull(),
  mode: text("mode").default("mini").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  revision: integer("expected_revision"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  errorDetail: jsonb("error_detail"),
  executionContext: jsonb("execution_context"),
  approvalActorId: text("approval_actor_id"),
  decisionAt: timestamp("decision_at", { withTimezone: true }),
  instruction: text("instruction").notNull(),
  plan: jsonb("plan"),
  planHash: text("plan_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("agent_jobs_idempotency_idx").on(table.guildId, table.idempotencyKey), index("agent_jobs_guild_state_idx").on(table.guildId, table.state)]);

export const panels = pgTable("panels", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  color: text("color").notNull(),
  revision: integer("revision").default(1).notNull(),
  spec: jsonb("spec").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("panels_guild_message_idx").on(table.guildId, table.messageId), index("panels_guild_updated_idx").on(table.guildId, table.updatedAt)]);

export const panelOptions = pgTable("panel_options", {
  id: text("id").primaryKey(),
  panelId: text("panel_id").notNull().references(() => panels.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  label: text("label").notNull(),
  roleId: text("role_id").notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  guildId: text("guild_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  outcome: text("outcome").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const managedRoles = pgTable("managed_roles", {
  guildId: text("guild_id").notNull(),
  roleId: text("role_id").notNull(),
  ownerJobId: text("owner_job_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.roleId] })]);

export const panelRevisions = pgTable("panel_revisions", {
  id: text("id").primaryKey(),
  panelId: text("panel_id").notNull().references(() => panels.id, { onDelete: "cascade" }),
  guildId: text("guild_id").notNull(),
  jobId: text("job_id").notNull(),
  revision: integer("revision").notNull(),
  beforeSpec: jsonb("before_spec"),
  afterSpec: jsonb("after_spec").notNull(),
  beforeBindings: jsonb("before_bindings"),
  afterBindings: jsonb("after_bindings").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("panel_revisions_lookup_idx").on(table.guildId, table.panelId, table.revision)]);

export const guildSettings = pgTable("guild_settings", {
  guildId: text("guild_id").primaryKey(),
  miniMonthlyLimit: integer("mini_monthly_limit").default(30).notNull(),
  maxMonthlyLimit: integer("max_monthly_limit").default(5).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const usageRecords = pgTable("usage_records", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  jobId: text("job_id").notNull(),
  mode: text("mode").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0).notNull(),
  outputTokens: integer("output_tokens").default(0).notNull(),
  estimatedCostUsd: text("estimated_cost_usd").default("0").notNull(),
  period: text("period").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("usage_records_guild_period_idx").on(table.guildId, table.period, table.mode)]);

export const giveaways = pgTable("giveaways", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  hostId: text("host_id").notNull(),
  prize: text("prize").notNull(),
  winnerCount: integer("winner_count").notNull(),
  state: text("state").notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  remainingSeconds: integer("remaining_seconds"),
  winners: jsonb("winners"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("giveaways_due_idx").on(table.state, table.endsAt), index("giveaways_guild_idx").on(table.guildId)]);

export const giveawayEntries = pgTable("giveaway_entries", {
  giveawayId: text("giveaway_id").notNull().references(() => giveaways.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.giveawayId, table.userId] })]);

export const runtimeLeases = pgTable("runtime_leases", {
  guildId: text("guild_id").primaryKey(),
  jobId: text("job_id").notNull(),
  owner: text("owner").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
