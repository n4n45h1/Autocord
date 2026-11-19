import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { workflowCollections, workflowDebitClaims, workflowEntries, workflowStates } from "../../db/schema.js";

export async function joinWorkflowEntry(input: { workflowId: string; collection: string; userId: string; maxEntries: number }): Promise<{ joined: boolean; duplicate: boolean; count: number; full: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.workflowId}:${input.collection}`}))`);
    const prior = await tx.select({ userId: workflowEntries.userId }).from(workflowEntries).where(and(
      eq(workflowEntries.workflowId, input.workflowId), eq(workflowEntries.collection, input.collection), eq(workflowEntries.userId, input.userId),
    )).limit(1);
    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(workflowEntries).where(and(eq(workflowEntries.workflowId, input.workflowId), eq(workflowEntries.collection, input.collection)));
    const count = row?.count ?? 0;
    if (prior.length) return { joined: false, duplicate: true, count, full: count >= input.maxEntries };
    if (count >= input.maxEntries) return { joined: false, duplicate: false, count, full: true };
    await tx.insert(workflowEntries).values({ workflowId: input.workflowId, collection: input.collection, userId: input.userId }).onConflictDoNothing();
    const nextCount = count + 1;
    return { joined: true, duplicate: false, count: nextCount, full: nextCount >= input.maxEntries };
  });
}

export async function leaveWorkflowEntry(input: { workflowId: string; collection: string; userId: string }): Promise<{ left: boolean; count: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.workflowId}:${input.collection}`}))`);
    const removed = await tx.delete(workflowEntries).where(and(eq(workflowEntries.workflowId, input.workflowId), eq(workflowEntries.collection, input.collection), eq(workflowEntries.userId, input.userId))).returning({ userId: workflowEntries.userId });
    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(workflowEntries).where(and(eq(workflowEntries.workflowId, input.workflowId), eq(workflowEntries.collection, input.collection)));
    return { left: removed.length > 0, count: row?.count ?? 0 };
  });
}

export async function mutateWorkflowNumber(input: {
  workflowId: string;
  scope: "workflow" | "guild" | "member";
  scopeId: string;
  key: string;
  operation: "increment" | "decrement" | "multiply";
  amount: number;
}): Promise<number> {
  const lockKey = `${input.workflowId}:${input.scope}:${input.scopeId}:${input.key}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const [row] = await tx.select({ value: workflowStates.value }).from(workflowStates).where(and(
      eq(workflowStates.workflowId, input.workflowId), eq(workflowStates.scope, input.scope), eq(workflowStates.scopeId, input.scopeId), eq(workflowStates.key, input.key),
    )).limit(1);
    const current = row?.value ?? (input.operation === "multiply" ? 1 : 0);
    if (typeof current !== "number" || !Number.isFinite(current)) throw new Error(`State ${input.key} is not a finite number.`);
    const value = input.operation === "increment" ? current + input.amount : input.operation === "decrement" ? current - input.amount : current * input.amount;
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) throw new Error("State numeric result exceeds its storage bounds.");
    await tx.insert(workflowStates).values({ workflowId: input.workflowId, scope: input.scope, scopeId: input.scopeId, key: input.key, value, updatedAt: new Date() }).onConflictDoUpdate({
      target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value, updatedAt: new Date() },
    });
    return value;
  });
}

export async function debitWorkflowNumber(input: {
  workflowId: string;
  scope: "workflow" | "guild" | "member";
  scopeId: string;
  key: string;
  amount: number;
  minimumBalance: number;
  idempotencyKey?: string | null;
}): Promise<{ debited: boolean; duplicate: boolean; value: number }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || !Number.isFinite(input.minimumBalance) || input.minimumBalance < input.amount) throw new Error("Debit amount and minimum balance must be finite and positive, with minimumBalance >= amount.");
  const lockKey = `${input.workflowId}:${input.scope}:${input.scopeId}:${input.key}:${input.idempotencyKey ?? ""}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    if (input.idempotencyKey) {
      const [priorClaim] = await tx.select({ id: workflowDebitClaims.id }).from(workflowDebitClaims).where(and(
        eq(workflowDebitClaims.workflowId, input.workflowId), eq(workflowDebitClaims.scope, input.scope), eq(workflowDebitClaims.scopeId, input.scopeId), eq(workflowDebitClaims.redemptionKey, input.idempotencyKey),
      )).limit(1);
      if (priorClaim) {
        const [priorState] = await tx.select({ value: workflowStates.value }).from(workflowStates).where(and(
          eq(workflowStates.workflowId, input.workflowId), eq(workflowStates.scope, input.scope), eq(workflowStates.scopeId, input.scopeId), eq(workflowStates.key, input.key),
        )).limit(1);
        return { debited: false, duplicate: true, value: typeof priorState?.value === "number" ? priorState.value : 0 };
      }
    }
    const [row] = await tx.select({ value: workflowStates.value }).from(workflowStates).where(and(
      eq(workflowStates.workflowId, input.workflowId), eq(workflowStates.scope, input.scope), eq(workflowStates.scopeId, input.scopeId), eq(workflowStates.key, input.key),
    )).limit(1);
    const current = row?.value ?? 0;
    if (typeof current !== "number" || !Number.isFinite(current)) throw new Error(`State ${input.key} is not a finite number.`);
    if (current < input.minimumBalance) return { debited: false, duplicate: false, value: current };
    const value = current - input.amount;
    await tx.insert(workflowStates).values({ workflowId: input.workflowId, scope: input.scope, scopeId: input.scopeId, key: input.key, value, updatedAt: new Date() }).onConflictDoUpdate({
      target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value, updatedAt: new Date() },
    });
    if (input.idempotencyKey) await tx.insert(workflowDebitClaims).values({ id: randomUUID(), workflowId: input.workflowId, scope: input.scope, scopeId: input.scopeId, redemptionKey: input.idempotencyKey });
    return { debited: true, duplicate: false, value };
  });
}

export async function addWorkflowCollectionItem(input: {
  workflowId: string;
  guildId: string;
  scope: "workflow" | "guild" | "member";
  scopeId: string;
  collection: string;
  item: string | number | boolean | null;
  maxItems: number;
}): Promise<boolean> {
  const itemKey = JSON.stringify(input.item);
  const lockKey = `workflow-collections:${input.workflowId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const base = and(eq(workflowCollections.workflowId, input.workflowId), eq(workflowCollections.scope, input.scope), eq(workflowCollections.scopeId, input.scopeId), eq(workflowCollections.collection, input.collection));
    const [prior] = await tx.select({ id: workflowCollections.id }).from(workflowCollections).where(and(base, eq(workflowCollections.itemKey, itemKey))).limit(1);
    if (prior) return false;
    const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(workflowCollections).where(base);
    if ((count?.count ?? 0) >= input.maxItems) throw new Error(`Collection capacity reached (${input.maxItems}).`);
    const [usage] = await tx.select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(pg_column_size(${workflowCollections.item})), 0)::int` })
      .from(workflowCollections).where(eq(workflowCollections.workflowId, input.workflowId));
    if ((usage?.count ?? 0) >= 20_000) throw new Error("Workflow collection item budget reached (20000).");
    if ((usage?.bytes ?? 0) + Buffer.byteLength(itemKey, "utf8") > 10 * 1024 * 1024) throw new Error("Workflow collection storage budget reached (10 MiB).");
    await tx.insert(workflowCollections).values({
      id: randomUUID(), workflowId: input.workflowId, guildId: input.guildId, scope: input.scope, scopeId: input.scopeId,
      collection: input.collection, itemKey, item: input.item,
    });
    return true;
  });
}
