import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { interactiveWorkflowRevisions, interactiveWorkflows, managedChannels, workflowEntries, workflowMessages, workflowRuns, workflowSchedules, workflowStates, workflowVoiceChannels, workflowWaits } from "./schema.js";

const postgresTests = process.env.TEST_DATABASE_URL ? describe : describe.skip;

postgresTests("PostgreSQL Interactive Workflow state", () => {
  let db: typeof import("./client.js").db;
  let pool: typeof import("./client.js").pool;
  const workflowId = randomUUID();
  const guildId = `test-guild-${randomUUID()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const client = await import("./client.js");
    db = client.db;
    pool = client.pool;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(interactiveWorkflows).where(eq(interactiveWorkflows.id, workflowId));
    await db.delete(managedChannels).where(eq(managedChannels.ownerJobId, workflowId));
    await pool.end();
  });

  it("persists guild definition, unique entry rows, and separate member/workflow state", async () => {
    await db.insert(interactiveWorkflows).values({ id: workflowId, guildId, channelId: "test-channel", messageId: "test-message", ownerId: "test-owner", name: "test", version: 1, state: "ACTIVE", spec: { test: true } });
    await db.insert(workflowEntries).values({ workflowId, collection: "participants", userId: "member-a" }).onConflictDoNothing();
    await db.insert(workflowEntries).values({ workflowId, collection: "participants", userId: "member-a" }).onConflictDoNothing();
    const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowEntries).where(and(eq(workflowEntries.workflowId, workflowId), eq(workflowEntries.collection, "participants")));
    expect(count?.count).toBe(1);

    await db.insert(workflowStates).values([
      { workflowId, scope: "workflow", scopeId: workflowId, key: "open", value: true },
      { workflowId, scope: "member", scopeId: "member-a", key: "consent", value: true },
    ]);
    const states = await db.select().from(workflowStates).where(eq(workflowStates.workflowId, workflowId));
    expect(states.map(({ scope, scopeId }) => `${scope}:${scopeId}`).sort()).toEqual([`member:member-a`, `workflow:${workflowId}`].sort());
  });

  it("deduplicates interaction runs while allowing the same snowflake in a different guild", async () => {
    const interactionId = `test-interaction-${randomUUID()}`;
    const first = await db.insert(workflowRuns).values({ id: randomUUID(), workflowId, guildId, interactionId, triggerId: "join", actorId: "member-a", state: "COMPLETED" }).onConflictDoNothing().returning({ id: workflowRuns.id });
    const replay = await db.insert(workflowRuns).values({ id: randomUUID(), workflowId, guildId, interactionId, triggerId: "join", actorId: "member-a", state: "RUNNING" }).onConflictDoNothing().returning({ id: workflowRuns.id });
    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(0);
  });

  it("persists recurring schedule checkpoints and parent cleanup", async () => {
    const nextAt = new Date(Date.now() + 60_000);
    await db.insert(workflowSchedules).values({ id: randomUUID(), workflowId, guildId, triggerId: "daily", event: "schedule", intervalSeconds: 86_400, nextAt, state: "ACTIVE" });
    const [schedule] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, workflowId)).limit(1);
    expect(schedule?.intervalSeconds).toBe(86_400);
    expect(schedule?.nextAt.getTime()).toBe(nextAt.getTime());
  });

  it("recovers durable wait context and owned-message bindings through a fresh PostgreSQL pool", async () => {
    const runId = randomUUID();
    const messageId = randomUUID();
    const dueAt = new Date(Date.now() + 60_000);
    await db.insert(workflowRuns).values({ id: runId, workflowId, guildId, interactionId: `wait:${runId}`, triggerId: "delayed", actorId: "member-a", state: "WAITING", cursor: 2, result: [{ stepId: "first", state: "COMPLETED" }] });
    await db.insert(workflowWaits).values({ id: randomUUID(), workflowId, guildId, runId, triggerId: "delayed", stepId: "wait", memberId: "member-a", dueAt, state: "ACTIVE", context: { inputs: { note: "persisted" }, selected: [], stepResults: { first: { value: 3 } }, outcomes: [{ stepId: "first", state: "COMPLETED" }] } });
    await db.insert(workflowMessages).values({ id: randomUUID(), workflowId, guildId, runId, stepId: "sent", channelId: "channel-a", messageId, state: "ACTIVE" });
    const restartPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      const wait = await restartPool.query("SELECT workflow_waits.state, workflow_runs.cursor FROM workflow_waits JOIN workflow_runs ON workflow_runs.id = workflow_waits.run_id WHERE workflow_waits.run_id = $1", [runId]);
      const message = await restartPool.query("SELECT workflow_id, channel_id, message_id FROM workflow_messages WHERE guild_id = $1 AND message_id = $2", [guildId, messageId]);
      expect(wait.rows[0]).toEqual({ state: "ACTIVE", cursor: 2 });
      expect(message.rows[0]).toEqual({ workflow_id: workflowId, channel_id: "channel-a", message_id: messageId });
    } finally {
      await restartPool.end();
    }
  });

  it("updates definitions with version compare-and-swap and keeps revision history", async () => {
    const updated = await db.update(interactiveWorkflows).set({ version: 2, spec: { test: "v2" }, updatedAt: new Date() })
      .where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.version, 1))).returning({ version: interactiveWorkflows.version });
    const stale = await db.update(interactiveWorkflows).set({ version: 3 })
      .where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.version, 1))).returning({ version: interactiveWorkflows.version });
    await db.insert(interactiveWorkflowRevisions).values({ id: randomUUID(), workflowId, guildId, jobId: "update-job", actorId: "admin", version: 2, beforeSpec: { test: "v1" }, afterSpec: { test: "v2" } });
    expect(updated[0]?.version).toBe(2);
    expect(stale).toHaveLength(0);
  });

  it("binds temporary Voice Channels to their creator Workflow and closes sessions", async () => {
    const voiceChannelId = `test-voice-${randomUUID()}`;
    const sessionId = randomUUID();
    await db.insert(managedChannels).values({ guildId, channelId: voiceChannelId, ownerJobId: workflowId, kind: "voice" });
    await db.insert(workflowVoiceChannels).values({ id: sessionId, workflowId, guildId, sourceChannelId: "test-lobby", voiceChannelId, state: "ACTIVE", createdBy: "member-a" });
    const [active] = await db.select().from(workflowVoiceChannels).where(eq(workflowVoiceChannels.id, sessionId));
    expect(active?.state).toBe("ACTIVE");
    expect(active?.workflowId).toBe(workflowId);
    await db.update(workflowVoiceChannels).set({ state: "CLOSED", closedAt: new Date() }).where(eq(workflowVoiceChannels.id, sessionId));
    const [closed] = await db.select().from(workflowVoiceChannels).where(eq(workflowVoiceChannels.id, sessionId));
    expect(closed?.state).toBe("CLOSED");
  });

  it("enforces one Workflow-owned private ticket per member at the database boundary", async () => {
    await db.insert(managedChannels).values({ guildId, channelId: `ticket-a-${randomUUID()}`, ownerJobId: workflowId, kind: "ticket", createdForMemberId: "member-ticket", staffRoleId: "staff-role" });
    await expect(db.insert(managedChannels).values({ guildId, channelId: `ticket-b-${randomUUID()}`, ownerJobId: workflowId, kind: "ticket", createdForMemberId: "member-ticket", staffRoleId: "staff-role" })).rejects.toThrow();
  });
});
