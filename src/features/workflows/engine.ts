import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonStyle, ChannelType, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type Client, type Guild, type GuildMember, type Interaction, type ModalSubmitInteraction, type StringSelectMenuInteraction, type VoiceState,
} from "discord.js";
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentJobSteps, agentJobs, auditEvents, giveaways, giveawayEntries, giveawayNotifications, interactiveWorkflowRevisions, interactiveWorkflows, managedChannels, managedRoles, workflowEntries, workflowRuns, workflowStates, workflowSchedules, workflowVoiceChannels } from "../../db/schema.js";
import { interactiveWorkflowSchema, orderInteractiveWorkflowSteps, type InteractiveWorkflow, type InteractiveWorkflowStep } from "../../agent/interactive-workflow.js";
import { assertSelfAssignableRole } from "../../policy.js";
import { withGuildAdvisoryLock } from "../../jobs/claim.js";
import { evaluateWorkflowCondition, renderWorkflowTemplate } from "./conditions.js";
import { renderInteractiveWorkflow } from "./render.js";
import { drawWinners, giveawayResultMessage } from "../giveaways/draw.js";

type WorkflowRecord = typeof interactiveWorkflows.$inferSelect;
type WorkflowVoiceSession = typeof workflowVoiceChannels.$inferSelect;
type WorkflowVoiceContext = { sourceChannelId: string; memberCount: number; session: WorkflowVoiceSession | null };
const workflowPermissionNames = ["ManageGuild", "ManageRoles", "ManageChannels", "Administrator"] as const;

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
        if (trigger.event !== "schedule" && trigger.event !== "deadline") return [];
        const intervalSeconds = trigger.event === "schedule" ? trigger.intervalSeconds : null;
        const delaySeconds = trigger.event === "schedule" ? trigger.intervalSeconds : trigger.afterSeconds;
        return [{ id: randomUUID(), workflowId, guildId, triggerId: trigger.id, event: trigger.event, intervalSeconds, nextAt: new Date(Date.now() + delaySeconds * 1000), state: "ACTIVE" }];
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
        await tx.delete(workflowSchedules).where(eq(workflowSchedules.workflowId, workflowId));
        const scheduleRows = workflow.triggers.flatMap((trigger) => {
          if (trigger.event !== "schedule" && trigger.event !== "deadline") return [];
          const intervalSeconds = trigger.event === "schedule" ? trigger.intervalSeconds : null;
          const initialDelay = trigger.event === "schedule" ? trigger.intervalSeconds : trigger.afterSeconds;
          return [{ id: randomUUID(), workflowId, guildId, triggerId: trigger.id, event: trigger.event, intervalSeconds, nextAt: new Date(Date.now() + initialDelay * 1000), state: "ACTIVE" }];
        });
        if (scheduleRows.length) await tx.insert(workflowSchedules).values(scheduleRows);
        const completed = await tx.update(agentJobs).set({ state: "COMPLETED", leaseExpiresAt: null, updatedAt: new Date() })
          .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner))).returning({ id: agentJobs.id });
        if (!completed.length) throw new Error("Workflow update lease expired.");
        await tx.update(agentJobSteps).set({ state: "COMPLETED", result: { workflowId, version: nextVersion }, completedAt: new Date() })
          .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, "update"), eq(agentJobSteps.state, "EXECUTING")));
        await tx.update(agentJobSteps).set({ state: "INSTALLED", completedAt: new Date() })
          .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "DEFINED")));
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId: ownerId, action: "workflow.updated", outcome: "success", detail: { workflowId, beforeVersion: expectedVersion, version: nextVersion } });
      });
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

async function workflowView(workflowId: string, guild: Guild, member?: GuildMember, inputs?: Record<string, string>, selected?: readonly string[]) {
  const entries: Record<string, number> = {};
  const spec = interactiveWorkflowSchema.parse((await db.select({ spec: interactiveWorkflows.spec }).from(interactiveWorkflows).where(eq(interactiveWorkflows.id, workflowId)).limit(1))[0]?.spec);
  const collections = new Set<string>();
  for (const trigger of spec.triggers) for (const step of trigger.steps) if (step.action === "entry.join" || step.action === "entry.leave") collections.add(step.collection);
  for (const collection of collections) {
    const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowEntries).where(and(eq(workflowEntries.workflowId, workflowId), eq(workflowEntries.collection, collection)));
    entries[collection] = count?.count ?? 0;
  }
  const stateRows = await db.select().from(workflowStates).where(and(
    eq(workflowStates.workflowId, workflowId),
    or(and(eq(workflowStates.scope, "workflow"), eq(workflowStates.scopeId, workflowId)), and(eq(workflowStates.scope, "guild"), eq(workflowStates.scopeId, guild.id)), ...(member ? [and(eq(workflowStates.scope, "member"), eq(workflowStates.scopeId, member.id))] : [])),
  ));
  const states = Object.fromEntries(stateRows.map((row) => [`${row.scope}:${row.key}`, row.value]));
  const permissions = new Set(workflowPermissionNames.filter((permission) => member?.permissions.has(PermissionFlagsBits[permission])));
  return {
    spec,
    view: {
      entries,
      states,
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
  const exact = value.match(/^\{\{(state|input):([^}:]+)(?::([^}]+))?\}\}$/);
  if (exact?.[1] === "input") return context.inputs[exact[2]!] ?? "";
  if (exact?.[1] === "state") return context.states[`${exact[2]}:${exact[3] ?? ""}`] ?? null;
  if (exact?.[1] === "result") {
    const result = context.results?.[exact[2]!];
    return result && typeof result === "object" ? (result as Record<string, unknown>)[exact[3]!] ?? null : null;
  }
  return renderWorkflowTemplate(value, context);
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

async function findWorkflowOwnedChannel(workflow: WorkflowRecord, guild: Guild, name: string, kind: "category" | "text", parentId?: string | null) {
  const bindings = await db.select({ channelId: managedChannels.channelId }).from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.ownerJobId, workflow.id), eq(managedChannels.kind, kind)));
  for (const binding of bindings) {
    const channel = guild.channels.cache.get(binding.channelId) ?? await guild.channels.fetch(binding.channelId).catch(() => null);
    const categoryMatches = kind === "category" ? channel?.type === ChannelType.GuildCategory : channel?.type === ChannelType.GuildText && channel.parentId === (parentId ?? null);
    if (categoryMatches && channel?.name === name) return channel;
  }
  return null;
}

function workflowResourceLimit(): number {
  const configured = Number(process.env.MAX_RESOURCES_PER_WORKFLOW ?? 10);
  return Number.isFinite(configured) ? Math.max(1, Math.min(50, configured)) : 10;
}

async function workflowOwnedResourceCount(workflow: WorkflowRecord): Promise<number> {
  const [roles] = await db.select({ count: sql<number>`count(*)::int` }).from(managedRoles).where(and(eq(managedRoles.guildId, workflow.guildId), eq(managedRoles.ownerJobId, workflow.id)));
  const [channels] = await db.select({ count: sql<number>`count(*)::int` }).from(managedChannels).where(and(eq(managedChannels.guildId, workflow.guildId), eq(managedChannels.ownerJobId, workflow.id)));
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

async function executeWorkflowStep(workflow: WorkflowRecord, step: InteractiveWorkflowStep, guild: Guild, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[], results: Record<string, unknown>, voice?: WorkflowVoiceContext): Promise<unknown> {
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
      if (step.scope === "member" && !member) throw new Error("Member-scoped state requires an interaction member.");
      const value = resolveTemplate(step.value, templateContext);
      const scopeId = step.scope === "workflow" ? workflow.id : step.scope === "guild" ? workflow.guildId : member!.id;
      await db.insert(workflowStates).values({ workflowId: workflow.id, scope: step.scope, scopeId, key: step.key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value, updatedAt: new Date() } });
      return { key: step.key, scope: step.scope };
    }
    case "role.grant":
    case "role.revoke": {
      if (!member) throw new Error("Role operations require a member-triggered interaction.");
      const { role, ownerJobId } = await loadManagedRole(workflow.guildId, guild, step.roleName);
      assertSelfAssignableRole(guild, role, ownerJobId);
      const hasRole = member.roles.cache.has(role.id);
      const grant = step.action === "role.grant";
      if (grant && !hasRole) await member.roles.add(role, `Interactive Workflow ${workflow.id}`);
      if (!grant && hasRole) await member.roles.remove(role, `Interactive Workflow ${workflow.id}`);
      return { roleId: role.id, granted: grant };
    }
    case "message.send": {
      const content = renderWorkflowTemplate(step.content, templateContext);
      const channel = step.delivery === "workflow_owner_dm"
        ? await (await guild.members.fetch(workflow.ownerId)).createDM()
        : await guild.channels.fetch(workflow.channelId);
      if (!channel || !channel.isSendable()) throw new Error("Workflow message delivery target is not sendable.");
      const message = await channel.send({ content, allowedMentions: { parse: [] } });
      return { messageId: message.id };
    }
    case "message.edit": {
      const content = renderWorkflowTemplate(step.content, templateContext);
      await db.insert(workflowStates).values({ workflowId: workflow.id, scope: "workflow", scopeId: workflow.id, key: "panel.description", value: content, updatedAt: new Date() }).onConflictDoUpdate({ target: [workflowStates.workflowId, workflowStates.scope, workflowStates.scopeId, workflowStates.key], set: { value: content, updatedAt: new Date() } });
      await refreshWorkflowPanel(workflow, guild, member, inputs, selected);
      return { panelUpdated: true };
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
  }
}

async function runWorkflowTrigger(guild: Guild, interactionId: string, workflow: WorkflowRecord, triggerId: string, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[], voice?: WorkflowVoiceContext): Promise<string> {
  const spec = interactiveWorkflowSchema.parse(workflow.spec);
  const trigger = spec.triggers.find((item) => item.id === triggerId);
  if (!trigger) throw new Error("Workflow trigger no longer exists.");
  const runId = randomUUID();
  const run = await withGuildAdvisoryLock("workflow-global-cap", async () => {
    const configuredConcurrency = Number(process.env.MAX_CONCURRENT_WORKFLOW_RUNS ?? 20);
    const maxConcurrent = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.min(100, configuredConcurrency)) : 20;
    const [running] = await db.select({ count: sql<number>`count(*)::int` }).from(workflowRuns).where(eq(workflowRuns.state, "RUNNING"));
    if ((running?.count ?? 0) >= maxConcurrent) throw new Error("Interactive Workflow concurrency limit reached.");
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
    const outcomes: unknown[] = [];
    const stepResults: Record<string, unknown> = {};
    const skippedStepIds: string[] = [];
    const requiredTriggerPermissions = new Set<bigint>();
    for (const step of trigger.steps) {
      if (step.action === "resource.role.create") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageRoles);
      }
      if (step.action === "resource.channel.create_category" || step.action === "resource.channel.create_text") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageChannels);
      }
      if (step.action === "giveaway.create" || step.action === "giveaway.end" || step.action === "giveaway.pause" || step.action === "giveaway.resume" || step.action === "giveaway.reroll") {
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageGuild);
        requiredTriggerPermissions.add(PermissionFlagsBits.ManageRoles);
      }
    }
    if (requiredTriggerPermissions.size && (!member || !member.permissions.has([...requiredTriggerPermissions]))) throw new Error("This Workflow trigger contains admin resource actions; all required permissions are checked before any step runs.");
    for (const [cursor, step] of orderInteractiveWorkflowSteps(trigger.steps).entries()) {
      if (!(await evaluateStepCondition(step, workflow.id, guild, member, inputs, selected, stepResults, voice))) {
        outcomes.push({ stepId: step.id, state: "SKIPPED" });
        stepResults[step.id] = { state: "SKIPPED" };
        skippedStepIds.push(step.id);
        await db.update(workflowRuns).set({ cursor: cursor + 1, result: outcomes, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
        continue;
      }
      const sendsMessage = step.action === "message.send";
      if (sendsMessage) uncertainSend = true;
      const result = await executeWorkflowStep(workflow, step, guild, member, inputs, selected, stepResults, voice);
      stepResults[step.id] = result;
      outcomes.push({ stepId: step.id, state: "COMPLETED", result });
      await db.update(workflowRuns).set({ cursor: cursor + 1, result: outcomes, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
      if (sendsMessage) uncertainSend = false;
    }
    await db.update(workflowRuns).set({ state: "COMPLETED", result: outcomes, updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, "RUNNING")));
    await db.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member?.id ?? "system", action: "workflow.trigger", outcome: skippedStepIds.length ? "partial" : "success", detail: { runId, triggerId, event: trigger.event, componentKey: "componentKey" in trigger ? trigger.componentKey : null, skippedStepIds } });
    return skippedStepIds.length
      ? `Workflow「${workflow.name}」を処理しました。一部の条件付きSkillは実行されませんでした: ${skippedStepIds.join(", ")}`
      : `Workflow「${workflow.name}」を実行しました。`;
  } catch (error) {
    const recoveryRequired = uncertainSend || Boolean((error as { recoveryRequired?: boolean }).recoveryRequired);
    await db.update(workflowRuns).set({ state: recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED", errorDetail: { message: error instanceof Error ? error.message : "unknown" }, updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, "RUNNING")));
    await db.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member?.id ?? "system", action: "workflow.trigger", outcome: recoveryRequired ? "recovery_required" : "failed", detail: { runId, triggerId, cursor: (await db.select({ cursor: workflowRuns.cursor }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1))[0]?.cursor, message: error instanceof Error ? error.message : "unknown" } });
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
      if (!prior) {
        const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, claimed.workflowId), eq(interactiveWorkflows.guildId, claimed.guildId), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
        if (!workflow) throw Object.assign(new Error("Scheduled Workflow is no longer active."), { recoveryRequired: true });
        const spec = interactiveWorkflowSchema.parse(workflow.spec);
        const trigger = spec.triggers.find((candidate) => candidate.id === claimed.triggerId);
        if (!trigger || trigger.event !== "schedule" && trigger.event !== "deadline") throw Object.assign(new Error("Scheduled trigger definition is missing or changed."), { recoveryRequired: true });
        const guild = client.guilds.cache.get(claimed.guildId) ?? await client.guilds.fetch(claimed.guildId);
        await withGuildAdvisoryLock(`workflow:${workflow.id}`, () => runWorkflowTrigger(guild, occurrenceId, workflow, trigger.id, undefined, {}, []));
      }
      const isDeadline = claimed.event === "deadline";
      await db.update(workflowSchedules).set({ state: isDeadline ? "COMPLETED" : "ACTIVE", nextAt: isDeadline ? claimed.nextAt : new Date(Date.now() + (claimed.intervalSeconds ?? 60) * 1000), leaseOwner: null, leaseExpiresAt: null, attempts: 0, lastError: null })
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

function humanVoiceMemberCount(voiceChannel: import("discord.js").VoiceChannel | null): number {
  return voiceChannel?.members.filter((member) => !member.user.bot).size ?? 0;
}

export async function handleWorkflowVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  if (oldState.channelId === newState.channelId) return;
  const guild = newState.guild;
  const eventWindow = Math.floor(Date.now() / 1000);
  if (newState.channel?.type === ChannelType.GuildVoice && newState.member && !newState.member.user.bot) {
    const workflows = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.guildId, guild.id), eq(interactiveWorkflows.state, "ACTIVE")));
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
