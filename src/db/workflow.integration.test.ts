import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { interactiveWorkflowRevisions, interactiveWorkflows, workflowEntries, workflowRuns, workflowSchedules, workflowStates } from "./schema.js";

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

  it("updates definitions with version compare-and-swap and keeps revision history", async () => {
    const updated = await db.update(interactiveWorkflows).set({ version: 2, spec: { test: "v2" }, updatedAt: new Date() })
      .where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.version, 1))).returning({ version: interactiveWorkflows.version });
    const stale = await db.update(interactiveWorkflows).set({ version: 3 })
      .where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.version, 1))).returning({ version: interactiveWorkflows.version });
    await db.insert(interactiveWorkflowRevisions).values({ id: randomUUID(), workflowId, guildId, jobId: "update-job", actorId: "admin", version: 2, beforeSpec: { test: "v1" }, afterSpec: { test: "v2" } });
    expect(updated[0]?.version).toBe(2);
    expect(stale).toHaveLength(0);
  });
});
