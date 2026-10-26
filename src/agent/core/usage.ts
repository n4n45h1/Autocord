import { and, eq, gt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import { agentJobs, guildSettings, usageRecords } from "../../db/schema.js";

export type UsageReservation = { id: string; period: string };

export async function reserveUsage(guildId: string, userId: string, jobId: string, mode: "mini" | "max", instruction: string): Promise<UsageReservation> {
  const period = new Date().toISOString().slice(0, 7);
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('autocord-global-agent-cap'))`);
    await tx.insert(guildSettings).values({
      guildId,
      miniMonthlyLimit: Number(process.env.MINI_MONTHLY_LIMIT ?? 30),
      maxMonthlyLimit: Number(process.env.MAX_MONTHLY_LIMIT ?? 5),
    }).onConflictDoNothing();
    const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1);
    const active = await tx.select({ count: sql<number>`count(*)::int` }).from(agentJobs).where(and(eq(agentJobs.guildId, guildId), sql`${agentJobs.state} IN ('PLANNING', 'AWAITING_PANEL_SELECTION', 'AWAITING_APPROVAL', 'EXECUTING', 'RECOVERY_REQUIRED')`));
    if ((active[0]?.count ?? 0) >= Number(process.env.MAX_CONCURRENT_JOBS_PER_GUILD ?? 1)) throw new Error("このサーバーでは別のAgentcordジョブが進行中、または復旧確認待ちです。");
    const globalActive = await tx.select({ count: sql<number>`count(*)::int` }).from(agentJobs).where(sql`${agentJobs.state} IN ('PLANNING', 'AWAITING_PANEL_SELECTION', 'AWAITING_APPROVAL', 'EXECUTING', 'RECOVERY_REQUIRED')`);
    if ((globalActive[0]?.count ?? 0) >= Number(process.env.MAX_CONCURRENT_AI_JOBS ?? 5)) throw new Error("Autocord全体のAI処理が混雑しています。少し待ってから再度お試しください。");
    const limit = mode === "mini" ? settings!.miniMonthlyLimit : settings!.maxMonthlyLimit;
    const used = await tx.select({ count: sql<number>`count(*)::int` }).from(usageRecords).where(and(eq(usageRecords.guildId, guildId), eq(usageRecords.period, period), eq(usageRecords.mode, mode)));
    if ((used[0]?.count ?? 0) >= limit) throw new Error(`今月のAgentcord ${mode === "mini" ? "Mini" : "Max"}利用上限（${limit}回）に達しました。`);
    const recent = await tx.select({ id: usageRecords.id }).from(usageRecords).where(and(eq(usageRecords.guildId, guildId), eq(usageRecords.userId, userId), gt(usageRecords.createdAt, new Date(Date.now() - 10_000)))).limit(1);
    if (recent.length) throw new Error("短時間の連続利用です。少し待ってから再度お試しください。");
    await tx.insert(usageRecords).values({ id, guildId, userId, jobId, mode, model: "pending", period });
    await tx.insert(agentJobs).values({ id: jobId, guildId, requesterId: userId, state: "PLANNING", mode, idempotencyKey: jobId, instruction, expiresAt: new Date(Date.now() + 600_000) });
  });
  return { id, period };
}

export async function finishUsage(reservation: UsageReservation, model: string, inputTokens: number, outputTokens: number): Promise<void> {
  const inputRate = Number(process.env.AI_INPUT_USD_PER_MILLION ?? "0");
  const outputRate = Number(process.env.AI_OUTPUT_USD_PER_MILLION ?? "0");
  const cost = ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000;
  await db.update(usageRecords).set({ model, inputTokens, outputTokens, estimatedCostUsd: cost.toFixed(8) }).where(eq(usageRecords.id, reservation.id));
}

export async function failUsageReservation(reservation: UsageReservation): Promise<void> {
  await db.update(usageRecords).set({ model: "failed" }).where(and(eq(usageRecords.id, reservation.id), eq(usageRecords.model, "pending")));
}
