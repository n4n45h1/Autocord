import { pgTable, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const agentJobs = pgTable("agent_jobs", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  requesterId: text("requester_id").notNull(),
  state: text("state").notNull(),
  instruction: text("instruction").notNull(),
  plan: jsonb("plan"),
  planHash: text("plan_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
}, (table) => [uniqueIndex("panels_guild_message_idx").on(table.guildId, table.messageId)]);

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
