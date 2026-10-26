import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWorkflowCollectionItem, mutateWorkflowNumber } from "./data.js";

const postgresTests = process.env.TEST_DATABASE_URL ? describe : describe.skip;

postgresTests("Workflow state and collection PostgreSQL primitives", () => {
  let db: typeof import("../../db/client.js").db;
  let pool: typeof import("../../db/client.js").pool;
  let interactiveWorkflows: typeof import("../../db/schema.js").interactiveWorkflows;
  let workflowCollections: typeof import("../../db/schema.js").workflowCollections;
  let workflowStates: typeof import("../../db/schema.js").workflowStates;
  const workflowA = randomUUID();
  const workflowB = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const client = await import("../../db/client.js");
    const schema = await import("../../db/schema.js");
    db = client.db;
    pool = client.pool;
    interactiveWorkflows = schema.interactiveWorkflows;
    workflowCollections = schema.workflowCollections;
    workflowStates = schema.workflowStates;
    for (const [id, guildId] of [[workflowA, `guild-a-${workflowA}`], [workflowB, `guild-b-${workflowB}`]] as const) {
      await db.insert(interactiveWorkflows).values({ id, guildId, channelId: "channel", messageId: `message-${id}`, ownerId: "owner", name: "test", version: 1, state: "ACTIVE", spec: {} });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(interactiveWorkflows).where(sql`${interactiveWorkflows.id} IN (${workflowA}, ${workflowB})`);
    await pool.end();
  });

  it("serializes concurrent increments without losing updates and isolates workflows", async () => {
    const increments = await Promise.all(Array.from({ length: 40 }, () => mutateWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "member-1", key: "points", operation: "increment", amount: 1 })));
    expect(increments).toHaveLength(40);
    const [rowA] = await db.select({ value: workflowStates.value }).from(workflowStates)
      .where(and(eq(workflowStates.workflowId, workflowA), eq(workflowStates.key, "points")));
    const valueB = await mutateWorkflowNumber({ workflowId: workflowB, scope: "member", scopeId: "member-1", key: "points", operation: "increment", amount: 7 });
    expect(rowA?.value).toBe(40);
    expect(valueB).toBe(7);
  });

  it("enforces collection capacity atomically and makes duplicate additions idempotent", async () => {
    const same = await Promise.all(Array.from({ length: 8 }, () => addWorkflowCollectionItem({ workflowId: workflowA, guildId: "guild-a", scope: "guild", scopeId: "guild-a", collection: "inventory", item: "potion", maxItems: 3 })));
    expect(same.filter(Boolean)).toHaveLength(1);
    const additions = await Promise.allSettled(["sword", "shield", "key", "map"].map((item) => addWorkflowCollectionItem({ workflowId: workflowA, guildId: "guild-a", scope: "guild", scopeId: "guild-a", collection: "inventory", item, maxItems: 3 })));
    expect(additions.filter((result) => result.status === "fulfilled" && result.value)).toHaveLength(2);
    expect(additions.filter((result) => result.status === "rejected")).toHaveLength(2);
    const rows = await db.select({ id: workflowCollections.id }).from(workflowCollections).where(and(eq(workflowCollections.workflowId, workflowA), eq(workflowCollections.collection, "inventory")));
    expect(rows).toHaveLength(3);
  });
});
