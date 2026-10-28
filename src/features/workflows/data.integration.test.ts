import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWorkflowCollectionItem, debitWorkflowNumber, joinWorkflowEntry, leaveWorkflowEntry, mutateWorkflowNumber } from "./data.js";

const postgresTests = process.env.TEST_DATABASE_URL ? describe : describe.skip;

postgresTests("Workflow state and collection PostgreSQL primitives", () => {
  let db: typeof import("../../db/client.js").db;
  let pool: typeof import("../../db/client.js").pool;
  let interactiveWorkflows: typeof import("../../db/schema.js").interactiveWorkflows;
  let workflowCollections: typeof import("../../db/schema.js").workflowCollections;
  let workflowEntries: typeof import("../../db/schema.js").workflowEntries;
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
    workflowEntries = schema.workflowEntries;
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

  it("keeps a capped member-entry collection within capacity under concurrent joins and leave/rejoin races", async () => {
    const joins = await Promise.all(Array.from({ length: 10 }, (_, index) => joinWorkflowEntry({ workflowId: workflowA, collection: "party", userId: `member-${index}`, maxEntries: 5 })));
    expect(joins.filter((result) => result.joined)).toHaveLength(5);
    expect(Math.max(...joins.map((result) => result.count))).toBe(5);
    expect(joins.every((result) => result.count <= 5)).toBe(true);
    const acceptedActorIndex = joins.findIndex((result) => result.joined);
    const acceptedActor = `member-${acceptedActorIndex}`;
    const duplicate = await joinWorkflowEntry({ workflowId: workflowA, collection: "party", userId: acceptedActor, maxEntries: 5 });
    expect(duplicate).toMatchObject({ joined: false, duplicate: true, count: 5, full: true });

    const raced = await Promise.all([
      leaveWorkflowEntry({ workflowId: workflowA, collection: "party", userId: acceptedActor }),
      joinWorkflowEntry({ workflowId: workflowA, collection: "party", userId: "member-new", maxEntries: 5 }),
    ]);
    expect(raced.every((result) => result.count <= 5)).toBe(true);
    const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowEntries)
      .where(and(eq(workflowEntries.workflowId, workflowA), eq(workflowEntries.collection, "party")));
    expect(count?.count).toBeLessThanOrEqual(5);
  });

  it("atomically prevents concurrent point redemptions below the required balance", async () => {
    await mutateWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "redeemer", key: "points", operation: "increment", amount: 1000 });
    const redemptions = await Promise.all(Array.from({ length: 6 }, () => debitWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "redeemer", key: "points", amount: 500, minimumBalance: 500 })));
    expect(redemptions.filter((result) => result.debited)).toHaveLength(2);
    expect(redemptions.at(-1)?.value).toBe(0);
    await mutateWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "idempotent-redeemer", key: "points", operation: "increment", amount: 2000 });
    const duplicateClicks = await Promise.all(Array.from({ length: 8 }, () => debitWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "idempotent-redeemer", key: "points", amount: 500, minimumBalance: 500, idempotencyKey: "game-key" })));
    expect(duplicateClicks.filter((result) => result.debited)).toHaveLength(1);
    expect(duplicateClicks.filter((result) => result.duplicate)).toHaveLength(7);
  });

  it("preserves user-selected 50/300 point values and makes that redemption idempotent", async () => {
    await mutateWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "fifty-thirty", key: "points", operation: "increment", amount: 50 });
    const denied = await debitWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "fifty-thirty", key: "points", amount: 300, minimumBalance: 300, idempotencyKey: "exchange-300" });
    expect(denied).toMatchObject({ debited: false, value: 50 });
    await mutateWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "fifty-thirty", key: "points", operation: "increment", amount: 250 });
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => debitWorkflowNumber({ workflowId: workflowA, scope: "member", scopeId: "fifty-thirty", key: "points", amount: 300, minimumBalance: 300, idempotencyKey: "exchange-300" })));
    expect(concurrent.filter((result) => result.debited)).toHaveLength(1);
    expect(concurrent.filter((result) => result.duplicate)).toHaveLength(5);
    const [balance] = await db.select({ value: workflowStates.value }).from(workflowStates).where(and(eq(workflowStates.workflowId, workflowA), eq(workflowStates.scopeId, "fifty-thirty"), eq(workflowStates.key, "points")));
    expect(balance?.value).toBe(0);
  });
});
