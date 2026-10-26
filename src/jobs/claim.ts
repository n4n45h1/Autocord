import { and, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentJobs } from "../db/schema.js";
import { db, pool } from "../db/client.js";

export async function claimApproval(jobId: string, guildId: string, actorId: string): Promise<string | null> {
  const now = new Date();
  const owner = randomUUID();
  const claimed = await db.update(agentJobs).set({ state: "EXECUTING", leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + 600_000), approvalActorId: actorId, decisionAt: now, updatedAt: now })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "AWAITING_APPROVAL"), gt(agentJobs.expiresAt, now)))
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
  await db.update(agentJobs).set({ state: "EXPIRED", updatedAt: new Date() })
    .where(and(eq(agentJobs.state, "AWAITING_APPROVAL"), sql`${agentJobs.expiresAt} < now()`));
  await db.update(agentJobs).set({ state: "EXPIRED", updatedAt: new Date() })
    .where(and(eq(agentJobs.state, "AWAITING_PANEL_SELECTION"), sql`${agentJobs.expiresAt} < now()`));
  return recovered.length;
}
