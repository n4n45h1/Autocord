import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentJobSteps, agentJobs, usageRecords } from "../db/schema.js";
import { db, pool } from "../db/client.js";

export async function claimApproval(jobId: string, guildId: string, actorId: string): Promise<string | null> {
  const now = new Date();
  const owner = randomUUID();
  const claimed = await db.update(agentJobs).set({ state: "EXECUTING", leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + 600_000), approvalActorId: actorId, decisionAt: now, updatedAt: now })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "AWAITING_APPROVAL"), eq(agentJobs.planHashVersion, 2), gt(agentJobs.expiresAt, now)))
    .returning({ id: agentJobs.id });
  return claimed.length === 1 ? owner : null;
}

export async function withGuildAdvisoryLock<T>(guildId: string, task: () => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [guildId]);
    return await task();
  } finally {
    await connection.query("SELECT pg_advisory_unlock(hashtext($1))", [guildId]).catch(() => undefined);
    connection.release();
  }
}

export async function recoverExpiredExecutionLeases(): Promise<number> {
  const recovered = await db.update(agentJobs).set({ state: "RECOVERY_REQUIRED", errorDetail: { reason: "worker lease expired during execution" }, updatedAt: new Date() })
    .where(and(eq(agentJobs.state, "EXECUTING"), sql`${agentJobs.leaseExpiresAt} < now()`)).returning({ id: agentJobs.id });
  if (recovered.length) {
    await db.update(agentJobSteps).set({ state: "RECOVERY_REQUIRED", errorDetail: { reason: "worker lease expired during step execution" } })
      .where(and(inArray(agentJobSteps.jobId, recovered.map(({ id }) => id)), eq(agentJobSteps.state, "EXECUTING")));
    await db.update(agentJobSteps).set({ state: "BLOCKED", errorDetail: { reason: "job requires recovery before remaining steps can run" } })
      .where(and(inArray(agentJobSteps.jobId, recovered.map(({ id }) => id)), eq(agentJobSteps.state, "PENDING")));
  }
  await db.update(agentJobs).set({ state: "EXPIRED", updatedAt: new Date() })
    .where(and(eq(agentJobs.state, "AWAITING_APPROVAL"), sql`${agentJobs.expiresAt} < now()`));
  await db.update(agentJobs).set({ state: "EXPIRED", updatedAt: new Date() })
    .where(and(eq(agentJobs.state, "AWAITING_PANEL_SELECTION"), sql`${agentJobs.expiresAt} < now()`));
  const expiredPlanning = await db.update(agentJobs).set({ state: "FAILED", errorDetail: { reason: "planning worker stopped before preview" }, updatedAt: new Date() })
    .where(and(eq(agentJobs.state, "PLANNING"), or(isNull(agentJobs.expiresAt), sql`${agentJobs.expiresAt} < now()`))).returning({ id: agentJobs.id });
  if (expiredPlanning.length) {
    await db.update(usageRecords).set({ model: "failed" }).where(and(inArray(usageRecords.jobId, expiredPlanning.map(({ id }) => id)), eq(usageRecords.model, "pending")));
  }
  return recovered.length + expiredPlanning.length;
}
