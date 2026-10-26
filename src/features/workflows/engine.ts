import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonStyle, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type Client, type Guild, type GuildMember, type Interaction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentJobSteps, agentJobs, auditEvents, giveawayEntries, interactiveWorkflowRevisions, interactiveWorkflows, managedRoles, workflowEntries, workflowRuns, workflowStates, workflowSchedules } from "../../db/schema.js";
import { interactiveWorkflowSchema, orderInteractiveWorkflowSteps, type InteractiveWorkflow, type InteractiveWorkflowStep } from "../../agent/interactive-workflow.js";
import { assertSelfAssignableRole } from "../../policy.js";
import { withGuildAdvisoryLock } from "../../jobs/claim.js";
import { evaluateWorkflowCondition, renderWorkflowTemplate } from "./conditions.js";
import { renderInteractiveWorkflow } from "./render.js";

type WorkflowRecord = typeof interactiveWorkflows.$inferSelect;

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
  return {
    spec,
    view: {
      entries,
      states,
      roleNames: new Set(member?.roles.cache.map((role) => role.name) ?? []),
      permissions: new Set(member?.permissions.toArray() ?? []),
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

async function evaluateStepCondition(step: InteractiveWorkflowStep, workflowId: string, guild: Guild, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[], results: Record<string, unknown>): Promise<boolean> {
  if (!step.when) return true;
  const context = await workflowView(workflowId, guild, member, inputs, selected);
  return evaluateWorkflowCondition(step.when, { ...context.view, results });
}

async function executeWorkflowStep(workflow: WorkflowRecord, step: InteractiveWorkflowStep, guild: Guild, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[], results: Record<string, unknown>): Promise<unknown> {
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
      const channel = await guild.channels.fetch(workflow.channelId);
      if (!channel?.isSendable()) throw new Error("Workflow target channel is not sendable.");
      const content = renderWorkflowTemplate(step.content, templateContext);
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
  }
}

async function runWorkflowTrigger(guild: Guild, interactionId: string, workflow: WorkflowRecord, triggerId: string, member: GuildMember | undefined, inputs: Record<string, string>, selected: readonly string[]): Promise<string> {
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
          eq(workflowRuns.workflowId, workflow.id), eq(workflowRuns.actorId, member.id), gt(workflowRuns.createdAt, new Date(Date.now() - cooldownMs)),
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
    for (const [cursor, step] of orderInteractiveWorkflowSteps(trigger.steps).entries()) {
      if (!(await evaluateStepCondition(step, workflow.id, guild, member, inputs, selected, stepResults))) {
        outcomes.push({ stepId: step.id, state: "SKIPPED" });
        stepResults[step.id] = { state: "SKIPPED" };
        await db.update(workflowRuns).set({ cursor: cursor + 1, result: outcomes, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
        continue;
      }
      const sendsMessage = step.action === "message.send";
      if (sendsMessage) uncertainSend = true;
      const result = await executeWorkflowStep(workflow, step, guild, member, inputs, selected, stepResults);
      stepResults[step.id] = result;
      outcomes.push({ stepId: step.id, state: "COMPLETED", result });
      await db.update(workflowRuns).set({ cursor: cursor + 1, result: outcomes, updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
      if (sendsMessage) uncertainSend = false;
    }
    await db.update(workflowRuns).set({ state: "COMPLETED", result: outcomes, updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, "RUNNING")));
      await db.insert(auditEvents).values({ id: randomUUID(), jobId: workflow.id, guildId: workflow.guildId, actorId: member?.id ?? "system", action: "workflow.trigger", outcome: "success", detail: { runId, triggerId, event: trigger.event, componentKey: "componentKey" in trigger ? trigger.componentKey : null } });
    return `Workflow「${workflow.name}」を実行しました。`;
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
