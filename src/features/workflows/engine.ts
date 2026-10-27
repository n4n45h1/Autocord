import { randomInt, randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonStyle, ChannelType, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type Client, type Guild, type GuildMember, type Interaction, type Message, type MessageReaction, type ModalSubmitInteraction, type StringSelectMenuInteraction, type User, type VoiceState,
} from "discord.js";
import { and, eq, gt, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentJobSteps, agentJobs, auditEvents, giveaways, giveawayEntries, giveawayNotifications, interactiveWorkflowRevisions, interactiveWorkflows, managedChannels, managedRoles, workflowCollections, workflowEntries, workflowMessages, workflowRuns, workflowStates, workflowSchedules, workflowVoiceChannels, workflowWaits } from "../../db/schema.js";
import { interactiveWorkflowSchema, orderInteractiveWorkflowSteps, type InteractiveWorkflow, type InteractiveWorkflowStep } from "../../agent/interactive-workflow.js";
import { assertSelfAssignableRole } from "../../policy.js";
import { withGuildAdvisoryLock } from "../../jobs/claim.js";
import { evaluateWorkflowCondition, renderWorkflowTemplate } from "./conditions.js";
import { renderInteractiveWorkflow } from "./render.js";
import { addWorkflowCollectionItem, debitWorkflowNumber, mutateWorkflowNumber } from "./data.js";
import { calculateAggregateMath, calculateBinaryMath, calculateClamp, selectWeighted } from "./math.js";
import { nextWeeklyOccurrence } from "./schedule.js";
import { buildWorkflowPrivateOverwrites, mayCloseWorkflowChannel } from "./permissions.js";
import { drawWinners, giveawayResultMessage } from "../giveaways/draw.js";

type WorkflowRecord = typeof interactiveWorkflows.$inferSelect;
type WorkflowVoiceSession = typeof workflowVoiceChannels.$inferSelect;
type WorkflowVoiceContext = { sourceChannelId: string; memberCount: number; session: WorkflowVoiceSession | null };
const workflowPermissionNames = ["ManageGuild", "ManageRoles", "ManageChannels", "MoveMembers", "Administrator"] as const;
const suppressedRoleEvents = new Map<string, { count: number; expiresAt: number }>();
const activeWorkflowCache = new Map<string, { workflows: WorkflowRecord[]; expiresAt: number }>();

async function activeGuildWorkflows(guildId: string): Promise<WorkflowRecord[]> {
  const cached = activeWorkflowCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.workflows;
  const workflows = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.state, "ACTIVE")));
  activeWorkflowCache.set(guildId, { workflows, expiresAt: Date.now() + 15_000 });
  return workflows;
}

export function invalidateWorkflowCache(guildId: string): void {
  activeWorkflowCache.delete(guildId);
}

function scheduledTriggerDefinition(trigger: InteractiveWorkflow["triggers"][number]): string | null {
  if (trigger.event === "schedule") return JSON.stringify({ event: trigger.event, intervalSeconds: trigger.intervalSeconds });
  if (trigger.event === "schedule.at") return JSON.stringify({ event: trigger.event, dayOfWeek: trigger.dayOfWeek, hour: trigger.hour, minute: trigger.minute, timeZone: trigger.timeZone });
  if (trigger.event === "deadline") return JSON.stringify({ event: trigger.event, afterSeconds: trigger.afterSeconds });
  return null;
}

function scheduledTriggerNextAt(trigger: InteractiveWorkflow["triggers"][number], now: Date): Date {
  if (trigger.event === "schedule") return new Date(now.getTime() + trigger.intervalSeconds * 1000);
  if (trigger.event === "deadline") return new Date(now.getTime() + trigger.afterSeconds * 1000);
  if (trigger.event === "schedule.at") return nextWeeklyOccurrence(now, trigger.dayOfWeek, trigger.hour, trigger.minute, trigger.timeZone);
  throw new Error(`Trigger ${trigger.id} is not scheduled.`);
}

export function suppressWorkflowRoleEvent(guildId: string, memberId: string, roleId: string, event: "added" | "removed"): void {
  const key = `${guildId}:${memberId}:${roleId}:${event}`;
  const existing = suppressedRoleEvents.get(key);
  suppressedRoleEvents.set(key, { count: (existing?.expiresAt ?? 0) > Date.now() ? existing!.count + 1 : 1, expiresAt: Date.now() + 5000 });
}

function consumeSuppressedRoleEvent(guildId: string, memberId: string, roleId: string, event: "added" | "removed"): boolean {
  const key = `${guildId}:${memberId}:${roleId}:${event}`;
  const suppression = suppressedRoleEvents.get(key);
  if (!suppression) return false;
  if (suppression.expiresAt <= Date.now()) { suppressedRoleEvents.delete(key); return false; }
  if (suppression.count <= 1) suppressedRoleEvents.delete(key);
  else suppressedRoleEvents.set(key, { ...suppression, count: suppression.count - 1 });
  return true;
}

function workflowConditionCollections(condition: InteractiveWorkflow["components"][number]["disabledWhen"] | InteractiveWorkflow["triggers"][number]["steps"][number]["when"], names: Set<string>): void {
  if (!condition) return;
  if (condition.op === "not") workflowConditionCollections(condition.condition, names);
  else if (condition.op === "and" || condition.op === "or") condition.conditions.forEach((child) => workflowConditionCollections(child, names));
  else if (condition.op === "list.contains" && condition.collection) names.add(condition.collection);
}

function workflowConditionStateKeys(condition: InteractiveWorkflow["components"][number]["disabledWhen"] | InteractiveWorkflow["triggers"][number]["steps"][number]["when"], keys: Set<string>): void {
  if (!condition) return;
  if (condition.op === "not") workflowConditionStateKeys(condition.condition, keys);
  else if (condition.op === "and" || condition.op === "or") condition.conditions.forEach((child) => workflowConditionStateKeys(child, keys));
  else if ("scope" in condition && "key" in condition && typeof condition.key === "string") keys.add(condition.key);
}

function workflowTemplateStateKeys(value: unknown, keys: Set<string>): void {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(/\{\{state:(?:workflow|guild|member):([a-z0-9._-]{1,40})\}\}/g)) keys.add(match[1]!);
}

export async function publishInteractiveWorkflow(input: {
  jobId: string;
  leaseOwner: string;
  guild: Guild;
  guildId: string;
  channelId: string;
  ownerId: string;
  workflow: InteractiveWorkflow;
}): Promise<string> {
  const { jobId, leaseOwner, guild, guildId, channelId, ownerId, workflow } = input;
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error("Workflow公開先チャンネルに送信できません。");
  const bot = guild.members.me;
  if (!bot || !channel.permissionsFor(bot)?.has(PermissionFlagsBits.SendMessages)) throw new Error("BotにWorkflow公開先のメッセージ送信権限がありません。");
  const configuredWorkflowLimit = Number(process.env.MAX_ACTIVE_WORKFLOWS_PER_GUILD ?? 50);
  const workflowLimit = Number.isFinite(configuredWorkflowLimit) ? Math.max(1, Math.min(500, configuredWorkflowLimit)) : 50;
  const [activeWorkflows] = await db.select({ count: sql<number>`count(*)::int` }).from(interactiveWorkflows).where(and(eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.state, "ACTIVE")));
  if ((activeWorkflows?.count ?? 0) >= workflowLimit) throw new Error("このサーバーのActive Workflow保存上限に達しました。");
  const workflowId = randomUUID();
  let message: Awaited<ReturnType<typeof channel.send>> | undefined;
  let sendUncertain = false;
  try {
    const [publishStep] = await db.update(agentJobSteps).set({ state: "EXECUTING", attempts: sql`${agentJobSteps.attempts} + 1`, startedAt: new Date() })
      .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, "publish"), eq(agentJobSteps.state, "PENDING"))).returning({ id: agentJobSteps.id });
    if (!publishStep) throw new Error("Workflow publish step is not pending.");
    sendUncertain = true;
    message = await channel.send(renderInteractiveWorkflow(workflowId, workflow, { entries: {}, states: {}, roleNames: new Set(), permissions: new Set() }));
    sendUncertain = false;
    await db.transaction(async (tx) => {
      await tx.insert(interactiveWorkflows).values({ id: workflowId, guildId, channelId, messageId: message!.id, ownerId, name: workflow.name, version: 1, state: "ACTIVE", spec: workflow });
      const schedules = workflow.triggers.flatMap((trigger) => {
        if (!scheduledTriggerDefinition(trigger)) return [];
        const intervalSeconds = trigger.event === "schedule" ? trigger.intervalSeconds : null;
        const nextAt = scheduledTriggerNextAt(trigger, new Date());
        return [{ id: randomUUID(), workflowId, guildId, triggerId: trigger.id, event: trigger.event, intervalSeconds, nextAt, state: "ACTIVE" }];
      });
      if (schedules.length) await tx.insert(workflowSchedules).values(schedules);
      const completed = await tx.update(agentJobs).set({ state: "COMPLETED", leaseExpiresAt: null, updatedAt: new Date() })
        .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner))).returning({ id: agentJobs.id });
      if (!completed.length) throw new Error("Workflow publish lease expired.");
      await tx.update(agentJobSteps).set({ state: "COMPLETED", result: { workflowId, messageId: message!.id, version: 1 }, completedAt: new Date() })
        .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, "publish"), eq(agentJobSteps.state, "EXECUTING")));
      await tx.update(agentJobSteps).set({ state: "INSTALLED", completedAt: new Date() }).where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "DEFINED")));
      await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId: ownerId, action: "workflow.published", outcome: "success", detail: { workflowId, messageId: message!.id, version: 1 } });
    });
    invalidateWorkflowCache(guildId);
    return `Interactive Workflow「${workflow.name}」を公開しました。ID: ${workflowId}`;
  } catch (error) {
    let compensationFailed = sendUncertain;
    if (message) {
      try { await message.delete(); }
      catch { compensationFailed = true; }
    }
    const state = compensationFailed ? "RECOVERY_REQUIRED" : "FAILED";
    await db.update(agentJobSteps).set({ state, errorDetail: { message: error instanceof Error ? error.message : "unknown" }, completedAt: new Date() })
      .where(and(eq(agentJobSteps.jobId, jobId), inArray(agentJobSteps.state, ["PENDING", "EXECUTING"])));
    await db.update(agentJobSteps).set({ state: "BLOCKED", errorDetail: { reason: "Workflow was not published" } })
      .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "DEFINED")));
    await db.update(agentJobs).set({ state, leaseExpiresAt: null, errorDetail: { message: error instanceof Error ? error.message : "unknown", compensationFailed }, updatedAt: new Date() })
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)));
    throw error;
  }
}

export async function updateInteractiveWorkflow(input: {
  jobId: string;
  leaseOwner: string;
  guild: Guild;
  guildId: string;
  ownerId: string;
  workflowId: string;
  expectedVersion: number;
  workflow: InteractiveWorkflow;
}): Promise<string> {
  const { jobId, leaseOwner, guild, guildId, ownerId, workflowId, expectedVersion, workflow } = input;
  return withGuildAdvisoryLock(`workflow:${workflowId}`, async () => {
    const [current] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
    if (!current || current.version !== expectedVersion) throw new Error("Workflowのrevisionが変わりました。再選択してプレビューし直してください。");
    const [step] = await db.update(agentJobSteps).set({ state: "EXECUTING", attempts: sql`${agentJobSteps.attempts} + 1`, startedAt: new Date() })
      .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, "update"), eq(agentJobSteps.state, "PENDING"))).returning({ id: agentJobSteps.id });
    if (!step) throw new Error("Workflow update step is not pending.");
    const channel = await guild.channels.fetch(current.channelId);
    if (!channel?.isSendable()) throw new Error("Workflow message channel is unavailable.");
    const message = await channel.messages.fetch(current.messageId);
    const previousSpec = interactiveWorkflowSchema.parse(current.spec);
    const previousView = await workflowView(current.id, guild);
    const nextVersion = current.version + 1;
    let messageUpdateUncertain = false;
    try {
      messageUpdateUncertain = true;
      const rendered = renderInteractiveWorkflow(workflowId, workflow, previousView.view);
      await message.edit({ components: rendered.components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      messageUpdateUncertain = false;
      await db.transaction(async (tx) => {
        const updated = await tx.update(interactiveWorkflows).set({ name: workflow.name, version: nextVersion, spec: workflow, updatedAt: new Date() })
          .where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, guildId), eq(interactiveWorkflows.version, expectedVersion), eq(interactiveWorkflows.state, "ACTIVE"))).returning({ id: interactiveWorkflows.id });
        if (!updated.length) throw new Error("Workflow revision changed during update.");
        await tx.insert(interactiveWorkflowRevisions).values({ id: randomUUID(), workflowId, guildId, jobId, actorId: ownerId, version: nextVersion, beforeSpec: previousSpec, afterSpec: workflow });
        const existingSchedules = await tx.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, workflowId));
        const currentById = new Map(workflow.triggers.map((trigger) => [trigger.id, trigger]));
        const previousById = new Map(previousSpec.triggers.map((trigger) => [trigger.id, trigger]));
        const scheduledIds = new Set<string>();
        const now = new Date();
        for (const schedule of existingSchedules) {
          const nextTrigger = currentById.get(schedule.triggerId);
          const previousTrigger = previousById.get(schedule.triggerId);
          const nextDefinition = nextTrigger ? scheduledTriggerDefinition(nextTrigger) : null;
          const previousDefinition = previousTrigger ? scheduledTriggerDefinition(previousTrigger) : null;
          if (!nextTrigger || !nextDefinition) {
            await tx.update(workflowSchedules).set({ state: "CANCELLED", leaseOwner: null, leaseExpiresAt: null }).where(eq(workflowSchedules.id, schedule.id));
            continue;
          }
          scheduledIds.add(schedule.triggerId);
          if (nextDefinition !== previousDefinition) {
            await tx.update(workflowSchedules).set({ event: nextTrigger.event, intervalSeconds: nextTrigger.event === "schedule" ? nextTrigger.intervalSeconds : null, nextAt: scheduledTriggerNextAt(nextTrigger, now), state: "ACTIVE", leaseOwner: null, leaseExpiresAt: null, attempts: 0, lastError: null }).where(eq(workflowSchedules.id, schedule.id));
          }
        }
        const newSchedules = workflow.triggers.flatMap((trigger) => scheduledIds.has(trigger.id) || !scheduledTriggerDefinition(trigger) ? [] : [{
          id: randomUUID(), workflowId, guildId, triggerId: trigger.id, event: trigger.event,
          intervalSeconds: trigger.event === "schedule" ? trigger.intervalSeconds : null,
          nextAt: scheduledTriggerNextAt(trigger, now), state: "ACTIVE",
        }]);
        if (newSchedules.length) await tx.insert(workflowSchedules).values(newSchedules);
        const completed = await tx.update(agentJobs).set({ state: "COMPLETED", leaseExpiresAt: null, updatedAt: new Date() })
          .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner))).returning({ id: agentJobs.id });
        if (!completed.length) throw new Error("Workflow update lease expired.");
        await tx.update(agentJobSteps).set({ state: "COMPLETED", result: { workflowId, version: nextVersion }, completedAt: new Date() })
          .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, "update"), eq(agentJobSteps.state, "EXECUTING")));
        await tx.update(agentJobSteps).set({ state: "INSTALLED", completedAt: new Date() })
          .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "DEFINED")));
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId: ownerId, action: "workflow.updated", outcome: "success", detail: { workflowId, beforeVersion: expectedVersion, version: nextVersion } });
      });
      invalidateWorkflowCache(guildId);
      return `Interactive Workflow「${workflow.name}」をv${nextVersion}へ更新しました。`;
    } catch (error) {
      let compensationFailed = messageUpdateUncertain;
      try {
        const restored = renderInteractiveWorkflow(workflowId, previousSpec, previousView.view);
        await message.edit({ components: restored.components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
        compensationFailed = false;
      } catch { compensationFailed = true; }
      const state = compensationFailed ? "RECOVERY_REQUIRED" : "FAILED";
      await db.update(agentJobs).set({ state, leaseExpiresAt: null, errorDetail: { message: error instanceof Error ? error.message : "unknown", compensationFailed }, updatedAt: new Date() })
        .where(and(eq(agentJobs.id, jobId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)));
      await db.update(agentJobSteps).set({ state, errorDetail: { message: error instanceof Error ? error.message : "unknown", compensationFailed }, completedAt: new Date() })
        .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "EXECUTING")));
      await db.update(agentJobSteps).set({ state: "BLOCKED", errorDetail: { reason: "Workflow update failed" } })
        .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "DEFINED")));
      throw error;
    }
  });
}

export async function controlInteractiveWorkflow(guild: Guild, workflowId: string, actor: GuildMember, action: "pause" | "resume" | "disable" | "delete"): Promise<string> {
  if (!actor.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error("Manage Server permission is required to control an Interactive Workflow.");
  const targetState = action === "pause" ? "PAUSED" : action === "resume" ? "ACTIVE" : action === "disable" ? "DISABLED" : "DELETED";
  const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, guild.id))).limit(1);
  if (!workflow) throw new Error("Interactive Workflow was not found in this Guild.");
  if (action === "pause" && workflow.state !== "ACTIVE" || action === "resume" && workflow.state !== "PAUSED" || (action === "disable" || action === "delete") && !["ACTIVE", "PAUSED"].includes(workflow.state)) throw new Error(`Workflow cannot transition from ${workflow.state} via ${action}.`);
  await db.transaction(async (tx) => {
    const [changed] = await tx.update(interactiveWorkflows).set({ state: targetState, updatedAt: new Date() }).where(and(
      eq(interactiveWorkflows.id, workflow.id), eq(interactiveWorkflows.guildId, guild.id), eq(interactiveWorkflows.state, workflow.state),
    )).returning({ id: interactiveWorkflows.id });
    if (!changed) throw new Error("Workflow state changed concurrently; refresh and retry.");
    if (action === "pause") {
      await tx.update(workflowSchedules).set({ state: "PAUSED", leaseOwner: null, leaseExpiresAt: null }).where(and(eq(workflowSchedules.workflowId, workflow.id), inArray(workflowSchedules.state, ["ACTIVE", "CLAIMED"])));
      await tx.update(workflowWaits).set({ state: "PAUSED", leaseOwner: null, leaseExpiresAt: null }).where(and(eq(workflowWaits.workflowId, workflow.id), inArray(workflowWaits.state, ["ACTIVE", "CLAIMED"])));
    } else if (action === "resume") {
      await tx.update(workflowSchedules).set({ state: "ACTIVE" }).where(and(eq(workflowSchedules.workflowId, workflow.id), eq(workflowSchedules.state, "PAUSED")));
      await tx.update(workflowWaits).set({ state: "ACTIVE" }).where(and(eq(workflowWaits.workflowId, workflow.id), eq(workflowWaits.state, "PAUSED")));
    } else {
      await tx.update(workflowSchedules).set({ state: "CANCELLED", leaseOwner: null, leaseExpiresAt: null }).where(and(eq(workflowSchedules.workflowId, workflow.id), inArray(workflowSchedules.state, ["ACTIVE", "CLAIMED", "PAUSED"])));
      await tx.update(workflowWaits).set({ state: "CANCELLED", leaseOwner: null, leaseExpiresAt: null }).where(and(eq(workflowWaits.workflowId, workflow.id), inArray(workflowWaits.state, ["ACTIVE", "CLAIMED", "PAUSED"])));
      await tx.update(workflowRuns).set({ state: "CANCELLED", errorDetail: { reason: `Workflow ${targetState.toLowerCase()}` }, updatedAt: new Date() }).where(and(eq(workflowRuns.workflowId, workflow.id), eq(workflowRuns.state, "WAITING")));
    }
    await tx.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: guild.id, actorId: actor.id, action: `workflow.${action}`, outcome: "success", detail: { workflowId, previousState: workflow.state, state: targetState } });
  });
  invalidateWorkflowCache(guild.id);
  if (action === "delete") {
    const channel = await guild.channels.fetch(workflow.channelId).catch(() => null);
    if (channel?.isTextBased()) await channel.messages.delete(workflow.messageId).catch(() => undefined);
    return `Workflow ${workflow.name}を削除状態にしました。公開メッセージを削除し、スケジュール/待機を取消しました。Workflow所有のRole/Channelは削除せず、管理台帳に残しています。`;
  }
  if (action === "disable") return `Workflow ${workflow.name}を無効化しました。公開メッセージと所有リソースは保持し、スケジュール/待機は取消しました。`;
  return action === "pause" ? `Workflow ${workflow.name}を一時停止しました。スケジュールと待機時刻は保持しています。` : `Workflow ${workflow.name}を再開しました。保存済みスケジュール/待機を再有効化しました。`;
}

async function workflowView(workflowId: string, guild: Guild, member?: GuildMember, inputs?: Record<string, string>, selected?: readonly string[]) {
  const entries: Record<string, number> = {};
  const spec = interactiveWorkflowSchema.parse((await db.select({ spec: interactiveWorkflows.spec }).from(interactiveWorkflows).where(eq(interactiveWorkflows.id, workflowId)).limit(1))[0]?.spec);
  const entryCollectionNames = new Set<string>();
  for (const trigger of spec.triggers) for (const step of trigger.steps) if (step.action === "entry.join" || step.action === "entry.leave") entryCollectionNames.add(step.collection);
  for (const collection of entryCollectionNames) {
    const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowEntries).where(and(eq(workflowEntries.workflowId, workflowId), eq(workflowEntries.collection, collection)));
    entries[collection] = count?.count ?? 0;
  }
  const usedStateKeys = new Set<string>(["panel.description"]);
  for (const component of spec.components) workflowConditionStateKeys(component.disabledWhen, usedStateKeys);
  for (const trigger of spec.triggers) for (const step of trigger.steps) {
    workflowConditionStateKeys(step.when, usedStateKeys);
    for (const value of Object.values(step)) workflowTemplateStateKeys(value, usedStateKeys);
  }
  workflowTemplateStateKeys(spec.description, usedStateKeys);
  const stateRows = await db.select().from(workflowStates).where(and(
    eq(workflowStates.workflowId, workflowId), inArray(workflowStates.key, [...usedStateKeys]),
    or(and(eq(workflowStates.scope, "workflow"), eq(workflowStates.scopeId, workflowId)), and(eq(workflowStates.scope, "guild"), eq(workflowStates.scopeId, guild.id)), ...(member ? [and(eq(workflowStates.scope, "member"), eq(workflowStates.scopeId, member.id))] : [])),
  ));
  const states = Object.fromEntries(stateRows.map((row) => [`${row.scope}:${row.key}`, row.value]));
  const collections: Record<string, unknown[]> = {};
  const usedCollectionNames = new Set<string>();
  for (const component of spec.components) workflowConditionCollections(component.disabledWhen, usedCollectionNames);
  for (const trigger of spec.triggers) for (const step of trigger.steps) workflowConditionCollections(step.when, usedCollectionNames);
  if (usedCollectionNames.size) {
    const collectionRows = await db.select({ scope: workflowCollections.scope, collection: workflowCollections.collection, item: workflowCollections.item }).from(workflowCollections).where(and(
      eq(workflowCollections.workflowId, workflowId), inArray(workflowCollections.collection, [...usedCollectionNames]),
      or(and(eq(workflowCollections.scope, "workflow"), eq(workflowCollections.scopeId, workflowId)), and(eq(workflowCollections.scope, "guild"), eq(workflowCollections.scopeId, guild.id)), ...(member ? [and(eq(workflowCollections.scope, "member"), eq(workflowCollections.scopeId, member.id))] : [])),
    )).orderBy(workflowCollections.createdAt);
    for (const row of collectionRows) (collections[`${row.scope}:${row.collection}`] ??= []).push(row.item);
  }
  const permissions = new Set(workflowPermissionNames.filter((permission) => member?.permissions.has(PermissionFlagsBits[permission])));
  return {
    spec,
    view: {
      entries,
      states,
      collections,
      roleNames: new Set(member?.roles.cache.map((role) => role.name) ?? []),
      permissions,
      ...(inputs ? { inputs } : {}),
      ...(selected ? { selected } : {}),
      ...(member ? { actorId: member.id } : {}),
    },
  };
}

async function refreshWorkflowPanel(workflow: WorkflowRecord, guild: Guild, member?: GuildMember, inputs?: Record<string, string>, selected?: readonly string[]): Promise<void> {
  const { spec, view } = await workflowView(workflow.id, guild, member, inputs, selected);
  const channel = await guild.channels.fetch(workflow.channelId);
  if (!channel?.isSendable()) throw new Error("Interactive Workflowの公開チャンネルが利用できません。");
  const message = await channel.messages.fetch(workflow.messageId);
  const rendered = renderInteractiveWorkflow(workflow.id, spec, view);
  await message.edit({ components: rendered.components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
}

function resolveTemplate(value: unknown, context: { entries: Record<string, number>; states: Record<string, unknown>; results?: Record<string, unknown>; inputs: Record<string, string>; selected: readonly string[]; actorId?: string }): unknown {
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{(state|input|result):([^}:]+)(?::([^}]+))?\}\}$/);
  if (exact?.[1] === "input") return context.inputs[exact[2]!] ?? "";
  if (exact?.[1] === "state") return context.states[`${exact[2]}:${exact[3] ?? ""}`] ?? null;
  if (exact?.[1] === "result") {
    const result = context.results?.[exact[2]!];
    return result && typeof result === "object" ? (result as Record<string, unknown>)[exact[3]!] ?? null : null;
  }
  return renderWorkflowTemplate(value, context);
}

function scopedStateId(scope: "workflow" | "guild" | "member", workflow: WorkflowRecord, member?: GuildMember): string {
  if (scope === "workflow") return workflow.id;
  if (scope === "guild") return workflow.guildId;
  if (!member) throw new Error("Member-scoped state requires an interaction member.");
  return member.id;
}

function assertWritableStateKey(scope: "workflow" | "guild" | "member", key: string): void {
  if (scope === "workflow" && (key === "active_giveaway_id" || key === "panel.description")) throw new Error(`State key is reserved by Autocord: ${key}`);
}

function resolvedNumber(value: number | string, context: Parameters<typeof resolveTemplate>[1]): number {
  const resolved = resolveTemplate(value, context);
  if (typeof resolved !== "number" || !Number.isFinite(resolved)) throw new Error("Math operand did not resolve to a finite number.");
  return resolved;
}

function resolvedScalar(value: unknown, context: Parameters<typeof resolveTemplate>[1]): string | number | boolean | null {
  const resolved = resolveTemplate(value, context);
  if (resolved !== null && typeof resolved !== "string" && typeof resolved !== "number" && typeof resolved !== "boolean") throw new Error("Workflow value did not resolve to a scalar.");
  if (typeof resolved === "number" && !Number.isFinite(resolved)) throw new Error("Workflow scalar number must be finite.");
  if (typeof resolved === "string" && resolved.length > 1000) throw new Error("Workflow scalar string exceeds 1000 characters.");
  return resolved;
}

function workflowCollectionLimit(): number {
  const configured = Number(process.env.MAX_ITEMS_PER_WORKFLOW_COLLECTION ?? 1000);
  return Number.isFinite(configured) ? Math.max(1, Math.min(10000, configured)) : 1000;
}

function workflowTicketLimit(): number {
  const configured = Number(process.env.MAX_TICKETS_PER_WORKFLOW ?? 100);
  return Number.isFinite(configured) ? Math.max(1, Math.min(1000, configured)) : 100;
}

function workflowRunLimitMs(): number {
  const configured = Number(process.env.MAX_WORKFLOW_RUN_MS ?? 30_000);
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(120_000, configured)) : 30_000;
}

async function loadManagedRole(guildId: string, guild: Guild, roleName: string) {
  const owned = await db.select({ roleId: managedRoles.roleId, ownerJobId: managedRoles.ownerJobId }).from(managedRoles).where(eq(managedRoles.guildId, guildId));
  const matches = [];
  for (const binding of owned) {
    const role = guild.roles.cache.get(binding.roleId) ?? await guild.roles.fetch(binding.roleId).catch(() => null);
    if (role?.name === roleName) matches.push({ role, ownerJobId: binding.ownerJobId });
  }
  if (matches.length !== 1) throw new Error(matches.length ? `Managed role name is ambiguous: ${roleName}` : `Autocord-managed role not found: ${roleName}`);
  return matches[0]!;
}

async function findWorkflowOwnedRole(workflow: WorkflowRecord, guild: Guild, name: string) {
  const bindings = await db.select({ roleId: managedRoles.roleId }).from(managedRoles).where(and(eq(managedRoles.guildId, workflow.guildId), eq(managedRoles.ownerJobId, workflow.id)));
  for (const binding of bindings) {
    const role = guild.roles.cache.get(binding.roleId) ?? await guild.roles.fetch(binding.roleId).catch(() => null);
    if (role?.name === name) return role;
  }
  return null;
}

async function findWorkflowOwnedChannel(workflow: WorkflowRecord, guild: Guild, name: string, kind: "category" | "text" | "voice", parentId?: string | null) {
  const bindings = await db.select({ channelId: managedChannels.channelId }).from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.ownerJobId, workflow.id), eq(managedChannels.kind, kind)));
  for (const binding of bindings) {
    const channel = guild.channels.cache.get(binding.channelId) ?? await guild.channels.fetch(binding.channelId).catch(() => null);
    const categoryMatches = kind === "category" ? channel?.type === ChannelType.GuildCategory : kind === "voice" ? channel?.type === ChannelType.GuildVoice : channel?.type === ChannelType.GuildText && channel.parentId === (parentId ?? null);
    if (categoryMatches && channel?.name === name) return channel;
  }
  return null;
}

async function workflowOwnedChannelForStep(workflow: WorkflowRecord, guild: Guild, stepId: string, results: Record<string, unknown>) {
  const result = results[stepId];
  const channelId = result && typeof result === "object" ? (result as { channelId?: unknown }).channelId : null;
  if (typeof channelId !== "string") throw new Error(`Channel result is missing from step ${stepId}.`);
  const [binding] = await db.select().from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.channelId, channelId), eq(managedChannels.ownerJobId, workflow.id))).limit(1);
  if (!binding) throw new Error(`Channel ${channelId} is not owned by Workflow ${workflow.id}.`);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error(`Workflow-owned channel ${channelId} no longer exists.`);
  return { channel, binding };
}

async function workflowOwnedChannelById(workflow: WorkflowRecord, guild: Guild, channelId: unknown) {
  if (typeof channelId !== "string" || !channelId) throw new Error("Workflow channel ID did not resolve to a valid ID.");
  const [binding] = await db.select().from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.channelId, channelId), eq(managedChannels.ownerJobId, workflow.id))).limit(1);
  if (!binding) throw new Error(`Channel ${channelId} is not owned by Workflow ${workflow.id}.`);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new Error(`Workflow-owned channel ${channelId} no longer exists.`);
  return { channel, binding };
}

function workflowResourceLimit(): number {
  const configured = Number(process.env.MAX_RESOURCES_PER_WORKFLOW ?? 10);
  return Number.isFinite(configured) ? Math.max(1, Math.min(50, configured)) : 10;
}

async function workflowOwnedResourceCount(workflow: WorkflowRecord): Promise<number> {
  const [roles] = await db.select({ count: sql<number>`count(*)::int` }).from(managedRoles).where(and(eq(managedRoles.guildId, workflow.guildId), eq(managedRoles.ownerJobId, workflow.id)));
  const [channels] = await db.select({ count: sql<number>`count(*)::int` }).from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.ownerJobId, workflow.id), notInArray(managedChannels.kind, ["ticket"])));
  return (roles?.count ?? 0) + (channels?.count ?? 0);
}

async function loadWorkflowGiveaway(workflow: WorkflowRecord, giveawayId: string) {
  const [binding] = await db.select({ value: workflowStates.value }).from(workflowStates).where(and(
    eq(workflowStates.workflowId, workflow.id), eq(workflowStates.scope, "workflow"), eq(workflowStates.scopeId, workflow.id), eq(workflowStates.key, "active_giveaway_id"),
  )).limit(1);
  if (binding?.value !== giveawayId) throw new Error("Giveaway is not the active Giveaway owned by this Workflow.");
  const [giveaway] = await db.select().from(giveaways).where(and(eq(giveaways.id, giveawayId), eq(giveaways.guildId, workflow.guildId))).limit(1);
  if (!giveaway) throw new Error("Workflow-owned Giveaway no longer exists.");
  return giveaway;
}

async function findActiveVoiceSession(workflowId: string, guildId: string, sourceChannelId: string): Promise<WorkflowVoiceSession | null> {
  const [session] = await db.select().from(workflowVoiceChannels).where(and(
    eq(workflowVoiceChannels.workflowId, workflowId), eq(workflowVoiceChannels.guildId, guildId),
    eq(workflowVoiceChannels.sourceChannelId, sourceChannelId), eq(workflowVoiceChannels.state, "ACTIVE"),
  )).orderBy(sql`${workflowVoiceChannels.createdAt} desc`).limit(1);
  return session ?? null;
}

async function closeVoiceSession(session: WorkflowVoiceSession, guild: Guild, onlyWhenEmpty: boolean): Promise<boolean> {
  const [owned] = await db.select({ channelId: managedChannels.channelId }).from(managedChannels).where(and(
    eq(managedChannels.guildId, session.guildId), eq(managedChannels.channelId, session.voiceChannelId), eq(managedChannels.ownerJobId, session.workflowId), eq(managedChannels.kind, "voice"),
  )).limit(1);
  if (!owned) throw new Error("Voice channel is not owned by this Workflow.");
  const channel = guild.channels.cache.get(session.voiceChannelId) ?? await guild.channels.fetch(session.voiceChannelId).catch(() => null);
  if (channel && channel.type !== ChannelType.GuildVoice) throw new Error("Workflow-owned resource is no longer a Voice Channel.");
  if (onlyWhenEmpty && channel?.type === ChannelType.GuildVoice && channel.members.size > 0) return false;
  if (channel) {
    const bot = guild.members.me;
    if (!bot || !channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot lacks Manage Channels on the Workflow-owned Voice Channel.");
    await channel.delete(`Empty temporary Voice Channel for Workflow ${session.workflowId}`);
  }
  await db.transaction(async (tx) => {
    await tx.update(workflowVoiceChannels).set({ state: "CLOSED", closedAt: new Date() }).where(and(eq(workflowVoiceChannels.id, session.id), eq(workflowVoiceChannels.state, "ACTIVE")));
    await tx.delete(managedChannels).where(and(eq(managedChannels.guildId, session.guildId), eq(managedChannels.channelId, session.voiceChannelId), eq(managedChannels.ownerJobId, session.workflowId), eq(managedChannels.kind, "voice")));
  });
  return true;
}

async function evaluateStepCondition(step: InteractiveWorkflowStep, workflowId: string, guild: Guild, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[], results: Record<string, unknown>, voice?: WorkflowVoiceContext): Promise<boolean> {
  if (!step.when) return true;
  const context = await workflowView(workflowId, guild, member, inputs, selected);
  return evaluateWorkflowCondition(step.when, { ...context.view, results, ...(voice ? { voice: { memberCount: voice.memberCount, sessionExists: Boolean(voice.session) } } : {}) });
}

async function workflowOwnedMessage(workflow: WorkflowRecord, runId: string, stepId: string) {
  const [message] = await db.select().from(workflowMessages).where(and(
    eq(workflowMessages.workflowId, workflow.id), eq(workflowMessages.guildId, workflow.guildId),
    eq(workflowMessages.runId, runId), eq(workflowMessages.stepId, stepId), eq(workflowMessages.state, "ACTIVE"),
  )).limit(1);
  if (!message) throw new Error(`Workflow-owned message not found for step ${stepId}.`);
  return message;
}

async function fetchWorkflowMessage(guild: Guild, channelId: string, messageId: string) {
  const channel = await guild.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error("Workflow message channel is unavailable or not text-based.");
  return { channel, message: await channel.messages.fetch(messageId) };
}

async function executeWorkflowStep(workflow: WorkflowRecord, runId: string, step: InteractiveWorkflowStep, guild: Guild, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[], results: Record<string, unknown>, voice?: WorkflowVoiceContext): Promise<unknown> {
  const { view } = await workflowView(workflow.id, guild, member, inputs, selected);
  const templateContext = { ...view, results, inputs, selected, ...(member ? { actorId: member.id } : {}) };
  switch (step.action) {
    case "entry.join": {
      if (!member) throw new Error("Entry registration requires a member-triggered interaction.");
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workflow.id}:${step.collection}`}))`);
        const prior = await tx.select({ userId: workflowEntries.userId }).from(workflowEntries).where(and(eq(workflowEntries.workflowId, workflow.id), eq(workflowEntries.collection, step.collection), eq(workflowEntries.userId, member.id))).limit(1);
        const count = await tx.select({ count: sql<number>`count(*)::int` }).from(workflowEntries).where(and(eq(workflowEntries.workflowId, workflow.id), eq(workflowEntries.collection, step.collection)));
        const current = count[0]?.count ?? 0;
        if (prior.length) return { joined: false, duplicate: true, count: current, full: current >= step.maxEntries };
        if (current >= step.maxEntries) return { joined: false, duplicate: false, count: current, full: true };
        await tx.insert(workflowEntries).values({ workflowId: workflow.id, collection: step.collection, userId: member.id }).onConflictDoNothing();
        const nextCount = current + 1;
        return { joined: true, duplicate: false, count: nextCount, full: nextCount >= step.maxEntries };
      });
    }
    case "entry.leave": {
      if (!member) throw new Error("Entry cancellation requires a member-triggered interaction.");
      const removed = await db.delete(workflowEntries).where(and(eq(workflowEntries.workflowId, workflow.id), eq(workflowEntries.collection, step.collection), eq(workflowEntries.userId, member.id))).returning({ userId: workflowEntries.userId });
      return { left: removed.length > 0 };
    }
    case "state.set": {
      const value = resolvedScalar(step.value, templateContext);
      if (step.scope === "workflow" && step.key === "active_giveaway_id") {
        // Older workflows explicitly save the ID already bound by giveaway.create.
        if (typeof value !== "string" || !value) throw new Error("Workflow Giveaway reference did not resolve to an ID.");
        await loadWorkflowGiveaway(workflow, value);
        return { key: step.key, scope: step.scope };
      }
      assertWritableStateKey(step.scope, step.key);
      const scopeId = scopedStateId(step.scope, workflow, member);
      await db.insert(workflowStates).values({ workflowId: workflow.id, scope: step.scope, scopeId, key: step.key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value, updatedAt: new Date() } });
      return { key: step.key, scope: step.scope };
    }
    case "state.get": {
      const scopeId = scopedStateId(step.scope, workflow, member);
      const [row] = await db.select({ value: workflowStates.value }).from(workflowStates).where(and(eq(workflowStates.workflowId, workflow.id), eq(workflowStates.scope, step.scope), eq(workflowStates.scopeId, scopeId), eq(workflowStates.key, step.key))).limit(1);
      return { exists: Boolean(row), value: row?.value ?? null };
    }
    case "state.increment":
    case "state.decrement":
    case "state.multiply": {
      assertWritableStateKey(step.scope, step.key);
      const scopeId = scopedStateId(step.scope, workflow, member);
      const amount = resolvedNumber(step.action === "state.multiply" ? step.factor : step.amount, templateContext);
      const next = await mutateWorkflowNumber({ workflowId: workflow.id, scope: step.scope, scopeId, key: step.key, operation: step.action.slice("state.".length) as "increment" | "decrement" | "multiply", amount });
      return { key: step.key, value: next };
    }
    case "state.debit": {
      assertWritableStateKey(step.scope, step.key);
      const scopeId = scopedStateId(step.scope, workflow, member);
      return debitWorkflowNumber({
        workflowId: workflow.id, scope: step.scope, scopeId, key: step.key,
        amount: resolvedNumber(step.amount, templateContext), minimumBalance: resolvedNumber(step.minimumBalance, templateContext),
        idempotencyKey: step.idempotencyKey,
      });
    }
    case "state.delete":
    case "state.reset": {
      const scopeId = scopedStateId(step.scope, workflow, member);
      if (step.action === "state.delete") {
        assertWritableStateKey(step.scope, step.key);
        await db.delete(workflowStates).where(and(eq(workflowStates.workflowId, workflow.id), eq(workflowStates.scope, step.scope), eq(workflowStates.scopeId, scopeId), eq(workflowStates.key, step.key)));
        return { deleted: true };
      }
      if (step.key === null) {
        await db.delete(workflowStates).where(and(eq(workflowStates.workflowId, workflow.id), eq(workflowStates.scope, step.scope), eq(workflowStates.scopeId, scopeId), notInArray(workflowStates.key, ["active_giveaway_id", "panel.description"])));
        return { reset: true, scope: step.scope };
      }
      assertWritableStateKey(step.scope, step.key);
      const value = resolvedScalar(step.value, templateContext);
      await db.insert(workflowStates).values({ workflowId: workflow.id, scope: step.scope, scopeId, key: step.key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value, updatedAt: new Date() } });
      return { reset: true, key: step.key };
    }
    case "state.append":
    case "state.remove": {
      assertWritableStateKey(step.scope, step.key);
      const scopeId = scopedStateId(step.scope, workflow, member);
      const value = resolvedScalar(step.value, templateContext);
      const lockKey = `${workflow.id}:${step.scope}:${scopeId}:${step.key}`;
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
        const [row] = await tx.select({ value: workflowStates.value }).from(workflowStates).where(and(eq(workflowStates.workflowId, workflow.id), eq(workflowStates.scope, step.scope), eq(workflowStates.scopeId, scopeId), eq(workflowStates.key, step.key))).limit(1);
        const current = row?.value ?? [];
        if (!Array.isArray(current)) throw new Error(`State ${step.key} is not a list.`);
        if (step.action === "state.append" && current.length >= 1000) throw new Error("State list item limit reached (1000).");
        const next = step.action === "state.append" ? [...current, value] : current.filter((item) => !Object.is(item, value));
        await tx.insert(workflowStates).values({ workflowId: workflow.id, scope: step.scope, scopeId, key: step.key, value: next, updatedAt: new Date() }).onConflictDoUpdate({ target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value: next, updatedAt: new Date() } });
        return { count: next.length, changed: next.length !== current.length };
      });
      return result;
    }
    case "math.add":
    case "math.subtract":
    case "math.multiply":
    case "math.divide": {
      const left = resolvedNumber(step.left, templateContext);
      const right = resolvedNumber(step.right, templateContext);
      return { value: calculateBinaryMath(step.action, left, right) };
    }
    case "math.min":
    case "math.max": {
      const values = step.values.map((value) => resolvedNumber(value, templateContext));
      return { value: calculateAggregateMath(step.action, values) };
    }
    case "math.clamp": {
      const value = resolvedNumber(step.value, templateContext);
      return { value: calculateClamp(value, step.min, step.max) };
    }
    case "random.integer": return { value: randomInt(step.min, step.max + 1) };
    case "random.choice": return { value: step.values[randomInt(0, step.values.length)] };
    case "random.weighted_choice": {
      const total = step.options.reduce((sum, option) => sum + option.weight, 0);
      return { value: selectWeighted(step.options, randomInt(total)) };
    }
    case "collection.add":
    case "collection.remove":
    case "collection.count":
    case "collection.contains":
    case "collection.list":
    case "collection.rank":
    case "collection.clear": {
      const scopeId = scopedStateId(step.scope, workflow, member);
      const sourceMessageId = inputs.__source_message_id;
      if (step.partitionByMessage && !sourceMessageId) throw new Error("partitionByMessage requires a message or reaction event context.");
      const collectionName = step.partitionByMessage ? `${step.collection.slice(0, 18)}-${sourceMessageId!.slice(-20)}` : step.collection;
      const base = and(eq(workflowCollections.workflowId, workflow.id), eq(workflowCollections.scope, step.scope), eq(workflowCollections.scopeId, scopeId), eq(workflowCollections.collection, collectionName));
      if (step.action === "collection.add") {
        const cap = Math.min(step.maxItems, workflowCollectionLimit());
        const item = resolvedScalar(step.item, templateContext);
        const added = await addWorkflowCollectionItem({
          workflowId: workflow.id, guildId: workflow.guildId, scope: step.scope, scopeId, collection: collectionName, item, maxItems: cap,
        });
        return { added, collection: collectionName };
      }
      if (step.action === "collection.remove") {
        const item = resolvedScalar(step.item, templateContext);
        const removed = await db.delete(workflowCollections).where(and(base, eq(workflowCollections.itemKey, JSON.stringify(item)))).returning({ id: workflowCollections.id });
        return { removed: removed.length > 0 };
      }
      if (step.action === "collection.clear") {
        const removed = await db.delete(workflowCollections).where(base).returning({ id: workflowCollections.id });
        return { removed: removed.length };
      }
      if (step.action === "collection.count") {
        const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowCollections).where(base);
        return { count: count?.count ?? 0 };
      }
      if (step.action === "collection.contains") {
        const resolved = resolvedScalar(step.item, templateContext);
        const [item] = await db.select({ id: workflowCollections.id }).from(workflowCollections).where(and(base, eq(workflowCollections.itemKey, JSON.stringify(resolved)))).limit(1);
        return { contains: Boolean(item) };
      }
      const rows = await db.select({ item: workflowCollections.item }).from(workflowCollections).where(base).orderBy(workflowCollections.createdAt).limit(step.action === "collection.list" ? step.limit : 10000);
      if (step.action === "collection.list") return { items: rows.map((row) => row.item) };
      const values = rows.map((row) => row.item);
      if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("collection.rank requires a collection of finite numeric values.");
      const numericValues = values as number[];
      const targetValue = resolvedNumber(step.value, templateContext);
      const rank = 1 + numericValues.filter((value) => step.order === "desc" ? value > targetValue : value < targetValue).length;
      return { rank, count: numericValues.length };
    }
    case "workflow.wait": return { deferSeconds: step.seconds };
    case "role.grant":
    case "role.revoke": {
      if (!member) throw new Error("Role operations require a member-triggered interaction.");
      const { role, ownerJobId } = await loadManagedRole(workflow.guildId, guild, step.roleName);
      assertSelfAssignableRole(guild, role, ownerJobId);
      const hasRole = member.roles.cache.has(role.id);
      const grant = step.action === "role.grant";
      if (grant && !hasRole) { suppressWorkflowRoleEvent(guild.id, member.id, role.id, "added"); await member.roles.add(role, `Interactive Workflow ${workflow.id}`); }
      if (!grant && hasRole) { suppressWorkflowRoleEvent(guild.id, member.id, role.id, "removed"); await member.roles.remove(role, `Interactive Workflow ${workflow.id}`); }
      return { roleId: role.id, granted: grant };
    }
    case "message.send": {
      const content = renderWorkflowTemplate(step.content, templateContext);
      const channel = step.delivery === "workflow_owner_dm"
        ? await (await guild.members.fetch(workflow.ownerId)).createDM()
        : step.delivery === "workflow_channel_step" && step.channelStepId
          ? (await workflowOwnedChannelForStep(workflow, guild, step.channelStepId, results)).channel
          : await guild.channels.fetch(workflow.channelId);
      if (!channel || !channel.isSendable()) throw new Error("Workflow message delivery target is not sendable.");
      const message = await channel.send({ content, allowedMentions: { parse: [] } });
      await db.insert(workflowMessages).values({ id: randomUUID(), workflowId: workflow.id, guildId: workflow.guildId, runId, stepId: step.id, channelId: message.channelId, messageId: message.id });
      return { messageId: message.id };
    }
    case "message.reply": {
      const channelId = inputs.__source_channel_id;
      const sourceMessageId = inputs.__source_message_id;
      if (!channelId || !sourceMessageId) throw new Error("message.reply requires a message.created event context.");
      const { message: source } = await fetchWorkflowMessage(guild, channelId, sourceMessageId);
      const content = renderWorkflowTemplate(step.content, templateContext);
      const message = await source.reply({ content, allowedMentions: { parse: [] } });
      await db.insert(workflowMessages).values({ id: randomUUID(), workflowId: workflow.id, guildId: workflow.guildId, runId, stepId: step.id, channelId: message.channelId, messageId: message.id });
      return { messageId: message.id, repliedTo: source.id };
    }
    case "message.dm": {
      const recipientId = step.recipient === "workflow_owner" ? workflow.ownerId : member?.id;
      if (!recipientId) throw new Error("message.dm trigger_member requires a member context.");
      const recipient = await guild.members.fetch(recipientId);
      const channel = await recipient.createDM();
      const message = await channel.send({ content: renderWorkflowTemplate(step.content, templateContext), allowedMentions: { parse: [] } });
      await db.insert(workflowMessages).values({ id: randomUUID(), workflowId: workflow.id, guildId: workflow.guildId, runId, stepId: step.id, channelId: message.channelId, messageId: message.id });
      return { messageId: message.id, recipientId };
    }
    case "message.edit": {
      const content = renderWorkflowTemplate(step.content, templateContext);
      if (step.targetStepId) {
        const target = await workflowOwnedMessage(workflow, runId, step.targetStepId);
        const { message } = await fetchWorkflowMessage(guild, target.channelId, target.messageId);
        await message.edit({ content, allowedMentions: { parse: [] } });
        return { messageId: message.id, edited: true };
      }
      await db.insert(workflowStates).values({ workflowId: workflow.id, scope: "workflow", scopeId: workflow.id, key: "panel.description", value: content, updatedAt: new Date() }).onConflictDoUpdate({ target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value: content, updatedAt: new Date() } });
      await refreshWorkflowPanel(workflow, guild, member, inputs, selected);
      return { panelUpdated: true };
    }
    case "message.delete":
    case "message.pin":
    case "message.unpin": {
      const target = await workflowOwnedMessage(workflow, runId, step.targetStepId);
      const { channel, message } = await fetchWorkflowMessage(guild, target.channelId, target.messageId);
      if (step.action === "message.delete") {
        await message.delete();
        await db.update(workflowMessages).set({ state: "DELETED" }).where(eq(workflowMessages.id, target.id));
        return { messageId: target.messageId, deleted: true };
      }
      const bot = guild.members.me;
      if (!("permissionsFor" in channel) || !bot || !channel.permissionsFor(bot)?.has(PermissionFlagsBits.ManageMessages)) throw new Error("Bot lacks Manage Messages to pin or unpin a Workflow-owned message.");
      if (step.action === "message.pin") await message.pin(`Pinned by Workflow ${workflow.id}`);
      else await message.unpin(`Unpinned by Workflow ${workflow.id}`);
      return { messageId: target.messageId, pinned: step.action === "message.pin" };
    }
    case "panel.refresh":
      await refreshWorkflowPanel(workflow, guild, member, inputs, selected);
      return { panelUpdated: true };
    case "voice.channel.create": {
      if (!voice || !member) throw new Error("Voice channel creation requires a VoiceState join event.");
      const source = await guild.channels.fetch(voice.sourceChannelId);
      if (!source || source.type !== ChannelType.GuildVoice) throw new Error("Configured Voice Lobby no longer exists.");
      const configuredLimit = Number(process.env.MAX_VOICE_MOVE_MEMBERS_PER_TRIGGER ?? 20);
      const moveLimit = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(50, configuredLimit)) : 20;
      const currentMembers = [...source.members.values()].filter((voiceMember) => !voiceMember.user.bot);
      if (step.moveMembers && currentMembers.length > moveLimit) throw new Error(`Voice Lobby has ${currentMembers.length} members; per-trigger move limit is ${moveLimit}.`);
      let session = await findActiveVoiceSession(workflow.id, workflow.guildId, source.id);
      let target = session ? await guild.channels.fetch(session.voiceChannelId).catch(() => null) : null;
      let createdNew = false;
      if (session && target?.type === ChannelType.GuildVoice) {
        const [binding] = await db.select({ channelId: managedChannels.channelId }).from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.channelId, target.id), eq(managedChannels.ownerJobId, workflow.id), eq(managedChannels.kind, "voice"))).limit(1);
        if (!binding) throw new Error("Existing voice session is not owned by this Workflow.");
      }
      if (!target || target.type !== ChannelType.GuildVoice) {
        if (session) await closeVoiceSession(session, guild, false);
        const resolvedName = renderWorkflowTemplate(step.name, { ...view, inputs, selected, ...(member ? { actorId: member.id } : {}) });
        const name = resolvedName.toLocaleLowerCase().normalize("NFKC").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || `voice-${workflow.id.slice(0, 8)}`;
        const bot = guild.members.me;
        const permissions = bot ? source.permissionsFor(bot) : null;
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers])) throw new Error("Bot lacks required permissions in the configured Voice Lobby.");
        target = await guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: source.parentId ?? undefined,
          permissionOverwrites: source.permissionOverwrites.cache.map((overwrite) => ({ id: overwrite.id, allow: overwrite.allow, deny: overwrite.deny, type: overwrite.type })),
          reason: `Interactive Workflow ${workflow.id}`,
        });
        const sessionId = randomUUID();
        try {
          await db.transaction(async (tx) => {
            await tx.insert(managedChannels).values({ guildId: workflow.guildId, channelId: target!.id, ownerJobId: workflow.id, kind: "voice" });
            await tx.insert(workflowVoiceChannels).values({ id: sessionId, workflowId: workflow.id, guildId: workflow.guildId, sourceChannelId: source.id, voiceChannelId: target!.id, state: "ACTIVE", createdBy: member.id });
          });
        } catch (error) {
          await target.delete(`Rollback failed Workflow voice session ${workflow.id}`).catch(() => undefined);
          throw error;
        }
        session = { id: sessionId, workflowId: workflow.id, guildId: workflow.guildId, sourceChannelId: source.id, voiceChannelId: target.id, state: "ACTIVE", createdBy: member.id, createdAt: new Date(), closedAt: null };
        createdNew = true;
      }
      let moved = 0;
      if (step.moveMembers) {
        for (const lobbyMember of currentMembers) {
          if (lobbyMember.voice.channelId !== target.id) {
            await lobbyMember.voice.setChannel(target, `Gathered by Interactive Workflow ${workflow.id}`);
            moved++;
          }
        }
      }
      if (!session) throw new Error("Workflow Voice session was not persisted.");
      return { sessionId: session.id, channelId: target.id, created: createdNew, membersMoved: moved };
    }
    case "voice.channel.delete": {
      if (!voice?.session) throw new Error("Voice channel delete requires an active Workflow-managed Voice session.");
      const closed = await closeVoiceSession(voice.session, guild, true);
      return { sessionId: voice.session.id, channelId: voice.session.voiceChannelId, deleted: closed };
    }
    case "channel.create_voice": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels])) throw new Error("Voice channel creation requires Manage Server and Manage Channels.");
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot lacks Manage Channels for channel.create_voice.");
      const name = renderWorkflowTemplate(step.name, templateContext).toLocaleLowerCase().normalize("NFKC").replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
      if (!name) throw new Error("Rendered Voice Channel name is empty or invalid.");
      const existing = await findWorkflowOwnedChannel(workflow, guild, name, "voice");
      if (existing) return { channelId: existing.id, name: existing.name, created: false };
      const cap = workflowResourceLimit();
      if (await workflowOwnedResourceCount(workflow) >= cap) throw new Error(`Workflow resource cap reached (${cap}).`);
      const channel = await guild.channels.create({ name, type: ChannelType.GuildVoice, reason: `Interactive Workflow ${workflow.id}` });
      try { await db.insert(managedChannels).values({ guildId: workflow.guildId, channelId: channel.id, ownerJobId: workflow.id, kind: "voice" }); }
      catch (error) { await channel.delete(`Rollback failed Workflow voice channel ${workflow.id}`).catch(() => undefined); throw error; }
      return { channelId: channel.id, name: channel.name, kind: "voice", created: true };
    }
    case "channel.create_text": {
      if (!member) throw new Error("channel.create_text requires an interaction member.");
      if (step.visibility === "guild_default" && !member.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels])) throw new Error("Public text channel creation requires Manage Server and Manage Channels.");
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot lacks Manage Channels for channel.create_text.");
      if (step.visibility === "staff_only") {
        const role = step.staffRoleId ? guild.roles.cache.get(step.staffRoleId) ?? await guild.roles.fetch(step.staffRoleId).catch(() => null) : null;
        if (!role || role.id === guild.id || role.managed) throw new Error("staff_only requires an existing non-managed Guild role.");
      }
      if (step.visibility !== "guild_default") {
        const [prior] = await db.select().from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.ownerJobId, workflow.id), eq(managedChannels.createdForMemberId, member.id), eq(managedChannels.kind, "ticket"))).limit(1);
        if (prior) {
          const existing = await guild.channels.fetch(prior.channelId).catch(() => null);
          if (existing?.type === ChannelType.GuildText) return { channelId: existing.id, name: existing.name, created: false, reused: true };
          await db.delete(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.channelId, prior.channelId), eq(managedChannels.ownerJobId, workflow.id)));
        }
        const [ticketCount] = await db.select({ count: sql<number>`count(*)::int` }).from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.ownerJobId, workflow.id), eq(managedChannels.kind, "ticket")));
        const ticketLimit = workflowTicketLimit();
        if ((ticketCount?.count ?? 0) >= ticketLimit) throw new Error(`Workflow ticket capacity reached (${ticketLimit}).`);
      } else {
        const cap = workflowResourceLimit();
        if (await workflowOwnedResourceCount(workflow) >= cap) throw new Error(`Workflow resource cap reached (${cap}).`);
      }
      const baseName = renderWorkflowTemplate(step.name, templateContext).toLocaleLowerCase().normalize("NFKC").replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
      const name = `${baseName || "ticket"}${step.visibility === "guild_default" ? "" : `-${member.id.slice(-5)}`}`.slice(0, 90);
      const topic = step.topic ? renderWorkflowTemplate(step.topic, templateContext) : undefined;
      const privateChannel = step.visibility !== "guild_default";
      const overwrites = privateChannel ? buildWorkflowPrivateOverwrites({ guildId: guild.id, botId: bot.id, preset: step.visibility === "staff_only" ? "staff_only" : "private_member", ...(step.visibility === "private_member" ? { memberId: member.id } : {}), ...(step.staffRoleId ? { staffRoleId: step.staffRoleId } : {}) }) : undefined;
      const channel = await guild.channels.create({ name, type: ChannelType.GuildText, topic, ...(overwrites ? { permissionOverwrites: overwrites } : {}), reason: `Interactive Workflow ${workflow.id}` });
      try {
        await db.insert(managedChannels).values({ guildId: workflow.guildId, channelId: channel.id, ownerJobId: workflow.id, kind: privateChannel ? "ticket" : "text", createdForMemberId: privateChannel ? member.id : null, staffRoleId: step.visibility === "staff_only" ? step.staffRoleId : null });
      } catch (error) { await channel.delete(`Rollback failed Workflow text channel ${workflow.id}`).catch(() => undefined); throw error; }
      return { channelId: channel.id, name: channel.name, kind: privateChannel ? "ticket" : "text", created: true };
    }
    case "channel.rename":
    case "channel.set_permission": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels])) throw new Error(`${step.action} requires Manage Server and Manage Channels.`);
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot lacks Manage Channels for this Workflow action.");
      const target = await workflowOwnedChannelForStep(workflow, guild, step.channelStepId, results);
      if (step.action === "channel.rename") {
        const name = renderWorkflowTemplate(step.name, templateContext).toLocaleLowerCase().normalize("NFKC").replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
        if (!name) throw new Error("Rendered channel name is empty or invalid.");
        const renamed = await target.channel.edit({ name, reason: `Interactive Workflow ${workflow.id}` });
        return { channelId: renamed.id, name: renamed.name, renamed: true };
      }
      if (target.channel.type !== ChannelType.GuildText) throw new Error("Permission presets are available only for Workflow-owned Text Channels.");
      const overwrites = buildWorkflowPrivateOverwrites({ guildId: guild.id, botId: bot.id, preset: step.preset, ...(step.preset === "private_member" && member ? { memberId: member.id } : {}), ...(step.staffRoleId ? { staffRoleId: step.staffRoleId } : {}) });
      if (step.preset === "staff_only") {
        const staffRole = step.staffRoleId ? guild.roles.cache.get(step.staffRoleId) ?? await guild.roles.fetch(step.staffRoleId).catch(() => null) : null;
        if (!staffRole || staffRole.id === guild.id || staffRole.managed) throw new Error("staff_only requires an existing, non-managed Guild role.");
      }
      await target.channel.permissionOverwrites.set(overwrites, `Applied ${step.preset} preset by Workflow ${workflow.id}`);
      return { channelId: target.channel.id, preset: step.preset, staffRoleId: step.preset === "staff_only" ? step.staffRoleId : null };
    }
    case "channel.delete": {
      const target = step.channelStepId
        ? await workflowOwnedChannelForStep(workflow, guild, step.channelStepId, results)
        : await workflowOwnedChannelById(workflow, guild, resolveTemplate(step.channelId, templateContext));
      if (!member) throw new Error("channel.delete requires a member context.");
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot lacks Manage Channels to delete this Workflow-owned channel.");
      const manager = member.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels]);
      if (!mayCloseWorkflowChannel({ createdForMemberId: target.binding.createdForMemberId, staffRoleId: target.binding.staffRoleId, memberId: member.id, memberRoleIds: member.roles.cache, isGuildManager: manager })) throw new Error("Only the ticket owner, its configured staff role, or a Guild manager may delete this Workflow-owned channel.");
      if (target.channel.type === ChannelType.GuildCategory) throw new Error("Category deletion is disabled; child-channel ownership must be reconciled first.");
      const [activeVoiceSession] = await db.select({ id: workflowVoiceChannels.id }).from(workflowVoiceChannels).where(and(eq(workflowVoiceChannels.workflowId, workflow.id), eq(workflowVoiceChannels.voiceChannelId, target.channel.id), eq(workflowVoiceChannels.state, "ACTIVE"))).limit(1);
      if (activeVoiceSession) throw new Error("Temporary Voice sessions must be closed through voice.channel.delete.");
      await target.channel.delete(`Deleted by Interactive Workflow ${workflow.id}`);
      await db.transaction(async (tx) => {
        await tx.delete(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.channelId, target.channel.id), eq(managedChannels.ownerJobId, workflow.id)));
        if (target.binding.createdForMemberId) await tx.delete(workflowStates).where(and(
          eq(workflowStates.workflowId, workflow.id), eq(workflowStates.scope, "member"), eq(workflowStates.scopeId, target.binding.createdForMemberId), eq(workflowStates.key, "ticket_channel_id"),
          sql`${workflowStates.value} = to_jsonb(${target.channel.id}::text)`,
        ));
      });
      return { channelId: target.channel.id, deleted: true };
    }
    case "channel.move_member": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.MoveMembers])) throw new Error("Moving a member requires Manage Server and Move Members.");
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.MoveMembers)) throw new Error("Bot lacks Move Members.");
      const target = await workflowOwnedChannelForStep(workflow, guild, step.channelStepId, results);
      if (target.channel.type !== ChannelType.GuildVoice) throw new Error("channel.move_member requires a Workflow-owned Voice Channel.");
      if (!target.channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers])) throw new Error("Bot lacks permission to move members into the target Voice Channel.");
      if (member.voice.channelId) {
        const source = await guild.channels.fetch(member.voice.channelId).catch(() => null);
        if (source && "permissionsFor" in source && !source.permissionsFor(bot)?.has(PermissionFlagsBits.MoveMembers)) throw new Error("Bot lacks Move Members in the source Voice Channel.");
      }
      await member.voice.setChannel(target.channel, `Moved by Interactive Workflow ${workflow.id}`);
      return { memberId: member.id, channelId: target.channel.id, moved: true };
    }
    case "channel.get_members": {
      const target = await workflowOwnedChannelForStep(workflow, guild, step.channelStepId, results);
      if (target.channel.type !== ChannelType.GuildVoice) throw new Error("channel.get_members is currently limited to Workflow-owned Voice Channels.");
      return { channelId: target.channel.id, memberIds: [...target.channel.members.values()].filter((voiceMember) => !voiceMember.user.bot).map((voiceMember) => voiceMember.id).slice(0, 100) };
    }
    case "role.rename": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles])) throw new Error("role.rename requires Manage Server and Manage Roles.");
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error("Bot lacks Manage Roles for role.rename.");
      const role = await findWorkflowOwnedRole(workflow, guild, step.roleName);
      if (!role) throw new Error(`Role ${step.roleName} is not owned by this Workflow.`);
      if (role.id === guild.id || role.managed || role.position >= bot.roles.highest.position || member.id !== guild.ownerId && role.position >= member.roles.highest.position) throw new Error("Role hierarchy prevents renaming this Workflow role.");
      if (guild.roles.cache.some((candidate) => candidate.id !== role.id && candidate.name.toLocaleLowerCase() === step.name.toLocaleLowerCase())) throw new Error(`A role with this name already exists: ${step.name}`);
      const renamed = await role.edit({ name: step.name, reason: `Interactive Workflow ${workflow.id}` });
      return { roleId: renamed.id, previousName: step.roleName, name: renamed.name };
    }
    case "role.member_count": {
      if (process.env.ENABLE_GUILD_MEMBERS_INTENT !== "true") throw new Error("role.member_count requires ENABLE_GUILD_MEMBERS_INTENT=true and the privileged Guild Members intent.");
      const { role } = await loadManagedRole(workflow.guildId, guild, step.roleName);
      await guild.members.fetch();
      return { roleId: role.id, roleName: role.name, memberCount: role.members.size };
    }
    case "resource.role.create": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles])) throw new Error("Role creation trigger requires Manage Server and Manage Roles.");
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error("Bot lacks Manage Roles for this Workflow action.");
      const existing = await findWorkflowOwnedRole(workflow, guild, step.name);
      if (existing) return { roleId: existing.id, name: existing.name, created: false };
      if (guild.roles.cache.some((role) => role.name === step.name)) throw new Error(`A role with this name already exists and is not owned by this Workflow: ${step.name}`);
      const resourceLimit = workflowResourceLimit();
      if (await workflowOwnedResourceCount(workflow) >= resourceLimit) throw new Error(`Workflow resource cap reached (${resourceLimit}).`);
      const role = await guild.roles.create({ name: step.name, permissions: [], reason: `Interactive Workflow ${workflow.id}` });
      try { await db.insert(managedRoles).values({ guildId: workflow.guildId, roleId: role.id, ownerJobId: workflow.id }); }
      catch (error) { await role.delete(`Rollback failed Workflow role ${workflow.id}`).catch(() => undefined); throw error; }
      return { roleId: role.id, name: role.name, created: true };
    }
    case "resource.channel.create_category":
    case "resource.channel.create_text": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels])) throw new Error("Channel creation trigger requires Manage Server and Manage Channels.");
      const bot = guild.members.me;
      if (!bot?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot lacks Manage Channels for this Workflow action.");
      const name = renderWorkflowTemplate(step.name, templateContext).toLocaleLowerCase().normalize("NFKC").replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
      if (!name) throw new Error("Rendered channel name is empty or invalid.");
      let parentId: string | null = null;
      if (step.action === "resource.channel.create_text" && step.categoryStepId) {
        const dependency = results[step.categoryStepId] as { channelId?: string } | undefined;
        if (!dependency?.channelId) throw new Error(`Category dependency result is missing: ${step.categoryStepId}`);
        const [binding] = await db.select({ channelId: managedChannels.channelId }).from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.channelId, dependency.channelId), eq(managedChannels.ownerJobId, workflow.id), eq(managedChannels.kind, "category"))).limit(1);
        if (!binding) throw new Error("Referenced Category is not owned by this Workflow.");
        parentId = binding.channelId;
      }
      const kind = step.action === "resource.channel.create_category" ? "category" : "text";
      const existing = await findWorkflowOwnedChannel(workflow, guild, name, kind, parentId);
      if (existing) return { channelId: existing.id, name: existing.name, created: false };
      const resourceLimit = workflowResourceLimit();
      if (await workflowOwnedResourceCount(workflow) >= resourceLimit) throw new Error(`Workflow resource cap reached (${resourceLimit}).`);
      const topic = step.action === "resource.channel.create_text" && step.topic ? renderWorkflowTemplate(step.topic, templateContext) : undefined;
      const created = step.action === "resource.channel.create_category"
        ? await guild.channels.create({ name, type: ChannelType.GuildCategory, reason: `Interactive Workflow ${workflow.id}` })
        : await guild.channels.create({ name, type: ChannelType.GuildText, topic, parent: parentId ?? undefined, reason: `Interactive Workflow ${workflow.id}` });
      try { await db.insert(managedChannels).values({ guildId: workflow.guildId, channelId: created.id, ownerJobId: workflow.id, kind }); }
      catch (error) { await created.delete(`Rollback failed Workflow channel ${workflow.id}`).catch(() => undefined); throw error; }
      return { channelId: created.id, name: created.name, kind, created: true };
    }
    case "giveaway.create": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles])) throw new Error("Giveaway creation requires Manage Server and Manage Roles.");
      const stateRows = await db.select({ value: workflowStates.value }).from(workflowStates).where(and(eq(workflowStates.workflowId, workflow.id), eq(workflowStates.scope, "workflow"), eq(workflowStates.scopeId, workflow.id), eq(workflowStates.key, "active_giveaway_id"))).limit(1);
      const activeId = typeof stateRows[0]?.value === "string" ? stateRows[0].value : null;
      if (activeId) {
        const [active] = await db.select({ id: giveaways.id, state: giveaways.state }).from(giveaways).where(and(eq(giveaways.id, activeId), eq(giveaways.guildId, workflow.guildId))).limit(1);
        if (active?.state === "ACTIVE" || active?.state === "PAUSED") return { giveawayId: active.id, created: false };
      }
      const id = randomUUID();
      const endsAt = new Date(Date.now() + step.durationSeconds * 1000);
      await db.transaction(async (tx) => {
        await tx.insert(giveaways).values({ id, guildId: workflow.guildId, channelId: workflow.channelId, messageId: workflow.messageId, hostId: member.id, prize: step.prize, winnerCount: step.winnerCount, state: "ACTIVE", endsAt });
        await tx.insert(workflowStates).values({ workflowId: workflow.id, scope: "workflow", scopeId: workflow.id, key: "active_giveaway_id", value: id, updatedAt: new Date() }).onConflictDoUpdate({ target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value: id, updatedAt: new Date() } });
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member.id, action: "workflow.giveaway.create", outcome: "success", detail: { giveawayId: id, prize: step.prize, winnerCount: step.winnerCount, endsAt } });
      });
      return { giveawayId: id, created: true };
    }
    case "giveaway.join":
    case "giveaway.leave": {
      if (!member) throw new Error("Giveaway entry actions require an interaction member.");
      const resolvedId = resolveTemplate(step.giveawayId, templateContext);
      if (typeof resolvedId !== "string" || !resolvedId) throw new Error("Workflow Giveaway reference did not resolve to an ID.");
      const giveaway = await loadWorkflowGiveaway(workflow, resolvedId);
      if (giveaway.state !== "ACTIVE" || giveaway.endsAt.getTime() <= Date.now()) throw new Error("Workflow-owned Giveaway is not accepting entries.");
      if (step.action === "giveaway.join") {
        const inserted = await db.insert(giveawayEntries).values({ giveawayId: giveaway.id, userId: member.id }).onConflictDoNothing().returning({ userId: giveawayEntries.userId });
        return { giveawayId: giveaway.id, joined: inserted.length > 0 };
      }
      const removed = await db.delete(giveawayEntries).where(and(eq(giveawayEntries.giveawayId, giveaway.id), eq(giveawayEntries.userId, member.id))).returning({ userId: giveawayEntries.userId });
      return { giveawayId: giveaway.id, left: removed.length > 0 };
    }
    case "giveaway.end":
    case "giveaway.pause":
    case "giveaway.resume":
    case "giveaway.reroll": {
      if (!member?.permissions.has([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles])) throw new Error(`${step.action} requires Manage Server and Manage Roles.`);
      const resolvedId = resolveTemplate(step.giveawayId, templateContext);
      if (typeof resolvedId !== "string" || !resolvedId) throw new Error("Workflow Giveaway reference did not resolve to an ID.");
      const giveaway = await loadWorkflowGiveaway(workflow, resolvedId);
      if (step.action === "giveaway.end") {
        const [updated] = await db.update(giveaways).set({ endsAt: new Date() }).where(and(eq(giveaways.id, giveaway.id), eq(giveaways.guildId, workflow.guildId), eq(giveaways.state, "ACTIVE"))).returning({ id: giveaways.id });
        return { giveawayId: giveaway.id, ending: Boolean(updated) };
      }
      if (step.action === "giveaway.pause") {
        const [updated] = await db.update(giveaways).set({ state: "PAUSED", remainingSeconds: sql`GREATEST(0, floor(extract(epoch from ${giveaways.endsAt} - now())))::int` }).where(and(eq(giveaways.id, giveaway.id), eq(giveaways.guildId, workflow.guildId), eq(giveaways.state, "ACTIVE"))).returning({ id: giveaways.id });
        return { giveawayId: giveaway.id, paused: Boolean(updated) };
      }
      if (step.action === "giveaway.resume") {
        const remainingSeconds = Math.max(1, giveaway.remainingSeconds ?? 1);
        const [updated] = await db.update(giveaways).set({ state: "ACTIVE", endsAt: new Date(Date.now() + remainingSeconds * 1000), remainingSeconds: null }).where(and(eq(giveaways.id, giveaway.id), eq(giveaways.guildId, workflow.guildId), eq(giveaways.state, "PAUSED"))).returning({ id: giveaways.id });
        return { giveawayId: giveaway.id, resumed: Boolean(updated) };
      }
      if (giveaway.state !== "COMPLETED") throw new Error("Giveaway reroll is only available after drawing completes.");
      const entries = await db.select({ userId: giveawayEntries.userId }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, giveaway.id));
      const previousWinners = new Set((giveaway.winners as string[] | null) ?? []);
      const winners = drawWinners(entries.map((entry) => entry.userId).filter((userId) => !previousWinners.has(userId)), giveaway.winnerCount);
      await db.transaction(async (tx) => {
        const [updated] = await tx.update(giveaways).set({ winners }).where(and(eq(giveaways.id, giveaway.id), eq(giveaways.state, "COMPLETED"))).returning({ id: giveaways.id });
        if (!updated) throw new Error("Giveaway state changed during reroll.");
        await tx.insert(giveawayNotifications).values({ id: randomUUID(), giveawayId: giveaway.id, guildId: giveaway.guildId, channelId: giveaway.channelId, content: giveawayResultMessage(giveaway.prize, winners, true), allowedUsers: winners });
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member.id, action: "workflow.giveaway.reroll", outcome: "success", detail: { giveawayId: giveaway.id, previousWinners: [...previousWinners], winners } });
      });
      return { giveawayId: giveaway.id, winners };
    }
    default: {
      const unreachable: never = step;
      throw new Error(`Unsupported Workflow action: ${JSON.stringify(unreachable)}`);
    }
  }
}

type WorkflowResumeContext = { runId: string; cursor: number; stepResults: Record<string, unknown>; outcomes: unknown[] };

function retryableWithoutExternalReplay(step: InteractiveWorkflowStep | undefined): boolean {
  return Boolean(step && ["state.set", "state.get", "state.delete", "state.reset", "collection.add", "collection.remove", "collection.count", "collection.contains", "collection.list", "collection.rank", "collection.clear", "math.add", "math.subtract", "math.multiply", "math.divide", "math.min", "math.max", "math.clamp", "random.integer", "random.choice", "random.weighted_choice", "panel.refresh", "workflow.wait"].includes(step.action));
}

async function runWorkflowTrigger(guild: Guild, interactionId: string, workflow: WorkflowRecord, triggerId: string, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[], voice?: WorkflowVoiceContext, resume?: WorkflowResumeContext): Promise<string> {
  const spec = interactiveWorkflowSchema.parse(workflow.spec);
  const trigger = spec.triggers.find((item) => item.id === triggerId);
  if (!trigger) throw new Error("Workflow trigger no longer exists.");
  const runId = resume?.runId ?? randomUUID();
  const run = await withGuildAdvisoryLock("workflow-global-cap", async () => {
    const configuredConcurrency = Number(process.env.MAX_CONCURRENT_WORKFLOW_RUNS ?? 20);
    const maxConcurrent = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.min(100, configuredConcurrency)) : 20;
    const [running] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowRuns).where(eq(workflowRuns.state, "RUNNING"));
    if ((running?.count ?? 0) >= maxConcurrent) throw new Error("Interactive Workflow concurrency limit reached.");
    if (resume) {
      const [resumed] = await db.update(workflowRuns).set({ state: "RUNNING", updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workflowId, workflow.id), eq(workflowRuns.state, "WAITING"))).returning({ id: workflowRuns.id });
      return resumed;
    }
    if (member) {
      const configuredCooldown = Number(process.env.WORKFLOW_TRIGGER_COOLDOWN_MS ?? 1000);
      const cooldownMs = Number.isFinite(configuredCooldown) ? Math.max(0, Math.min(60_000, configuredCooldown)) : 1000;
      if (cooldownMs > 0) {
        const [recent] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowRuns).where(and(
          eq(workflowRuns.workflowId, workflow.id), eq(workflowRuns.triggerId, triggerId), eq(workflowRuns.actorId, member.id), gt(workflowRuns.createdAt, new Date(Date.now() - cooldownMs)),
        ));
        if ((recent?.count ?? 0) > 0) throw new Error("Workflow trigger rate limit reached; try again shortly.");
      }
    }
    const [inserted] = await db.insert(workflowRuns).values({ id: runId, workflowId: workflow.id, guildId: workflow.guildId, interactionId, triggerId, actorId: member?.id ?? "system", state: "RUNNING", cursor: 0 })
      .onConflictDoNothing().returning({ id: workflowRuns.id });
    return inserted;
  });
  if (!run && resume) throw Object.assign(new Error("Workflow run is no longer waiting and cannot be resumed automatically."), { recoveryRequired: true });
  if (!run) {
    const [prior] = await db.select({ state: workflowRuns.state }).from(workflowRuns).where(and(eq(workflowRuns.guildId, workflow.guildId), eq(workflowRuns.interactionId, interactionId))).limit(1);
    if (prior?.state === "COMPLETED") return "この操作はすでに完了しています。";
    throw Object.assign(new Error("この操作は以前に開始されています。再実行せず、Workflow実行履歴を確認してください。"), { recoveryRequired: true });
  }
  const heartbeat = setInterval(() => {
    void db.update(workflowRuns).set({ updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, "RUNNING"))).catch(() => undefined);
  }, 60_000).unref();
  let uncertainSend = false;
  try {
    const executionStartedAt = Date.now();
    const outcomes: unknown[] = resume ? [...resume.outcomes] : [];
    const stepResults: Record<string, unknown> = resume ? { ...resume.stepResults } : {};
    const skippedStepIds: string[] = outcomes.filter((outcome): outcome is { stepId: string; state: string } => Boolean(outcome && typeof outcome === "object" && "state" in outcome && "stepId" in outcome && (outcome as { state: string }).state === "SKIPPED")).map((outcome) => outcome.stepId);
    const completedMessageStepIds = new Set(outcomes.filter((outcome): outcome is { stepId: string } => Boolean(outcome && typeof outcome === "object" && "stepId" in outcome)).map((outcome) => outcome.stepId));
    let sentMessages = trigger.steps.filter((step) => completedMessageStepIds.has(step.id) && (step.action === "message.send" || step.action === "message.reply" || step.action === "message.dm")).length;
    const requiredTriggerPermissions = new Set<bigint>();
    for (const step of trigger.steps) {
      if (step.action === "resource.role.create") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageRoles);
      }
      if (step.action === "role.rename") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageRoles);
      }
      if (step.action === "resource.channel.create_category" || step.action === "resource.channel.create_text" || step.action === "channel.create_text" && step.visibility === "guild_default") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageChannels);
      }
      if (["channel.create_voice", "channel.rename", "channel.set_permission"].includes(step.action)) {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageChannels);
      }
      if (step.action === "channel.move_member") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.MoveMembers);
      }
      if (step.action === "giveaway.create" || step.action === "giveaway.end" || step.action === "giveaway.pause" || step.action === "giveaway.resume" || step.action === "giveaway.reroll") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageRoles);
      }
    }
    if (requiredTriggerPermissions.size && (!member || !member.permissions.has([...requiredTriggerPermissions]))) throw new Error("This Workflow trigger contains admin resource actions; all required permissions are checked before any step runs.");
    for (const [cursor, step] of orderInteractiveWorkflowSteps(trigger.steps).entries()) {
      if (resume && cursor < resume.cursor) continue;
      if (Date.now() - executionStartedAt > workflowRunLimitMs()) throw new Error("Workflow execution time budget exceeded at a step boundary.");
      const [currentWorkflow] = await db.select({ state: interactiveWorkflows.state }).from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, workflow.id), eq(interactiveWorkflows.guildId, workflow.guildId))).limit(1);
      if (!currentWorkflow || currentWorkflow.state === "DISABLED" || currentWorkflow.state === "DELETED") throw Object.assign(new Error("Workflow was disabled while this run was executing."), { recoveryRequired: true });
      if (!(await evaluateStepCondition(step, workflow.id, guild, member, inputs, selected, stepResults, voice))) {
        outcomes.push({ stepId: step.id, state: "SKIPPED" });
        stepResults[step.id] = { state: "SKIPPED" };
        skippedStepIds.push(step.id);
        await db.update(workflowRuns).set({ cursor: cursor + 1, result: outcomes, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
        continue;
      }
      const sendsMessage = step.action === "message.send" || step.action === "message.reply" || step.action === "message.dm";
      if (sendsMessage && ++sentMessages > 5) throw new Error("Workflow message send budget exceeded (5 per run).");
      if (sendsMessage) uncertainSend = true;
      const result = await executeWorkflowStep(workflow, runId, step, guild, member, inputs, selected, stepResults, voice);
      stepResults[step.id] = result;
      outcomes.push({ stepId: step.id, state: "COMPLETED", result });
      if (step.action === "workflow.wait") {
        const seconds = (result as { deferSeconds: number }).deferSeconds;
        const context = { inputs, selected, stepResults, outcomes, workflowSpec: workflow.spec, workflowVersion: workflow.version, ...(voice ? { voiceSourceChannelId: voice.sourceChannelId } : {}) };
        if (Buffer.byteLength(JSON.stringify(context), "utf8") > 64 * 1024) throw new Error("Workflow wait checkpoint exceeds the 64 KiB context limit.");
        const dueAt = new Date(Date.now() + seconds * 1000);
        await db.transaction(async (tx) => {
          await tx.insert(workflowWaits).values({ id: randomUUID(), workflowId: workflow.id, guildId: workflow.guildId, runId, triggerId, stepId: step.id, memberId: member?.id ?? null, dueAt, state: "ACTIVE", context });
          const [waiting] = await tx.update(workflowRuns).set({ state: "WAITING", cursor: cursor + 1, result: outcomes, updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, "RUNNING"))).returning({ id: workflowRuns.id });
          if (!waiting) throw new Error("Workflow run changed before its durable wait was saved.");
          await tx.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member?.id ?? "system", action: "workflow.wait_scheduled", outcome: "success", detail: { runId, triggerId, stepId: step.id, dueAt } });
        });
        return `Workflow「${workflow.name}」を一時停止し、${seconds}秒後に再開する予定を保存しました。`;
      }
      await db.update(workflowRuns).set({ cursor: cursor + 1, result: outcomes, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
      if (sendsMessage) uncertainSend = false;
    }
    await db.update(workflowRuns).set({ state: "COMPLETED", result: outcomes, updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, "RUNNING")));
    await db.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member?.id ?? "system", action: "workflow.trigger", outcome: skippedStepIds.length ? "partial" : "success", detail: { runId, triggerId, event: trigger.event, componentKey: "componentKey" in trigger ? trigger.componentKey : null, skippedStepIds } });
    return skippedStepIds.length
      ? `Workflow「${workflow.name}」を処理しました。一部の条件付きSkillは実行されませんでした: ${skippedStepIds.join(", ")}`
      : `Workflow「${workflow.name}」を実行しました。`;
  } catch (error) {
    const cursor = (await db.select({ cursor: workflowRuns.cursor }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1))[0]?.cursor ?? 0;
    const orderedSteps = orderInteractiveWorkflowSteps(trigger.steps);
    const currentStep = orderedSteps[cursor];
    const withinSafeRetryBoundary = resume ? cursor === resume.cursor && retryableWithoutExternalReplay(currentStep) : cursor === 0 && retryableWithoutExternalReplay(currentStep);
    const recoveryRequired = uncertainSend || !withinSafeRetryBoundary || Boolean((error as { recoveryRequired?: boolean }).recoveryRequired);
    await db.update(workflowRuns).set({ state: recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED", errorDetail: { message: error instanceof Error ? error.message : "unknown" }, updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, "RUNNING")));
    await db.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member?.id ?? "system", action: "workflow.trigger", outcome: recoveryRequired ? "recovery_required" : "failed", detail: { runId, triggerId, cursor, message: error instanceof Error ? error.message : "unknown" } });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function recoverStaleInteractiveRuns(): Promise<number> {
  const stale = await db.update(workflowRuns).set({ state: "RECOVERY_REQUIRED", errorDetail: { reason: "workflow interaction interrupted; no automatic replay" }, updatedAt: new Date() })
    .where(and(eq(workflowRuns.state, "RUNNING"), sql`${workflowRuns.updatedAt} < now() - interval '10 minutes'`)).returning({ id: workflowRuns.id });
  return stale.length;
}

export async function dispatchWorkflowSchedules(client: Client): Promise<number> {
  const now = new Date();
  const due = await db.select().from(workflowSchedules).where(or(
    and(eq(workflowSchedules.state, "ACTIVE"), lte(workflowSchedules.nextAt, now)),
    and(eq(workflowSchedules.state, "CLAIMED"), sql`${workflowSchedules.leaseExpiresAt} < ${now}`),
  )).orderBy(workflowSchedules.nextAt).limit(20);
  let processed = 0;

  for (const schedule of due) {
    const leaseOwner = randomUUID();
    const [claimed] = await db.update(workflowSchedules).set({ state: "CLAIMED", leaseOwner, leaseExpiresAt: new Date(Date.now() + 120_000), attempts: sql`${workflowSchedules.attempts} + 1` })
      .where(and(eq(workflowSchedules.id, schedule.id), or(
        and(eq(workflowSchedules.state, "ACTIVE"), lte(workflowSchedules.nextAt, new Date())),
        and(eq(workflowSchedules.state, "CLAIMED"), sql`${workflowSchedules.leaseExpiresAt} < now()`),
      ))).returning();
    if (!claimed) continue;
    const occurrenceId = `schedule:${claimed.id}:${claimed.nextAt.toISOString()}`;

    try {
      const [prior] = await db.select({ state: workflowRuns.state }).from(workflowRuns).where(and(eq(workflowRuns.guildId, claimed.guildId), eq(workflowRuns.interactionId, occurrenceId))).limit(1);
      if (prior && prior.state !== "COMPLETED") throw Object.assign(new Error("Previous timer run requires operator recovery."), { recoveryRequired: true });
      const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, claimed.workflowId), eq(interactiveWorkflows.guildId, claimed.guildId), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
      if (!workflow) throw Object.assign(new Error("Scheduled Workflow is no longer active."), { recoveryRequired: true });
      const spec = interactiveWorkflowSchema.parse(workflow.spec);
      const trigger = spec.triggers.find((candidate) => candidate.id === claimed.triggerId);
      if (!trigger || trigger.event !== "schedule" && trigger.event !== "schedule.at" && trigger.event !== "deadline") throw Object.assign(new Error("Scheduled trigger definition is missing or changed."), { recoveryRequired: true });
      if (!prior) {
        const guild = client.guilds.cache.get(claimed.guildId) ?? await client.guilds.fetch(claimed.guildId);
        await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(guild, occurrenceId, workflow, trigger.id, undefined, {}, []));
      }
      const isDeadline = claimed.event === "deadline";
      const nextAt = isDeadline ? claimed.nextAt : claimed.event === "schedule.at" && trigger.event === "schedule.at"
        ? nextWeeklyOccurrence(new Date(), trigger.dayOfWeek, trigger.hour, trigger.minute, trigger.timeZone)
        : new Date(Date.now() + (claimed.intervalSeconds ?? 60) * 1000);
      await db.update(workflowSchedules).set({ state: isDeadline ? "COMPLETED" : "ACTIVE", nextAt, leaseOwner: null, leaseExpiresAt: null, attempts: 0, lastError: null })
        .where(and(eq(workflowSchedules.id, claimed.id), eq(workflowSchedules.state, "CLAIMED"), eq(workflowSchedules.leaseOwner, leaseOwner)));
      processed++;
    } catch (error) {
      const [run] = await db.select({ state: workflowRuns.state }).from(workflowRuns).where(and(eq(workflowRuns.guildId, claimed.guildId), eq(workflowRuns.interactionId, occurrenceId))).limit(1);
      const recoveryRequired = Boolean((error as { recoveryRequired?: boolean }).recoveryRequired) || run?.state === "RUNNING" || run?.state === "RECOVERY_REQUIRED";
      await db.update(workflowSchedules).set({ state: recoveryRequired ? "RECOVERY_REQUIRED" : "ACTIVE", nextAt: new Date(Date.now() + 30_000), leaseOwner: null, leaseExpiresAt: null, lastError: error instanceof Error ? error.message.slice(0, 500) : "unknown schedule failure" })
        .where(and(eq(workflowSchedules.id, claimed.id), eq(workflowSchedules.state, "CLAIMED"), eq(workflowSchedules.leaseOwner, leaseOwner)));
      console.error(JSON.stringify({ level: "error", event: "workflow.schedule_run_failed", scheduleId: claimed.id, workflowId: claimed.workflowId, recoveryRequired, error: error instanceof Error ? error.message : "unknown" }));
    }
  }
  return processed;
}

export async function dispatchWorkflowWaits(client: Client): Promise<number> {
  const now = new Date();
  const due = await db.select().from(workflowWaits).where(or(
    and(eq(workflowWaits.state, "ACTIVE"), lte(workflowWaits.dueAt, now)),
    and(eq(workflowWaits.state, "CLAIMED"), sql`${workflowWaits.leaseExpiresAt} < ${now}`),
  )).orderBy(workflowWaits.dueAt).limit(20);
  let processed = 0;
  for (const wait of due) {
    const leaseOwner = randomUUID();
    const [claimed] = await db.update(workflowWaits).set({ state: "CLAIMED", leaseOwner, leaseExpiresAt: new Date(Date.now() + 120_000), attempts: sql`${workflowWaits.attempts} + 1` })
      .where(and(eq(workflowWaits.id, wait.id), or(
        and(eq(workflowWaits.state, "ACTIVE"), lte(workflowWaits.dueAt, new Date())),
        and(eq(workflowWaits.state, "CLAIMED"), sql`${workflowWaits.leaseExpiresAt} < now()`),
      ))).returning();
    if (!claimed) continue;
    const waitHeartbeat = setInterval(() => {
      void db.update(workflowWaits).set({ leaseExpiresAt: new Date(Date.now() + 120_000) }).where(and(eq(workflowWaits.id, claimed.id), eq(workflowWaits.state, "CLAIMED"), eq(workflowWaits.leaseOwner, leaseOwner))).catch(() => undefined);
    }, 30_000).unref();
    let resumeCursor: number | undefined;
    try {
      const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, claimed.workflowId), eq(interactiveWorkflows.guildId, claimed.guildId), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
      if (!workflow) throw Object.assign(new Error("Workflow is not active when its durable wait becomes due."), { recoveryRequired: true });
      const context = claimed.context as { inputs?: unknown; selected?: unknown; stepResults?: unknown; outcomes?: unknown; workflowSpec?: unknown; workflowVersion?: unknown; voiceSourceChannelId?: unknown };
      const savedSpec = interactiveWorkflowSchema.safeParse(context.workflowSpec);
      if (!savedSpec.success) throw Object.assign(new Error("Persisted Workflow wait definition is invalid."), { recoveryRequired: true });
      const resumedWorkflow: WorkflowRecord = { ...workflow, spec: savedSpec.data, version: typeof context.workflowVersion === "number" ? context.workflowVersion : workflow.version };
      const spec = savedSpec.data;
      const trigger = spec.triggers.find((candidate) => candidate.id === claimed.triggerId);
      if (!trigger) throw Object.assign(new Error("Wait trigger no longer exists."), { recoveryRequired: true });
      if (!context.inputs || typeof context.inputs !== "object" || !Array.isArray(context.selected) || !context.stepResults || typeof context.stepResults !== "object" || !Array.isArray(context.outcomes)) throw Object.assign(new Error("Persisted Workflow wait context is invalid."), { recoveryRequired: true });
      const guild = client.guilds.cache.get(claimed.guildId) ?? await client.guilds.fetch(claimed.guildId);
      const member = claimed.memberId ? await guild.members.fetch(claimed.memberId).catch(() => null) : null;
      if (claimed.memberId && !member) throw Object.assign(new Error("The Workflow wait actor is no longer available in this Guild."), { recoveryRequired: true });
      let voice: WorkflowVoiceContext | undefined;
      if (typeof context.voiceSourceChannelId === "string") {
        const sourceChannelId = context.voiceSourceChannelId;
        const session = await findActiveVoiceSession(workflow.id, guild.id, sourceChannelId);
        const countChannelId = trigger.event === "voice.member_leave_event" ? session?.voiceChannelId : sourceChannelId;
        const channel = countChannelId ? await guild.channels.fetch(countChannelId).catch(() => null) : null;
        voice = { sourceChannelId, memberCount: humanVoiceMemberCount(channel?.type === ChannelType.GuildVoice ? channel : null), session };
      }
      const [waitingRun] = await db.select({ cursor: workflowRuns.cursor }).from(workflowRuns).where(and(eq(workflowRuns.id, claimed.runId), eq(workflowRuns.state, "WAITING"))).limit(1);
      if (!waitingRun) throw Object.assign(new Error("Workflow run is no longer in WAITING state."), { recoveryRequired: true });
      resumeCursor = waitingRun.cursor;
      await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(
        guild, `resume:${claimed.runId}:${claimed.stepId}`, resumedWorkflow, claimed.triggerId, member ?? undefined,
        context.inputs as Record<string, string>, context.selected as string[], voice,
        { runId: claimed.runId, cursor: waitingRun.cursor, stepResults: context.stepResults as Record<string, unknown>, outcomes: context.outcomes as unknown[] },
      ));
      await db.update(workflowWaits).set({ state: "COMPLETED", leaseOwner: null, leaseExpiresAt: null, lastError: null }).where(and(eq(workflowWaits.id, claimed.id), eq(workflowWaits.state, "CLAIMED"), eq(workflowWaits.leaseOwner, leaseOwner)));
      processed++;
    } catch (error) {
      const [run] = await db.select({ state: workflowRuns.state, cursor: workflowRuns.cursor }).from(workflowRuns).where(eq(workflowRuns.id, claimed.runId)).limit(1);
      const canRetry = !((error as { recoveryRequired?: boolean }).recoveryRequired)
        && claimed.attempts < 3 && run && resumeCursor !== undefined && run.cursor === resumeCursor && (run.state === "WAITING" || run.state === "FAILED");
      let recoveryRequired = false;
      if (canRetry) {
        const retryAt = new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** (claimed.attempts - 1)));
        await db.transaction(async (tx) => {
          if (run.state === "FAILED") await tx.update(workflowRuns).set({ state: "WAITING", errorDetail: null, updatedAt: new Date() }).where(and(eq(workflowRuns.id, claimed.runId), eq(workflowRuns.state, "FAILED"), eq(workflowRuns.cursor, resumeCursor!)));
          await tx.update(workflowWaits).set({ state: "ACTIVE", dueAt: retryAt, leaseOwner: null, leaseExpiresAt: null, lastError: error instanceof Error ? error.message.slice(0, 500) : "unknown wait failure" })
            .where(and(eq(workflowWaits.id, claimed.id), eq(workflowWaits.state, "CLAIMED"), eq(workflowWaits.leaseOwner, leaseOwner)));
        });
      } else {
        recoveryRequired = Boolean((error as { recoveryRequired?: boolean }).recoveryRequired) || run?.state === "RUNNING" || run?.state === "RECOVERY_REQUIRED";
        await db.update(workflowWaits).set({ state: recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED", leaseOwner: null, leaseExpiresAt: null, lastError: error instanceof Error ? error.message.slice(0, 500) : "unknown wait failure" })
          .where(and(eq(workflowWaits.id, claimed.id), eq(workflowWaits.state, "CLAIMED"), eq(workflowWaits.leaseOwner, leaseOwner)));
      }
      console.error(JSON.stringify({ level: "error", event: "workflow.wait_resume_failed", waitId: claimed.id, workflowId: claimed.workflowId, recoveryRequired, error: error instanceof Error ? error.message : "unknown" }));
    } finally {
      clearInterval(waitHeartbeat);
    }
  }
  return processed;
}

function humanVoiceMemberCount(voiceChannel: import("discord.js").VoiceChannel | null): number {
  return voiceChannel?.members.filter((member) => !member.user.bot).size ?? 0;
}

export async function handleWorkflowVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  if (oldState.channelId === newState.channelId) return;
  const guild = newState.guild;
  const eventWindow = Math.floor(Date.now() / 1000);
  if (newState.channel?.type === ChannelType.GuildVoice && newState.member && !newState.member.user.bot) {
    const workflows = await activeGuildWorkflows(guild.id);
    for (const workflow of workflows) {
      const spec = interactiveWorkflowSchema.parse(workflow.spec);
      const sourceChannelId = newState.channel.id;
      const trigger = spec.triggers.find((item) => item.event === "voice.member_join_event" && item.voiceChannelId === sourceChannelId);
      if (!trigger) continue;
      const session = await findActiveVoiceSession(workflow.id, guild.id, sourceChannelId);
      const voice = { sourceChannelId, memberCount: humanVoiceMemberCount(newState.channel), session };
      const runId = `voice-join:${workflow.id}:${newState.member.id}:${sourceChannelId}:${eventWindow}`;
      try {
        await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(guild, runId, workflow, trigger.id, newState.member!, {}, [], voice));
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "workflow.voice_join_failed", workflowId: workflow.id, triggerId: trigger.id, error: error instanceof Error ? error.message : "unknown" }));
      }
    }
  }

  if (oldState.channel?.type !== ChannelType.GuildVoice || !oldState.member || oldState.member.user.bot) return;
  const sessions = await db.select().from(workflowVoiceChannels).where(and(eq(workflowVoiceChannels.guildId, guild.id), eq(workflowVoiceChannels.voiceChannelId, oldState.channelId!), eq(workflowVoiceChannels.state, "ACTIVE")));
  for (const session of sessions) {
    const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, session.workflowId), eq(interactiveWorkflows.guildId, guild.id), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
    if (!workflow) continue;
    const spec = interactiveWorkflowSchema.parse(workflow.spec);
    const trigger = spec.triggers.find((item) => item.event === "voice.member_leave_event");
    if (!trigger) continue;
    const channel = oldState.channel ?? await guild.channels.fetch(session.voiceChannelId).catch(() => null);
    const voice = { sourceChannelId: session.sourceChannelId, memberCount: humanVoiceMemberCount(channel?.type === ChannelType.GuildVoice ? channel : null), session };
    const runId = `voice-leave:${session.id}:${oldState.member.id}:${eventWindow}`;
    try {
      await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(guild, runId, workflow, trigger.id, oldState.member!, {}, [], voice));
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "workflow.voice_leave_failed", workflowId: workflow.id, triggerId: trigger.id, sessionId: session.id, error: error instanceof Error ? error.message : "unknown" }));
    }
  }
}

async function dispatchGatewayWorkflowTrigger(guild: Guild, workflow: WorkflowRecord, trigger: InteractiveWorkflow["triggers"][number], member: GuildMember | undefined, inputs: Record<string, string>, eventKey: string): Promise<void> {
  try {
    await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(guild, eventKey, workflow, trigger.id, member, inputs, []));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "workflow.gateway_trigger_failed", guildId: guild.id, workflowId: workflow.id, triggerId: trigger.id, error: error instanceof Error ? error.message : "unknown" }));
  }
}

export async function handleWorkflowMemberJoin(member: GuildMember): Promise<void> {
  if (member.user.bot || process.env.ENABLE_GUILD_MEMBERS_INTENT !== "true") return;
  const workflows = await activeGuildWorkflows(member.guild.id);
  for (const workflow of workflows) {
    const spec = interactiveWorkflowSchema.parse(workflow.spec);
    for (const trigger of spec.triggers) if (trigger.event === "member.join") {
      await dispatchGatewayWorkflowTrigger(member.guild, workflow, trigger, member, { joinedAt: member.joinedAt?.toISOString() ?? "" }, `member.join:${member.guild.id}:${member.id}:${Math.floor((member.joinedTimestamp ?? Date.now()) / 1000)}:${trigger.id}`);
    }
  }
}

export async function handleWorkflowMemberLeave(member: GuildMember): Promise<void> {
  if (member.user.bot || process.env.ENABLE_GUILD_MEMBERS_INTENT !== "true") return;
  const workflows = await activeGuildWorkflows(member.guild.id);
  for (const workflow of workflows) {
    const spec = interactiveWorkflowSchema.parse(workflow.spec);
    for (const trigger of spec.triggers) if (trigger.event === "member.leave") {
      await dispatchGatewayWorkflowTrigger(member.guild, workflow, trigger, member, {}, `member.leave:${member.guild.id}:${member.id}:${Math.floor(Date.now() / 5000)}:${trigger.id}`);
    }
  }
}

export async function handleWorkflowMemberRoleUpdate(oldMember: GuildMember, newMember: GuildMember): Promise<void> {
  if (newMember.user.bot || process.env.ENABLE_GUILD_MEMBERS_INTENT !== "true") return;
  const added = [...newMember.roles.cache.keys()].filter((roleId) => !oldMember.roles.cache.has(roleId) && !consumeSuppressedRoleEvent(newMember.guild.id, newMember.id, roleId, "added"));
  const removed = [...oldMember.roles.cache.keys()].filter((roleId) => !newMember.roles.cache.has(roleId) && !consumeSuppressedRoleEvent(newMember.guild.id, newMember.id, roleId, "removed"));
  if (!added.length && !removed.length) return;
  const workflows = await activeGuildWorkflows(newMember.guild.id);
  for (const workflow of workflows) {
    const spec = interactiveWorkflowSchema.parse(workflow.spec);
    for (const trigger of spec.triggers) {
      if (trigger.event === "member.role_added" && added.includes(trigger.roleId)) await dispatchGatewayWorkflowTrigger(newMember.guild, workflow, trigger, newMember, { roleId: trigger.roleId }, `member.role_added:${newMember.guild.id}:${newMember.id}:${trigger.roleId}:${Math.floor(Date.now() / 1000)}:${trigger.id}`);
      if (trigger.event === "member.role_removed" && removed.includes(trigger.roleId)) await dispatchGatewayWorkflowTrigger(newMember.guild, workflow, trigger, newMember, { roleId: trigger.roleId }, `member.role_removed:${newMember.guild.id}:${newMember.id}:${trigger.roleId}:${Math.floor(Date.now() / 1000)}:${trigger.id}`);
    }
  }
}

function eventInputs(message: Message, includeContent: boolean): Record<string, string> {
  return {
    __source_channel_id: message.channelId,
    __source_message_id: message.id,
    authorId: message.author?.id ?? "",
    ...(includeContent ? { content: message.content.slice(0, 1900) } : {}),
  };
}

async function dispatchMessageTriggers(message: Message, event: "message.created" | "message.deleted"): Promise<void> {
  if (message.partial || !message.guild || !message.author || message.author.bot) return;
  const workflows = await activeGuildWorkflows(message.guild.id);
  const member = message.member ?? message.guild.members.cache.get(message.author.id);
  const inputs = eventInputs(message, event === "message.created" && process.env.ENABLE_MESSAGE_CONTENT_INTENT === "true");
  for (const workflow of workflows) {
    const spec = interactiveWorkflowSchema.parse(workflow.spec);
    for (const trigger of spec.triggers) if (trigger.event === event && (trigger.channelId === message.channelId || trigger.channelId === "workflow_channel" && workflow.channelId === message.channelId)) {
      await dispatchGatewayWorkflowTrigger(message.guild, workflow, trigger, member, inputs, `${event}:${message.id}:${trigger.id}`);
    }
  }
}

export async function handleWorkflowMessageCreate(message: Message): Promise<void> {
  await dispatchMessageTriggers(message, "message.created");
}

export async function handleWorkflowMessageDelete(message: Message): Promise<void> {
  await dispatchMessageTriggers(message, "message.deleted");
}

async function dispatchReactionTriggers(reaction: MessageReaction, user: User, event: "reaction.added" | "reaction.removed"): Promise<void> {
  if (user.partial || user.bot) return;
  const message = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
  const guild = message?.guild;
  if (!message || !guild) return;
  const workflows = await activeGuildWorkflows(guild.id);
  const member = guild.members.cache.get(user.id);
  const emoji = reaction.emoji.id ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name ?? "";
  const inputs = { __source_channel_id: message.channelId, __source_message_id: message.id, authorId: user.id, emoji, ...(process.env.ENABLE_MESSAGE_CONTENT_INTENT === "true" ? { content: message.content.slice(0, 1900) } : {}) };
  for (const workflow of workflows) {
    const spec = interactiveWorkflowSchema.parse(workflow.spec);
    for (const trigger of spec.triggers) {
      if ((trigger.event !== "reaction.added" && trigger.event !== "reaction.removed") || !(trigger.channelId === message.channelId || trigger.channelId === "workflow_channel" && workflow.channelId === message.channelId) || trigger.emoji && trigger.emoji !== emoji) continue;
      const [tracked] = await db.select({ id: workflowMessages.id }).from(workflowMessages).where(and(
        eq(workflowMessages.workflowId, workflow.id), eq(workflowMessages.stepId, trigger.messageStepId), eq(workflowMessages.channelId, message.channelId), eq(workflowMessages.messageId, message.id), eq(workflowMessages.state, "ACTIVE"),
      )).limit(1);
      if (!tracked) continue;
      await dispatchGatewayWorkflowTrigger(guild, workflow, trigger, member, inputs, `${event}:${message.id}:${user.id}:${emoji}:${trigger.id}`);
    }
  }
}

export async function handleWorkflowReactionAdd(reaction: MessageReaction, user: User): Promise<void> {
  await dispatchReactionTriggers(reaction, user, "reaction.added");
}

export async function handleWorkflowReactionRemove(reaction: MessageReaction, user: User): Promise<void> {
  await dispatchReactionTriggers(reaction, user, "reaction.removed");
}

export async function cleanupEmptyWorkflowVoiceChannels(client: Client): Promise<number> {
  const sessions = await db.select().from(workflowVoiceChannels).where(eq(workflowVoiceChannels.state, "ACTIVE")).limit(100);
  let cleaned = 0;
  for (const session of sessions) {
    const guild = client.guilds.cache.get(session.guildId);
    if (!guild) continue;
    await withGuildAdvisoryLock(`workflow:${session.workflowId}`, async () => {
      const [current] = await db.select().from(workflowVoiceChannels).where(and(eq(workflowVoiceChannels.id, session.id), eq(workflowVoiceChannels.state, "ACTIVE"))).limit(1);
      if (!current) return;
      const channel = guild.channels.cache.get(current.voiceChannelId) ?? await guild.channels.fetch(current.voiceChannelId).catch(() => null);
      const stale = !channel || channel.type === ChannelType.GuildVoice && current.createdAt.getTime() < Date.now() - 30_000 && channel.members.size === 0;
      if (!stale) return;
      try {
        if (channel && channel.type !== ChannelType.GuildVoice) throw new Error("Managed temporary channel is no longer a Voice Channel.");
        await closeVoiceSession(current, guild, true);
        cleaned++;
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "workflow.voice_cleanup_failed", workflowId: current.workflowId, sessionId: current.id, error: error instanceof Error ? error.message : "unknown" }));
      }
    });
  }
  return cleaned;
}

export async function handleInteractiveWorkflowInteraction(interaction: Interaction): Promise<boolean> {
  const isModalButton = interaction.isButton() && interaction.customId.startsWith("iwm:");
  const isButton = interaction.isButton() && interaction.customId.startsWith("iw:");
  const isSelect = interaction.isStringSelectMenu() && interaction.customId.startsWith("iw:");
  const isModalSubmit = interaction.isModalSubmit() && interaction.customId.startsWith("iwms:");
  if (!isModalButton && !isButton && !isSelect && !isModalSubmit) return false;
  if (!interaction.guild) {
    if (interaction.isRepliable()) await interaction.reply({ content: "このWorkflowはサーバー内でのみ利用できます。", ephemeral: true });
    return true;
  }
  const [prefix, workflowId, componentKey] = interaction.customId.split(":");
  const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, workflowId!), eq(interactiveWorkflows.guildId, interaction.guildId!), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
  const sourceMessageId = interaction.isButton() || interaction.isStringSelectMenu() ? interaction.message.id : null;
  if (!workflow || !interaction.isRepliable() || sourceMessageId !== null && sourceMessageId !== workflow.messageId) {
    if (interaction.isRepliable()) await interaction.reply({ content: "このWorkflowは利用できません。", ephemeral: true });
    return true;
  }
  const spec = interactiveWorkflowSchema.parse(workflow.spec);
  const component = spec.components.find((item) => item.key === componentKey);
  if (!component) {
    await interaction.reply({ content: "Workflow componentが見つかりません。", ephemeral: true });
    return true;
  }
  if (isModalButton) {
    if (component.kind !== "modal") {
      await interaction.reply({ content: "このcomponentはModalではありません。", ephemeral: true });
      return true;
    }
    const modal = new ModalBuilder().setCustomId(`iwms:${workflow.id}:${component.key}`).setTitle(component.title);
    modal.addComponents(...component.inputs.map((input) => {
      const text = new TextInputBuilder().setCustomId(input.key).setLabel(input.label).setStyle(input.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(input.required).setMaxLength(input.maxLength);
      if (input.placeholder) text.setPlaceholder(input.placeholder);
      return new ActionRowBuilder<TextInputBuilder>().addComponents(text);
    }));
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit()) {
    const modalComponent = component.kind === "modal" ? component : null;
    if (!modalComponent) {
      await interaction.reply({ content: "このWorkflow componentはModalを受け付けません。", ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const inputs = Object.fromEntries(modalComponent.inputs.map((input) => [input.key, interaction.fields.getTextInputValue(input.key)]));
    const trigger = spec.triggers.find((item) => item.id === modalComponent.triggerId && item.event === "modal_submit");
    if (!trigger) {
      await interaction.editReply("Modal triggerが見つかりません。");
      return true;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const response = await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(interaction.guild!, interaction.id, workflow, trigger.id, member, inputs, []));
    await interaction.editReply(response);
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const event = interaction.isStringSelectMenu() ? "select" : "button";
  if (component.kind !== event) {
    await interaction.editReply("Workflow component typeが一致しません。");
    return true;
  }
  const trigger = spec.triggers.find((item) => item.id === component.triggerId && item.event === event);
  if (!trigger) {
    await interaction.editReply("Workflow triggerが見つかりません。");
    return true;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const selected = interaction.isStringSelectMenu() ? interaction.values : [];
  const response = await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(interaction.guild!, interaction.id, workflow, trigger.id, member, {}, selected));
  await interaction.editReply(response);
  return true;
}
