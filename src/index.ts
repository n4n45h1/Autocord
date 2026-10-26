import "dotenv/config";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  ChannelType, GatewayIntentBits, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type GuildMember, type InteractionReplyOptions, type MessageCreateOptions, type ModalSubmitInteraction, type Role,
} from "discord.js";
import { and, eq, gt, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db, pool } from "./db/client.js";
import { agentJobs, agentJobSteps, auditEvents, giveaways, giveawayEntries, giveawayNotifications, guildSettings, interactiveWorkflows, managedChannels, managedRoles, panelOptions, panelRevisions, panels, usageRecords } from "./db/schema.js";
import { makePlan, type AgentMode } from "./agent/planner.js";
import { orderResourceSteps, type MaxWorkflowOperation, type ResourceWorkflowStep } from "./agent/workflow.js";
import { panelPlanSchema, type PanelPlan } from "./agent/plan.js";
import { failUsageReservation, finishUsage, reserveUsage, type UsageReservation } from "./agent/core/usage.js";
import { assertDistributableRole, assertInteractiveWorkflowPermissions, assertInteractiveWorkflowUpdatePermission, assertPolicy, assertResourceWorkflowPermissions, assertSelfAssignableRole, assertSkillPermissions, isExpectedRevision } from "./policy.js";
import { claimApproval, recoverExpiredExecutionLeases, withGuildAdvisoryLock } from "./jobs/claim.js";
import { approvalHash } from "./jobs/approval-hash.js";
import { commands } from "./discord/commands.js";
import { drawWinners, giveawayNotificationRetryDelayMs, giveawayResultMessage } from "./features/giveaways/draw.js";
import { renderPanel } from "./features/panels/render.js";
import { listAgentSkills, parseResourceWorkflowInput, parseSkillInput, resolvePanelSkill, resolveResourceSkill, type AgentSkillId } from "./agent/skills/registry.js";
import { compileInteractiveWorkflow, interactiveWorkflowSchema, type InteractiveWorkflow, type InteractiveWorkflowStep } from "./agent/interactive-workflow.js";
import { analyzeRequestRequirements, validatePlanTargetAgainstRequest, validateWorkflowAgainstRequest } from "./agent/requirements.js";
import { cleanupEmptyWorkflowVoiceChannels, dispatchWorkflowSchedules, handleInteractiveWorkflowInteraction, handleWorkflowVoiceStateUpdate, publishInteractiveWorkflow, recoverStaleInteractiveRuns, updateInteractiveWorkflow } from "./features/workflows/engine.js";
import { renderInteractiveWorkflow } from "./features/workflows/render.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const workerId = randomUUID();
const adminPerms = [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles];

function requireAdmin(member: GuildMember): void {
  if (!adminPerms.every((permission) => member.permissions.has(permission))) throw new Error("サーバー管理とロール管理の権限が必要です。");
}

function displaySendableChannel(channel: unknown): string | null {
  if (!channel || typeof channel !== "object") return null;
  const candidate = channel as { id: string; name?: string; isSendable?: () => boolean };
  return candidate.isSendable?.() ? `• #${candidate.name ?? candidate.id} (${candidate.id})` : null;
}

function isLikelyEdit(text: string): boolean {
  return /(?:昨日|さっき|既存|この|その|パネル).*(?:変更|編集|色|説明|追加|削除|戻|して)|(?:紫色|青色|緑色|赤色|追加して|削除して|変更して|編集して|おしゃれに|戻して|元に戻)/u.test(text);
}

function stablePanelPlan(plan: PanelPlan, panelId: string, revision: number): PanelPlan {
  return { ...plan, intent: "edit", panelId, expectedRevision: revision };
}

function planDiff(before: PanelPlan | undefined, after: PanelPlan): string {
  if (!before) return `作成: ${after.title}\n色: ${after.color}\n表示: ${after.renderMode === "components_v2" ? "Components V2カード" : "Classic Embed"} / ${after.componentStyle}\n選択肢: ${after.options.map((option) => `${option.label} → ${option.roleName}`).join("、")}`;
  const changes: string[] = [];
  if (before.title !== after.title) changes.push(`タイトル: ${before.title} → ${after.title}`);
  if (before.description !== after.description) changes.push("説明文を変更");
  if (before.color !== after.color) changes.push(`色: ${before.color} → ${after.color}`);
  if (before.renderMode !== after.renderMode) changes.push(`描画方式: ${before.renderMode} → ${after.renderMode}`);
  if (before.componentStyle !== after.componentStyle || before.selectionMode !== after.selectionMode) changes.push(`操作方式: ${before.componentStyle}/${before.selectionMode} → ${after.componentStyle}/${after.selectionMode}`);
  const oldKeys = new Set(before.options.map((option) => option.key));
  const newKeys = new Set(after.options.map((option) => option.key));
  for (const option of after.options) if (!oldKeys.has(option.key)) changes.push(`追加: ${option.label} (新規ロール「${option.roleName}」)`);
  for (const option of after.options) {
    const old = before.options.find((candidate) => candidate.key === option.key);
    if (old && old.roleName !== option.roleName) changes.push(`ロール名: ${old.roleName} → ${option.roleName}`);
  }
  for (const option of before.options) if (!newKeys.has(option.key)) changes.push(`パネルから除外: ${option.label} (ロールは削除しません)`);
  return changes.length ? changes.join("\n") : "表示内容に差分はありません。";
}

function resourceStepSummary(step: ResourceWorkflowStep): string {
  switch (step.action) {
    case "role.create": return `ロール「${step.name}」を権限なしで作成`;
    case "channel.create_category": return `カテゴリ「${step.name}」を作成`;
    case "channel.create_text": return `テキストチャンネル「${step.name}」を作成${step.categoryStepId ? `（step ${step.categoryStepId}のカテゴリ配下）` : ""}`;
  }
}

async function assertWorkflowManagedRoles(guildId: string, guild: import("discord.js").Guild, workflow: InteractiveWorkflow): Promise<void> {
  const roleNames = new Set(workflow.triggers.flatMap((trigger) => trigger.steps)
    .filter((step) => step.action === "role.grant" || step.action === "role.revoke").map((step) => step.roleName));
  const owned = await db.select({ roleId: managedRoles.roleId, ownerJobId: managedRoles.ownerJobId }).from(managedRoles).where(eq(managedRoles.guildId, guildId));
  for (const step of workflow.triggers.flatMap((trigger) => trigger.steps).filter((item) => item.action === "resource.role.create")) {
    if (guild.roles.cache.some((role) => role.name === step.name)) throw new Error(`Workflow role.create cannot shadow an existing role name: ${step.name}`);
  }
  for (const roleName of roleNames) {
    const matches = [];
    for (const record of owned) {
      const role = guild.roles.cache.get(record.roleId) ?? await guild.roles.fetch(record.roleId).catch(() => null);
      if (role?.name === roleName) matches.push({ role, ownerJobId: record.ownerJobId });
    }
    if (matches.length > 1) throw new Error(`Workflow role is ambiguous: ${roleName}`);
    if (matches.length === 1) {
      assertSelfAssignableRole(guild, matches[0]!.role, matches[0]!.ownerJobId);
      continue;
    }
    const createsInWorkflow = workflow.triggers.some((trigger) => trigger.steps.some((step) => step.action === "resource.role.create" && step.name === roleName));
    if (!createsInWorkflow) throw new Error(`Role ${roleName} must already be Autocord-managed or be created by a resource.role.create step in this Workflow.`);
  }
}

async function assertWorkflowVoiceBindings(guild: import("discord.js").Guild, workflow: InteractiveWorkflow): Promise<void> {
  const bot = guild.members.me;
  if (!bot) throw new Error("Bot guild member could not be resolved.");
  for (const trigger of workflow.triggers) {
    if (trigger.event !== "voice.member_join_event") continue;
    const channel = await guild.channels.fetch(trigger.voiceChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error(`Voice Lobby ${trigger.voiceChannelId} does not resolve to a Guild Voice Channel in this server.`);
    const permissions = channel.permissionsFor(bot);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers])) throw new Error(`Bot needs View Channel, Connect, Manage Channels and Move Members in Voice Lobby ${channel.name}.`);
  }
}

function interactiveWorkflowSummary(workflow: InteractiveWorkflow): string {
  const effect = (step: InteractiveWorkflowStep): string => {
    switch (step.action) {
      case "entry.join": return `entry.join ${step.collection} max=${step.maxEntries}`;
      case "entry.leave": return `entry.leave ${step.collection}`;
      case "state.set": return `state.set ${step.scope}:${step.key}`;
      case "role.grant": return `role.grant ${step.roleName} to trigger member`;
      case "role.revoke": return `role.revoke ${step.roleName} from trigger member`;
      case "message.send": return `message.send ${step.delivery === "workflow_owner_dm" ? "Workflow owner DM (private)" : "workflow channel (public)"}`;
      case "message.edit": return "message.edit Workflow panel display";
      case "panel.refresh": return "panel.refresh rendered state/components";
      case "voice.channel.create": return `voice.channel.create ${step.name}; moveMembers=${step.moveMembers}; copy source permission overwrites`;
      case "voice.channel.delete": return "voice.channel.delete Workflow-owned channel when empty";
      case "resource.role.create": return `resource.role.create ${step.name} (no permissions)`;
      case "resource.channel.create_category": return `resource.channel.create_category ${step.name} (Guild default permissions)`;
      case "resource.channel.create_text": return `resource.channel.create_text ${step.name}${step.categoryStepId ? ` under category step ${step.categoryStepId}` : ""} (Guild default permissions)`;
      case "giveaway.create": return `giveaway.create ${step.prize}; ${step.winnerCount} winners; ${step.durationSeconds}s`;
      case "giveaway.join": return `giveaway.join ${step.giveawayId} for trigger member`;
      case "giveaway.leave": return `giveaway.leave ${step.giveawayId} for trigger member`;
      case "giveaway.end": return `giveaway.end ${step.giveawayId}`;
      case "giveaway.pause": return `giveaway.pause ${step.giveawayId}`;
      case "giveaway.resume": return `giveaway.resume ${step.giveawayId}`;
      case "giveaway.reroll": return `giveaway.reroll ${step.giveawayId}`;
      default: return JSON.stringify(step);
    }
  };
  const componentSummary = workflow.components.map((component) => {
    if (component.kind === "modal") return `modal:${component.key} (${component.inputs.map((input) => `${input.key}:${input.label}${input.required ? " required" : ""}`).join(", ")})`;
    if (component.kind === "select") return `select:${component.key} (${component.options.length} options: ${component.options.slice(0, 5).map((option) => option.label).join(", ")}${component.options.length > 5 ? ", …" : ""})`;
    return `button:${component.key} ${component.label} [${component.style}]`;
  }).join("; ");
  const triggerSummary = workflow.triggers.map((trigger) => {
    const timing = trigger.event === "schedule" ? ` every ${trigger.intervalSeconds}s` : trigger.event === "deadline" ? ` after ${trigger.afterSeconds}s` : "";
    const voiceSource = "voiceChannelId" in trigger ? ` sourceVoice=${trigger.voiceChannelId}` : "";
    const steps = trigger.steps.map((step) => `${step.id}: ${effect(step)}${step.dependsOn.length ? ` after[${step.dependsOn.join(",")}]` : ""}${step.when ? ` when ${JSON.stringify(step.when)}` : ""}`).join(" → ");
    return `• ${trigger.event}${"componentKey" in trigger ? `(${trigger.componentKey})` : ""}${voiceSource}${timing}: ${steps}`;
  }).join("\n");
  return `${workflow.name}\nUI: ${componentSummary}\nTriggers and side effects:\n${triggerSummary}`;
}

function interactiveWorkflowDiff(before: InteractiveWorkflow, after: InteractiveWorkflow, version: number): string {
  return `更新: ${before.name} v${version} → ${after.name} v${version + 1}\n${interactiveWorkflowSummary(after)}`;
}

function preview(plan: PanelPlan | null, jobId: string, before?: PanelPlan, workflowSteps?: MaxWorkflowOperation[], resourceSteps?: ResourceWorkflowStep[], interactiveWorkflow?: InteractiveWorkflow, beforeWorkflow?: InteractiveWorkflow, workflowVersion?: number): InteractionReplyOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve:${jobId}`).setLabel("承認して実行").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny:${jobId}`).setLabel("却下").setStyle(ButtonStyle.Secondary),
  );
  const title = plan ? `Agentcord ${plan.intent === "create" ? "作成" : "編集"}プレビュー` : interactiveWorkflow ? "Agentcord Interactive Workflowプレビュー" : "Agentcord リソース作成プレビュー";
  const diff = plan ? planDiff(before, plan) : interactiveWorkflow ? beforeWorkflow ? interactiveWorkflowDiff(beforeWorkflow, interactiveWorkflow, workflowVersion ?? 1) : interactiveWorkflowSummary(interactiveWorkflow) : resourceSteps?.map(resourceStepSummary).join("\n") ?? "";
  const panelSteps = workflowSteps?.length ? `\n\n**Max Workflow**\n${workflowSteps.map((step, index) => `${index + 1}. ${step.id}: ${step.action}${step.dependsOn.length ? ` (after ${step.dependsOn.join(", ")})` : ""}`).join("\n")}` : "";
  const guildSteps = resourceSteps?.length ? `\n\n**Max Resource Skills**\n${resourceSteps.map((step, index) => `${index + 1}. ${step.id}: ${resourceStepSummary(step)}${step.dependsOn.length ? ` (after ${step.dependsOn.join(", ")})` : ""}`).join("\n")}` : "";
  const content = `**${title}**\n${diff}${panelSteps}${guildSteps}\n\nジョブ: \`${jobId}\`\n10分以内に管理者が承認してください。`;
  return { content: content.length > 1900 ? `${content.slice(0, 1880)}\n…（詳細は省略。登録Skills/副作用の一覧を確認してください）` : content, components: [row], allowedMentions: { parse: [] } };
}

type PlanInteraction = Pick<ChatInputCommandInteraction, "guild" | "guildId" | "user" | "channel" | "channelId" | "followUp" | "editReply"> | Pick<ModalSubmitInteraction, "guild" | "guildId" | "user" | "channel" | "channelId" | "followUp" | "editReply">;

async function savePlanClarification(input: {
  interaction: PlanInteraction;
  jobId: string;
  reservation?: UsageReservation;
  clarification: { questions: string[]; missingSkills: string[] };
  selectedPanel?: typeof panels.$inferSelect;
  selectedWorkflow?: typeof interactiveWorkflows.$inferSelect;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  const { interaction, jobId, reservation, clarification, selectedPanel, selectedWorkflow } = input;
  const explanation = [
    clarification.missingSkills.length ? "要求を満たすSkillsが未実装です。別機能のPlanには置き換えません。" : "Planを公開する前に、次の確認事項への回答が必要です。",
    ...clarification.questions.map((question, index) => `${index + 1}. ${question}`),
    ...(clarification.missingSkills.length ? [`開発者向けSkills提案: ${clarification.missingSkills.join("、")}`] : []),
  ].join("\n");
  const clarificationContext = { clarification, panelId: selectedPanel?.id ?? null, expectedPanelRevision: selectedPanel?.revision ?? null, workflowId: selectedWorkflow?.id ?? null, expectedWorkflowVersion: selectedWorkflow?.version ?? null };
  const components = clarification.missingSkills.length ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`clarify:${jobId}`).setLabel("確認事項に回答").setStyle(ButtonStyle.Primary))];
  await db.update(agentJobs).set({ state: "NEEDS_INPUT", executionContext: clarificationContext, updatedAt: new Date() })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "PLANNING")));
  await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "plan.needs_input", outcome: clarification.missingSkills.length ? "missing_skills" : "clarification", detail: { questions: clarification.questions.length, missingSkills: clarification.missingSkills } });
  if (reservation) await finishUsage(reservation, input.model ?? "requirements-validator", input.inputTokens ?? 0, input.outputTokens ?? 0);
  await interaction.editReply({ content: explanation, components, allowedMentions: { parse: [] } });
}

async function writePlan(interaction: PlanInteraction, jobId: string, instruction: string, mode: AgentMode, selectedPanel?: typeof panels.$inferSelect, reservation?: UsageReservation, selectedWorkflow?: typeof interactiveWorkflows.$inferSelect): Promise<boolean> {
  const existing = selectedPanel ? stablePanelPlan(panelPlanSchema.parse(selectedPanel.spec), selectedPanel.id, selectedPanel.revision) : undefined;
  try {
    const existingWorkflowSpec = selectedWorkflow ? interactiveWorkflowSchema.parse(selectedWorkflow.spec) : undefined;
    const requestRequirements = analyzeRequestRequirements(instruction);
    const managedRoleBindings = await db.select({ roleId: managedRoles.roleId }).from(managedRoles).where(eq(managedRoles.guildId, interaction.guildId!));
    const availableManagedRoles: string[] = [];
    for (const binding of managedRoleBindings) {
      const role = interaction.guild!.roles.cache.get(binding.roleId) ?? await interaction.guild!.roles.fetch(binding.roleId).catch(() => null);
      if (role) availableManagedRoles.push(role.name);
    }
    const allChannels = await interaction.guild!.channels.fetch();
    const allVoiceChannels = [...allChannels.values()].flatMap((channel) => channel && channel.type === ChannelType.GuildVoice ? [{ id: channel.id, name: channel.name, category: channel.parent?.name ?? null }] : []);
    const namedVoiceChannels = allVoiceChannels.filter((channel) => instruction.toLocaleLowerCase().includes(channel.name.toLocaleLowerCase()));
    if (requestRequirements.voiceRequested && !allVoiceChannels.length) {
      await savePlanClarification({ interaction, jobId, reservation, selectedPanel, selectedWorkflow, clarification: { questions: ["先に参加者が集まるVoice Lobbyをサーバーへ作成してください。その後、/agentのworkflow_idまたはLobby名を指定して再依頼してください。"], missingSkills: [] } });
      return false;
    }
    if (requestRequirements.voiceRequested && allVoiceChannels.length > 1 && namedVoiceChannels.length !== 1) {
      await savePlanClarification({ interaction, jobId, reservation, selectedPanel, selectedWorkflow, clarification: { questions: [`どのVoice Lobbyを監視しますか？候補: ${allVoiceChannels.map((channel) => channel.name).join("、")}`], missingSkills: [] } });
      return false;
    }
    const availableVoiceChannels = requestRequirements.voiceRequested && namedVoiceChannels.length === 1 ? namedVoiceChannels : allVoiceChannels;
    const result = await makePlan(instruction, existing, mode, selectedWorkflow ? { id: selectedWorkflow.id, version: selectedWorkflow.version, spec: existingWorkflowSpec! } : undefined, availableManagedRoles, availableVoiceChannels);
    const actor = await interaction.guild!.members.fetch(interaction.user.id);

    if (result.clarification) {
      await savePlanClarification({ interaction, jobId, reservation, selectedPanel, selectedWorkflow, clarification: result.clarification, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return false;
    }
    if (requestRequirements.voiceRequested && !availableVoiceChannels.length) {
      await savePlanClarification({ interaction, jobId, reservation, selectedPanel, selectedWorkflow, clarification: { questions: ["募集の参加者が集まる既存Voice Lobbyを作成し、Workflow ID autocompleteから再依頼してください。"], missingSkills: [] }, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return false;
    }
    const targetIssues = validatePlanTargetAgainstRequest(instruction, result.interactiveWorkflow ? "interactive" : result.resourceSteps ? "resources" : "panel");
    if (targetIssues.length) {
      await savePlanClarification({ interaction, jobId, reservation, selectedPanel, selectedWorkflow, clarification: { questions: targetIssues, missingSkills: [] }, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return false;
    }

    if (result.resourceSteps) {
      if (selectedPanel || selectedWorkflow) throw new Error("リソース作成と既存パネル/Workflow編集は別ジョブにしてください。");
      const workflow = parseResourceWorkflowInput({ version: 1, steps: result.resourceSteps });
      assertResourceWorkflowPermissions(interaction.guild!, workflow, actor);
      const executionContext = { resourceWorkflow: workflow };
      const hash = approvalHash({ guildId: interaction.guildId!, revision: null, plan: null, executionContext });
      const expiresAt = new Date(Date.now() + Number(process.env.APPROVAL_TTL_MINUTES ?? 10) * 60_000);
      await db.transaction(async (tx) => {
        const saved = await tx.update(agentJobs).set({ state: "AWAITING_APPROVAL", mode, plan: null, planHash: hash, planHashVersion: 2, executionContext, revision: null, expiresAt, updatedAt: new Date() })
          .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "PLANNING"))).returning({ id: agentJobs.id });
        if (saved.length !== 1) throw new Error("ジョブ状態が変化しました。もう一度依頼してください。");
        await tx.insert(agentJobSteps).values(workflow.steps.map((step, sequence) => ({ id: randomUUID(), jobId, guildId: interaction.guildId!, stepId: step.id, sequence, skillId: resolveResourceSkill(step), state: "PENDING", input: step })));
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "resource.workflow.created", outcome: "success", detail: { planHash: hash, mode, model: result.model, stepCount: workflow.steps.length, skillIds: workflow.steps.map(resolveResourceSkill) } });
      });
      if (reservation) await finishUsage(reservation, result.model, result.inputTokens, result.outputTokens);
      await interaction.followUp({ ...preview(null, jobId, undefined, undefined, workflow.steps), ephemeral: true });
      return true;
    }

    if (result.interactiveWorkflow) {
      if (selectedPanel) throw new Error("Workflow作成/編集と既存パネル編集は別ジョブにしてください。");
      const workflowChannelId = selectedWorkflow?.channelId ?? interaction.channelId;
      const destination = workflowChannelId ? interaction.guild!.channels.cache.get(workflowChannelId) ?? await interaction.guild!.channels.fetch(workflowChannelId).catch(() => null) : null;
      if (!destination?.isSendable() || !workflowChannelId) throw new Error("Workflowの公開/更新チャンネルに送信できません。");
      const workflow = compileInteractiveWorkflow(result.interactiveWorkflow);
      const requirementIssues = validateWorkflowAgainstRequest(instruction, workflow);
      if (requirementIssues.length) {
        await savePlanClarification({ interaction, jobId, reservation, selectedPanel, selectedWorkflow, clarification: { questions: requirementIssues, missingSkills: [] }, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        return false;
      }
      assertInteractiveWorkflowPermissions(interaction.guild!, workflow, actor);
      await assertWorkflowVoiceBindings(interaction.guild!, workflow);
      if (selectedWorkflow) assertInteractiveWorkflowUpdatePermission(actor);
      await assertWorkflowManagedRoles(interaction.guildId!, interaction.guild!, workflow);
      if (Boolean(selectedWorkflow) !== Boolean(result.interactiveWorkflowId) || selectedWorkflow && result.expectedWorkflowVersion !== selectedWorkflow.version) throw new Error("更新対象Workflow/versionが一致しません。");
      const workflowIntent = selectedWorkflow ? "edit" : "create";
      const executionContext = { interactiveWorkflow: workflow, publishChannelId: workflowChannelId, workflowIntent, workflowId: selectedWorkflow?.id ?? null, expectedWorkflowVersion: selectedWorkflow?.version ?? null };
      const hash = approvalHash({ guildId: interaction.guildId!, revision: selectedWorkflow?.version ?? null, plan: null, executionContext });
      const expiresAt = new Date(Date.now() + Number(process.env.APPROVAL_TTL_MINUTES ?? 10) * 60_000);
      await db.transaction(async (tx) => {
        const saved = await tx.update(agentJobs).set({ state: "AWAITING_APPROVAL", mode, plan: null, planHash: hash, planHashVersion: 2, executionContext, revision: selectedWorkflow?.version ?? null, expiresAt, updatedAt: new Date() })
          .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "PLANNING"))).returning({ id: agentJobs.id });
        if (saved.length !== 1) throw new Error("ジョブ状態が変化しました。もう一度依頼してください。");
        await tx.insert(agentJobSteps).values([
          { id: randomUUID(), jobId, guildId: interaction.guildId!, stepId: workflowIntent === "create" ? "publish" : "update", sequence: 0, skillId: workflowIntent === "create" ? "workflow.publish" : "workflow.update", state: "PENDING", input: { name: workflow.name, version: selectedWorkflow?.version ?? workflow.version, channelId: workflowChannelId } },
          ...workflow.triggers.flatMap((trigger, triggerIndex) => trigger.steps.map((step, stepIndex) => ({
            id: randomUUID(), jobId, guildId: interaction.guildId!, stepId: `${trigger.id}:${step.id}`, sequence: triggerIndex * 12 + stepIndex + 1,
            skillId: `workflow.${step.action}`, state: "DEFINED", input: { triggerId: trigger.id, componentKey: "componentKey" in trigger ? trigger.componentKey : null, event: trigger.event, step },
          }))),
        ]);
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: workflowIntent === "create" ? "workflow.plan.created" : "workflow.plan.update", outcome: "success", detail: { planHash: hash, model: result.model, workflowId: selectedWorkflow?.id ?? null, workflowName: workflow.name, version: selectedWorkflow?.version ?? workflow.version, componentCount: workflow.components.length, triggerCount: workflow.triggers.length } });
      });
      if (reservation) await finishUsage(reservation, result.model, result.inputTokens, result.outputTokens);
      await interaction.followUp({ ...preview(null, jobId, undefined, undefined, undefined, workflow, existingWorkflowSpec, selectedWorkflow?.version), ephemeral: true });
      return true;
    }

    if (!result.plan) throw new Error("Agentcordが実行可能なSkill planを返しませんでした。");
    let plan = result.plan;
    if (selectedPanel && (plan.intent !== "edit" || plan.panelId !== selectedPanel.id || plan.expectedRevision !== selectedPanel.revision)) throw new Error("編集対象またはrevisionが一致しません。もう一度パネルを選んでください。");
    if (!selectedPanel && plan.intent !== "create") throw new Error("編集対象パネルを確定できませんでした。");
    if (selectedPanel && panelPlanSchema.parse(selectedPanel.spec).renderMode !== plan.renderMode) throw new Error("Discordのメッセージ仕様上、既存パネルの描画方式は変更できません。別パネルとして作成してください。");
    const trustedChannelId = selectedPanel?.channelId ?? interaction.channelId;
    if (!trustedChannelId || plan.channelId && plan.channelId !== trustedChannelId) throw new Error("この操作では依頼したチャンネルへの発行のみ対応しています。");
    plan = panelPlanSchema.parse({ ...plan, channelId: trustedChannelId });
    if (result.workflowSteps) assertSkillPermissions("panel.workflow", actor);
    assertPolicy(interaction.guild!, actor, plan);
    const executionContext = result.workflowSteps ? { workflowSteps: result.workflowSteps } : null;
    const hash = approvalHash({ guildId: interaction.guildId!, revision: selectedPanel?.revision ?? null, plan, executionContext });
    const expiresAt = new Date(Date.now() + Number(process.env.APPROVAL_TTL_MINUTES ?? 10) * 60_000);
    const planSteps = result.workflowSteps?.map((step) => ({ stepId: step.id, skillId: "panel.workflow", input: step }))
      ?? [{ stepId: `panel-${plan.intent}`, skillId: resolvePanelSkill(plan).id, input: plan }];
    await db.transaction(async (tx) => {
      const saved = await tx.update(agentJobs).set({ state: "AWAITING_APPROVAL", mode, plan, planHash: hash, planHashVersion: 2, executionContext, revision: selectedPanel?.revision ?? null, expiresAt, updatedAt: new Date() })
        .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "PLANNING"))).returning({ id: agentJobs.id });
      if (saved.length !== 1) throw new Error("ジョブ状態が変化しました。もう一度依頼してください。");
      await tx.insert(agentJobSteps).values(planSteps.map((step, sequence) => ({ id: randomUUID(), jobId, guildId: interaction.guildId!, stepId: step.stepId, sequence, skillId: step.skillId, state: "PENDING", input: step.input })));
      await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "plan.created", outcome: "success", detail: { planHash: hash, mode, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, beforeRevision: selectedPanel?.revision ?? null, workflowSteps: result.workflowSteps?.map(({ id, action, dependsOn }) => ({ id, action, dependsOn })) } });
    });
    const reservationRow = reservation ? await db.select().from(usageRecords).where(eq(usageRecords.id, reservation.id)).limit(1) : [];
    if (reservation && reservationRow.length) await finishUsage(reservation, result.model, result.inputTokens, result.outputTokens);
    await interaction.followUp({ ...preview(plan, jobId, existing, result.workflowSteps), ephemeral: true });
    return true;
  } catch (error) {
    if (reservation) await failUsageReservation(reservation);
    await db.update(agentJobs).set({ state: "FAILED", errorDetail: { message: error instanceof Error ? error.message : "unknown" }, updatedAt: new Date() }).where(eq(agentJobs.id, jobId));
    throw error;
  }
}

async function handleAgent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.memberPermissions) return void await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const jobId = interaction.id;
  let reservation: UsageReservation | undefined;
  try {
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (!actor.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error("サーバー管理の権限が必要です。");
    const workflowId = interaction.options.getString("workflow_id");
    const mode = (interaction.options.getString("mode") ?? (workflowId ? "max" : "mini")) as AgentMode;
    const instruction = interaction.options.getString("指示", true);
    const requestRequirements = analyzeRequestRequirements(instruction);
    if (mode === "mini" && requestRequirements.unsupportedSkills.length) {
      return void await interaction.editReply(`この要求に必要なSkillsは未実装です: ${requestRequirements.unsupportedSkills.join("、")}。Workflowは作成しません。`);
    }
    if (mode === "mini" && requestRequirements.complex) {
      return void await interaction.editReply("この依頼には複数のTrigger/Actionを組み合わせる必要があります。Planは作成していません。/agentのmodeをMaxにして再依頼してください。");
    }
    let selectedWorkflow: typeof interactiveWorkflows.$inferSelect | undefined;
    if (workflowId) {
      if (mode !== "max") throw new Error("既存Interactive Workflow編集にはAgentcord Maxを選択してください。");
      const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, workflowId), eq(interactiveWorkflows.guildId, interaction.guildId!), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
      if (!workflow) throw new Error("このサーバーの有効なInteractive Workflowが見つかりません。");
      selectedWorkflow = workflow;
    }
    reservation = await reserveUsage(interaction.guildId!, interaction.user.id, jobId, mode, instruction);
    const matches = !selectedWorkflow && isLikelyEdit(instruction) ? await db.select().from(panels).where(eq(panels.guildId, interaction.guildId!)).orderBy(sql`${panels.updatedAt} desc`).limit(25) : [];
    if (isLikelyEdit(instruction) && matches.length > 1) {
      await db.update(agentJobs).set({ state: "AWAITING_PANEL_SELECTION", updatedAt: new Date() }).where(eq(agentJobs.id, jobId));
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`target:${jobId}`).setPlaceholder("編集するパネルを選択").addOptions(matches.map((panel) => ({ label: panel.title.slice(0, 100), value: panel.id, description: `revision ${panel.revision}` }))));
      await interaction.editReply({ content: "編集対象のパネルを選んでください。選択後に変更プレビューを作成します。", components: [row] });
      return;
    }
    const selectedPanel = matches.length === 1 ? matches[0] : undefined;
    const previewCreated = await writePlan(interaction, jobId, instruction, mode, selectedPanel, reservation, selectedWorkflow);
    if (previewCreated) await interaction.editReply({ content: "プレビューを作成しました。表示された差分を確認してください。" });
  } catch (error) {
    if (reservation) await failUsageReservation(reservation);
    const message = error instanceof Error ? error.message : "処理に失敗しました。";
    await interaction.editReply({ content: message }).catch(() => undefined);
  }
}

async function handleClarificationInteraction(interaction: import("discord.js").Interaction): Promise<boolean> {
  const isOpen = interaction.isButton() && interaction.customId.startsWith("clarify:");
  const isSubmit = interaction.isModalSubmit() && interaction.customId.startsWith("clarify-submit:");
  if (!isOpen && !isSubmit) return false;
  if (!interaction.guild) {
    if (interaction.isRepliable()) await interaction.reply({ content: "確認はサーバー内で行ってください。", ephemeral: true });
    return true;
  }
  const modalInteraction = isSubmit ? interaction as ModalSubmitInteraction : null;
  if (modalInteraction) await modalInteraction.deferReply({ ephemeral: true });
  const respond = async (content: string) => {
    if (modalInteraction) await modalInteraction.editReply(content);
    else if (interaction.isRepliable()) await interaction.reply({ content, ephemeral: true });
  };
  const jobId = interaction.customId.split(":")[1];
  const [job] = await db.select().from(agentJobs).where(and(eq(agentJobs.id, jobId!), eq(agentJobs.guildId, interaction.guildId!))).limit(1);
  if (!job || job.state !== "NEEDS_INPUT") {
    await respond("この確認事項は期限切れか、すでに処理されています。");
    return true;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await respond("確認事項への回答にはサーバー管理権限が必要です。");
    return true;
  }
  if (isOpen) {
    const context = job.executionContext as { clarification?: { questions?: string[] } } | null;
    const firstQuestion = context?.clarification?.questions?.[0] ?? "不足情報を入力してください。";
    const modal = new ModalBuilder().setCustomId(`clarify-submit:${job.id}`).setTitle("Planに必要な確認");
    const answer = new TextInputBuilder().setCustomId("answers").setLabel("確認事項への回答").setPlaceholder(firstQuestion.slice(0, 100)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(answer));
    await interaction.showModal(modal);
    return true;
  }

  if (!modalInteraction) return true;

  const answer = modalInteraction.fields.getTextInputValue("answers").trim();
  if (!answer) {
    await modalInteraction.editReply("回答が空です。確認事項に回答してください。");
    return true;
  }
  const context = job.executionContext as { workflowId?: string | null; expectedWorkflowVersion?: number | null; panelId?: string | null; expectedPanelRevision?: number | null } | null;
  let selectedWorkflow: typeof interactiveWorkflows.$inferSelect | undefined;
  if (context?.workflowId) {
    const [workflow] = await db.select().from(interactiveWorkflows).where(and(eq(interactiveWorkflows.id, context.workflowId), eq(interactiveWorkflows.guildId, interaction.guildId!), eq(interactiveWorkflows.state, "ACTIVE"))).limit(1);
    if (!workflow || workflow.version !== context.expectedWorkflowVersion) {
      await modalInteraction.editReply("対象Workflowのversionが変わりました。Workflow候補から選び直して依頼してください。");
      return true;
    }
    selectedWorkflow = workflow;
  }
  let selectedPanel: typeof panels.$inferSelect | undefined;
  if (context?.panelId) {
    const [panel] = await db.select().from(panels).where(and(eq(panels.id, context.panelId), eq(panels.guildId, interaction.guildId!))).limit(1);
    if (!panel || panel.revision !== context.expectedPanelRevision) {
      await modalInteraction.editReply("対象Panelのrevisionが変わりました。Panelを選び直して依頼してください。");
      return true;
    }
    selectedPanel = panel;
  }
  const newJobId = interaction.id;
  const mode = job.mode as AgentMode;
  const instruction = `${job.instruction}\n\n確認事項への回答:\n${answer}`;
  let reservation: UsageReservation | undefined;
  try {
    const [claimed] = await db.update(agentJobs).set({ state: "ANSWERING", updatedAt: new Date() })
      .where(and(eq(agentJobs.id, job.id), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "NEEDS_INPUT"))).returning({ id: agentJobs.id });
    if (!claimed) {
      await modalInteraction.editReply("この確認事項は別の操作で処理中です。");
      return true;
    }
    reservation = await reserveUsage(interaction.guildId!, interaction.user.id, newJobId, mode, instruction);
    const created = await writePlan(modalInteraction, newJobId, instruction, mode, selectedPanel, reservation, selectedWorkflow);
    await db.update(agentJobs).set({ state: "SUPERSEDED", executionContext: { supersededBy: newJobId }, updatedAt: new Date() })
      .where(and(eq(agentJobs.id, job.id), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "ANSWERING")));
    if (created) await modalInteraction.editReply("回答を反映したプレビューを作成しました。差分を確認してください。");
  } catch (error) {
    if (reservation) await failUsageReservation(reservation);
    await db.update(agentJobs).set({ state: "NEEDS_INPUT", updatedAt: new Date() }).where(and(eq(agentJobs.id, job.id), eq(agentJobs.state, "ANSWERING")));
    await modalInteraction.editReply(error instanceof Error ? error.message : "確認後のPlan作成に失敗しました。").catch(() => undefined);
  }
  return true;
}

async function executeApproved(jobId: string, guildId: string, actor: GuildMember): Promise<string> {
  if (!actor.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error("サーバー管理の権限が必要です。");
  const leaseOwner = await claimApproval(jobId, guildId, actor.id);
  if (!leaseOwner) throw new Error("このプランは処理済み、期限切れ、または別の処理が実行中です。");
  const heartbeat = setInterval(() => {
    void db.update(agentJobs).set({ leaseExpiresAt: new Date(Date.now() + 600_000), updatedAt: new Date() })
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)))
      .catch((error) => console.error(JSON.stringify({ level: "error", event: "jobs.lease_heartbeat_failed", jobId, error: error instanceof Error ? error.message : "unknown" })));
  }, 60_000).unref();
  try {
    return await withGuildAdvisoryLock(guildId, async () => {
    const [job] = await db.select().from(agentJobs).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId))).limit(1);
    if (!job || !job.planHash || job.planHashVersion !== 2 || job.state !== "EXECUTING") throw new Error("実行対象ジョブが見つからないか、再プレビューが必要です。");
    const context = job.executionContext as { resourceWorkflow?: unknown; interactiveWorkflow?: unknown; workflowIntent?: string; workflowId?: string | null; expectedWorkflowVersion?: number | null; publishChannelId?: string; workflowSteps?: unknown; restoreBindings?: unknown } | null;
    const plan = job.plan ? panelPlanSchema.parse(job.plan) : null;
    if (approvalHash({ guildId, revision: job.revision, plan, executionContext: job.executionContext }) !== job.planHash) throw new Error("承認後にプランが変更されています。");
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("サーバーを取得できません。");
    const freshActor = await guild.members.fetch(actor.id);
    if (context?.resourceWorkflow) {
      const workflow = parseResourceWorkflowInput(context.resourceWorkflow);
      assertResourceWorkflowPermissions(guild, workflow, freshActor);
      return await executeResourceWorkflow(jobId, guildId, actor.id, guild, workflow, leaseOwner);
    }
    if (context?.interactiveWorkflow) {
      const workflow = interactiveWorkflowSchema.parse(context.interactiveWorkflow);
      if (!context.publishChannelId) throw new Error("Workflowの公開先がありません。");
      assertInteractiveWorkflowPermissions(guild, workflow, freshActor);
      await assertWorkflowVoiceBindings(guild, workflow);
      await assertWorkflowManagedRoles(guildId, guild, workflow);
      if (context.workflowIntent === "edit") {
        if (!context.workflowId || context.expectedWorkflowVersion == null) throw new Error("Workflow update target/version is missing.");
        assertInteractiveWorkflowUpdatePermission(freshActor);
        return await updateInteractiveWorkflow({ jobId, leaseOwner, guild, guildId, ownerId: actor.id, workflowId: context.workflowId, expectedVersion: context.expectedWorkflowVersion, workflow });
      }
      return await publishInteractiveWorkflow({ jobId, leaseOwner, guild, guildId, channelId: context.publishChannelId, ownerId: actor.id, workflow });
    }
    if (!plan) throw new Error("承認済みパネルPlanがありません。");
    assertPolicy(guild, freshActor, plan);
    const [existing] = plan.panelId ? await db.select().from(panels).where(and(eq(panels.id, plan.panelId), eq(panels.guildId, guildId))).limit(1) : [];
    if (plan.intent === "edit" && (!existing || !isExpectedRevision(existing.revision, plan.expectedRevision!) || !isExpectedRevision(existing.revision, job.revision!))) throw new Error("対象パネルが別の操作で更新されました。新しいプレビューを作成してください。");
    const [channel] = plan.channelId ? [await guild.channels.fetch(plan.channelId)] : [await guild.channels.fetch(existing?.channelId ?? "")];
    const targetChannel = channel ?? guild.channels.cache.find((candidate) => candidate.isSendable());
    if (!targetChannel?.isSendable()) throw new Error("パネル発行先チャンネルを取得できません。");
    const startedSteps = await db.update(agentJobSteps).set({ state: "EXECUTING", attempts: sql`${agentJobSteps.attempts} + 1`, startedAt: new Date() })
      .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "PENDING"))).returning({ id: agentJobSteps.id });
    if (!startedSteps.length) throw new Error("承認済みのAgentcord Skill stepがありません。");
    const storedOptions = existing ? await db.select().from(panelOptions).where(eq(panelOptions.panelId, existing.id)) : [];
    const restoreBindings = (job.executionContext as { restoreBindings?: { key: string; label: string; roleId: string }[] } | null)?.restoreBindings;
    const oldOptions = restoreBindings ?? storedOptions;
    const roles: { option: PanelPlan["options"][number]; role: Role; created: boolean }[] = [];
    const createdRoles: Role[] = [];
    const renamedRoles: { role: Role; oldName: string }[] = [];
    let uncertainRoleCreate = false;
    let uncertainPanelPublish = false;
    let publishedMessage: Awaited<ReturnType<typeof targetChannel.send>> | undefined;
    let existingMessage: import("discord.js").Message | undefined;
    try {
      for (const option of plan.options) {
        const previous = oldOptions.find((candidate) => candidate.key === option.key);
        let role: Role | undefined;
        let created = false;
        if (previous) {
          const owner = await db.select({ roleId: managedRoles.roleId }).from(managedRoles).where(and(eq(managedRoles.guildId, guildId), eq(managedRoles.roleId, previous.roleId))).limit(1);
          role = guild.roles.cache.get(previous.roleId) ?? await guild.roles.fetch(previous.roleId).catch(() => null) ?? undefined;
          if (!role) throw new Error(`管理対象ロールが見つかりません: ${option.roleName}`);
          assertDistributableRole(guild, role, owner[0]?.roleId, freshActor);
          if (role.name !== option.roleName) {
            renamedRoles.push({ role, oldName: role.name });
            role = await role.edit({ name: option.roleName, reason: `Autocord job ${jobId}` });
          }
        } else {
          uncertainRoleCreate = true;
          role = await guild.roles.create({ name: option.roleName, permissions: [], reason: `Autocord job ${jobId}` });
          uncertainRoleCreate = false;
          created = true;
          createdRoles.push(role);
          if (role.position >= guild.members.me!.roles.highest.position || (freshActor.id !== guild.ownerId && role.position >= freshActor.roles.highest.position)) throw new Error(`作成ロールの階層を実行者/Botより上に配置できません: ${role.name}`);
        }
        roles.push({ option, role, created });
      }
      const panelId = existing?.id ?? randomUUID();
      const nextRevision = (existing?.revision ?? 0) + 1;
      const storedPlan = stablePanelPlan(plan, panelId, nextRevision);
      if (existing) {
        existingMessage = await targetChannel.messages.fetch({ message: existing.messageId });
        const rendered = renderPanel(plan, panelId);
        await existingMessage.edit({ embeds: rendered.embeds, components: rendered.components, allowedMentions: { parse: [] } });
      } else {
        uncertainPanelPublish = true;
        publishedMessage = await targetChannel.send(renderPanel(plan, panelId));
        uncertainPanelPublish = false;
      }
      const messageId = existing?.messageId ?? publishedMessage!.id;
      await db.transaction(async (tx) => {
        if (existing) {
          const update = await tx.update(panels).set({ channelId: targetChannel.id, messageId, title: plan.title, description: plan.description, color: plan.color, revision: nextRevision, spec: storedPlan, updatedAt: new Date() }).where(and(eq(panels.id, panelId), eq(panels.guildId, guildId), eq(panels.revision, existing.revision))).returning({ id: panels.id });
          if (update.length !== 1) throw new Error("revision競合を検出しました。");
        } else {
          await tx.insert(panels).values({ id: panelId, guildId, channelId: targetChannel.id, messageId, title: plan.title, description: plan.description, color: plan.color, revision: nextRevision, spec: storedPlan });
        }
        await tx.delete(panelOptions).where(eq(panelOptions.panelId, panelId));
        if (roles.length) await tx.insert(panelOptions).values(roles.map(({ option, role }) => ({ id: randomUUID(), panelId, key: option.key, label: option.label, roleId: role.id })));
        for (const { role, created } of roles) if (created) await tx.insert(managedRoles).values({ guildId, roleId: role.id, ownerJobId: jobId });
        await tx.insert(panelRevisions).values({ id: randomUUID(), panelId, guildId, jobId, revision: nextRevision, beforeSpec: existing?.spec ?? null, afterSpec: storedPlan, beforeBindings: storedOptions.map(({ key, label, roleId }) => ({ key, label, roleId })), afterBindings: roles.map(({ option, role }) => ({ key: option.key, label: option.label, roleId: role.id })) });
        const completed = await tx.update(agentJobs).set({ state: "COMPLETED", leaseExpiresAt: null, updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner))).returning({ id: agentJobs.id });
        if (completed.length !== 1) throw new Error("実行リースが失効しました。");
        await tx.update(agentJobSteps).set({ state: "COMPLETED", result: { panelId, messageId, revision: nextRevision }, completedAt: new Date() })
          .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "EXECUTING")));
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId: actor.id, action: existing ? "panel.edited" : "panel.created", outcome: "success", detail: { panelId, revision: nextRevision, messageId } });
      });
      return `パネル「${plan.title}」を${existing ? "更新" : "作成"}しました。revision ${nextRevision}`;
    } catch (error) {
      let compensationFailed = uncertainRoleCreate || uncertainPanelPublish;
      if (existingMessage && existing) {
        try {
          const rendered = renderPanel(panelPlanSchema.parse(existing.spec), existing.id);
          await existingMessage.edit({ embeds: rendered.embeds, components: rendered.components, allowedMentions: { parse: [] } });
        }
        catch { compensationFailed = true; }
      }
      if (publishedMessage) {
        try { await publishedMessage.delete(); }
        catch { compensationFailed = true; }
      }
      for (const { role, oldName } of renamedRoles.reverse()) {
        try { await role.edit({ name: oldName, reason: `Autocord compensation for ${jobId}` }); }
        catch { compensationFailed = true; }
      }
      for (const role of createdRoles.reverse()) {
        try { await role.delete(`Autocord compensation for ${jobId}`); }
        catch { compensationFailed = true; }
      }
      const state = compensationFailed ? "RECOVERY_REQUIRED" : "FAILED";
      await db.update(agentJobSteps).set({ state, errorDetail: { message: error instanceof Error ? error.message : "unknown", compensationFailed }, completedAt: new Date() })
        .where(and(eq(agentJobSteps.jobId, jobId), inArray(agentJobSteps.state, ["PENDING", "EXECUTING"])));
      await db.update(agentJobs).set({ state, leaseExpiresAt: null, errorDetail: { message: error instanceof Error ? error.message : "unknown", compensationFailed }, updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)));
      await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId: actor.id, action: "panel.execute", outcome: compensationFailed ? "recovery_required" : "compensated", detail: { message: error instanceof Error ? error.message : "unknown" } });
      throw error;
    }
    });
  } catch (error) {
    await db.update(agentJobs).set({ state: "FAILED", leaseExpiresAt: null, errorDetail: { message: error instanceof Error ? error.message : "unknown" }, updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)));
    await db.update(agentJobSteps).set({ state: "FAILED", errorDetail: { message: error instanceof Error ? error.message : "unknown" }, completedAt: new Date() })
      .where(and(eq(agentJobSteps.jobId, jobId), inArray(agentJobSteps.state, ["PENDING", "EXECUTING"])));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function executeResourceWorkflow(jobId: string, guildId: string, actorId: string, guild: import("discord.js").Guild, workflow: import("./agent/workflow.js").ResourceWorkflow, leaseOwner: string): Promise<string> {
  const steps = orderResourceSteps(workflow.steps);
  const outputs = new Map<string, { id: string; kind: "role" | "category" | "text_channel" }>();
  const created: { stepId: string; id: string; kind: "role" | "category" | "text_channel"; name: string }[] = [];
  let activeStepId: string | null = null;
  let externalOperationUncertain = false;

  try {
    for (const step of steps) {
      const [started] = await db.update(agentJobSteps).set({ state: "EXECUTING", attempts: sql`${agentJobSteps.attempts} + 1`, startedAt: new Date(), errorDetail: null })
        .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, step.id), eq(agentJobSteps.state, "PENDING"))).returning({ id: agentJobSteps.id });
      if (!started) throw new Error(`Workflow step is not pending: ${step.id}`);
      activeStepId = step.id;
      let result: { id: string; kind: "role" | "category" | "text_channel"; name: string };

      if (step.action === "role.create") {
        externalOperationUncertain = true;
        const role = await guild.roles.create({ name: step.name, permissions: [], reason: `Autocord job ${jobId}, step ${step.id}` });
        externalOperationUncertain = false;
        result = { id: role.id, kind: "role", name: role.name };
        created.push({ stepId: step.id, ...result });
        const actor = await guild.members.fetch(actorId);
        if (!guild.members.me || role.position >= guild.members.me.roles.highest.position || (actor.id !== guild.ownerId && role.position >= actor.roles.highest.position)) {
          throw new Error(`作成ロールの階層を実行者/Botより上に配置できません: ${role.name}`);
        }
      } else {
        const parentId = step.action === "channel.create_text" && step.categoryStepId ? outputs.get(step.categoryStepId)?.id : undefined;
        if (step.action === "channel.create_text" && step.categoryStepId && !parentId) throw new Error(`親カテゴリの出力を解決できません: ${step.categoryStepId}`);
        externalOperationUncertain = true;
        const channel = step.action === "channel.create_category"
          ? await guild.channels.create({ name: step.name, type: ChannelType.GuildCategory, reason: `Autocord job ${jobId}, step ${step.id}` })
          : await guild.channels.create({ name: step.name, type: ChannelType.GuildText, ...(step.topic ? { topic: step.topic } : {}), ...(parentId ? { parent: parentId } : {}), reason: `Autocord job ${jobId}, step ${step.id}` });
        externalOperationUncertain = false;
        result = { id: channel.id, kind: step.action === "channel.create_category" ? "category" : "text_channel", name: channel.name };
        created.push({ stepId: step.id, ...result });
      }

      externalOperationUncertain = true;
      await db.transaction(async (tx) => {
        if (result.kind === "role") await tx.insert(managedRoles).values({ guildId, roleId: result.id, ownerJobId: jobId });
        else await tx.insert(managedChannels).values({ guildId, channelId: result.id, ownerJobId: jobId, kind: result.kind });
        const completed = await tx.update(agentJobSteps).set({ state: "COMPLETED", result, completedAt: new Date(), errorDetail: null })
          .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, step.id), eq(agentJobSteps.state, "EXECUTING"))).returning({ id: agentJobSteps.id });
        if (!completed.length) throw new Error(`Workflow step state changed during execution: ${step.id}`);
        await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId, action: step.action, outcome: "success", detail: { stepId: step.id, resourceId: result.id, name: result.name } });
      });
      externalOperationUncertain = false;
      outputs.set(step.id, { id: result.id, kind: result.kind });
      activeStepId = null;
    }

    await db.transaction(async (tx) => {
      const completed = await tx.update(agentJobs).set({ state: "COMPLETED", leaseExpiresAt: null, updatedAt: new Date() })
        .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner))).returning({ id: agentJobs.id });
      if (!completed.length) throw new Error("実行リースが失効しました。");
      await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId, action: "resource.workflow.completed", outcome: "success", detail: { resources: created } });
    });
    return `リソースを${created.length}件作成しました: ${created.map(({ kind, name }) => `${kind}「${name}」`).join("、")}`;
  } catch (error) {
    const recoveryRequired = externalOperationUncertain || created.length > 0;
    if (activeStepId) {
      await db.update(agentJobSteps).set({ state: recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED", errorDetail: { message: error instanceof Error ? error.message : "unknown" }, completedAt: new Date() })
        .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.stepId, activeStepId), eq(agentJobSteps.state, "EXECUTING")));
    }
    await db.update(agentJobSteps).set({ state: "BLOCKED", errorDetail: { reason: `workflow halted at ${activeStepId ?? "unknown step"}` } })
      .where(and(eq(agentJobSteps.jobId, jobId), eq(agentJobSteps.state, "PENDING")));
    const state = recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED";
    await db.update(agentJobs).set({ state, leaseExpiresAt: null, errorDetail: { message: error instanceof Error ? error.message : "unknown", createdResources: created }, updatedAt: new Date() })
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)));
    await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId, action: "resource.workflow.failed", outcome: recoveryRequired ? "recovery_required" : "failed", detail: { failedStepId: activeStepId, createdResources: created, error: error instanceof Error ? error.message : "unknown" } });
    throw error;
  }
}

async function prepareUndo(interaction: ChatInputCommandInteraction, targetJobId: string): Promise<string> {
  const [revision] = await db.select().from(panelRevisions).where(and(eq(panelRevisions.jobId, targetJobId), eq(panelRevisions.guildId, interaction.guildId!))).limit(1);
  if (!revision?.beforeSpec) throw new Error("この操作は安全にUndoできる変更履歴がありません。");
  const [panel] = await db.select().from(panels).where(and(eq(panels.id, revision.panelId), eq(panels.guildId, interaction.guildId!))).limit(1);
  if (!panel || panel.revision !== revision.revision) throw new Error("対象パネルに後続変更があります。最新状態を確認してください。");
  const previous = panelPlanSchema.parse(revision.beforeSpec);
  const plan = stablePanelPlan(previous, panel.id, panel.revision);
  const jobId = randomUUID();
  const restoreBindings = revision.beforeBindings as { key: string; label: string; roleId: string }[] | null;
  const executionContext = { restoreBindings: restoreBindings ?? [] };
  const planHash = approvalHash({ guildId: interaction.guildId!, revision: panel.revision, plan, executionContext });
  await db.transaction(async (tx) => {
    await tx.insert(agentJobs).values({ id: jobId, guildId: interaction.guildId!, requesterId: interaction.user.id, state: "AWAITING_APPROVAL", mode: "mini", idempotencyKey: jobId, instruction: `Undo job ${targetJobId}`, plan, planHash, planHashVersion: 2, revision: panel.revision, executionContext, expiresAt: new Date(Date.now() + 600_000) });
    await tx.insert(agentJobSteps).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, stepId: "undo-panel", sequence: 0, skillId: "panel.edit", state: "PENDING", input: { targetJobId, panelId: panel.id, revision: panel.revision } });
    await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "panel.undo.requested", outcome: "pending_approval", detail: { targetJobId, panelId: panel.id, revision: panel.revision } });
  });
  await interaction.followUp({ ...preview(plan, jobId, panelPlanSchema.parse(panel.spec)), ephemeral: true });
  return "Undoプレビューを作成しました。差分を確認して承認してください。";
}

async function handlePanelComponent(interaction: import("discord.js").StringSelectMenuInteraction | import("discord.js").ButtonInteraction): Promise<void> {
  if (!interaction.guild) return void await interaction.reply({ content: "サーバー内で操作してください。", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const [kind, panelId, key] = interaction.customId.split(":");
  const [panel] = await db.select().from(panels).where(and(eq(panels.id, panelId!), eq(panels.guildId, interaction.guildId!))).limit(1);
  if (!panel) return void await interaction.editReply("このパネルは利用できません。");
  const bindings = await db.select().from(panelOptions).where(eq(panelOptions.panelId, panel.id));
  const chosenKeys = kind === "rolepanel" && interaction.isStringSelectMenu()
    ? new Set(interaction.values.map((value) => bindings.find((binding) => binding.key === value || binding.roleId === value)?.key).filter((value): value is string => Boolean(value)))
    : new Set([key!]);
  const currentSpec = panelPlanSchema.parse(panel.spec);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const initialRoleIds = new Set(member.roles.cache.keys());
  const changed: { role: Role; added: boolean }[] = [];
  const operationId = randomUUID();
  try {
    for (const binding of bindings) {
      const role = interaction.guild.roles.cache.get(binding.roleId) ?? await interaction.guild.roles.fetch(binding.roleId).catch(() => null);
      if (!role) continue;
      const owner = await db.select({ roleId: managedRoles.roleId }).from(managedRoles).where(and(eq(managedRoles.guildId, interaction.guildId!), eq(managedRoles.roleId, role.id))).limit(1);
      assertDistributableRole(interaction.guild, role, owner[0]?.roleId, await interaction.guild.members.fetch(client.user!.id));
      const hasRole = member.roles.cache.has(role.id);
      if (kind === "rolebutton" && binding.key === key) {
        const skillId = hasRole ? "role.revoke" : "role.assign";
        parseSkillInput(skillId, { panelId: panel.id, key: binding.key });
        assertSkillPermissions(skillId, member);
        if (hasRole) { await member.roles.remove(role, `Autocord panel ${panel.id}`); changed.push({ role, added: false }); }
        else { await member.roles.add(role, `Autocord panel ${panel.id}`); changed.push({ role, added: true }); }
      } else if (kind === "rolepanel") {
        const shouldHave = chosenKeys.has(binding.key);
        if (shouldHave !== hasRole) {
          const skillId = shouldHave ? "role.assign" : "role.revoke";
          parseSkillInput(skillId, { panelId: panel.id, key: binding.key });
          assertSkillPermissions(skillId, member);
          if (shouldHave) { await member.roles.add(role, `Autocord panel ${panel.id}`); changed.push({ role, added: true }); }
          else { await member.roles.remove(role, `Autocord panel ${panel.id}`); changed.push({ role, added: false }); }
        }
      }
    }
    if (kind === "rolebutton" && currentSpec.selectionMode === "single" && chosenKeys.size) {
      for (const binding of bindings.filter((item) => item.key !== key)) {
        const role = interaction.guild.roles.cache.get(binding.roleId);
        if (role?.id && member.roles.cache.has(role.id)) {
          parseSkillInput("role.revoke", { panelId: panel.id, key: binding.key });
          assertSkillPermissions("role.revoke", member);
          await member.roles.remove(role, `Autocord single-choice panel ${panel.id}`);
          changed.push({ role, added: false });
        }
      }
    }
    await db.insert(auditEvents).values({ id: randomUUID(), jobId: operationId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "panel.member_roles", outcome: "success", detail: { panelId: panel.id, changed: changed.map(({ role, added }) => ({ roleId: role.id, added })) } });
    await interaction.editReply("ロールを更新しました。");
  } catch (error) {
    let compensationFailed = false;
    const refreshedMember = await interaction.guild.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
    if (!refreshedMember) compensationFailed = true;
    for (const binding of bindings) {
      const role = interaction.guild.roles.cache.get(binding.roleId);
      if (!role || !refreshedMember) continue;
      const shouldHave = initialRoleIds.has(role.id);
      const currentlyHas = refreshedMember.roles.cache.has(role.id);
      if (shouldHave !== currentlyHas) {
        await refreshedMember.roles[shouldHave ? "add" : "remove"](role, `Autocord compensation for panel ${panel.id}`).catch(() => { compensationFailed = true; });
      }
    }
    await db.insert(auditEvents).values({ id: randomUUID(), jobId: operationId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "panel.member_roles", outcome: compensationFailed ? "recovery_required" : "compensated", detail: { panelId: panel.id, changed: changed.map(({ role, added }) => ({ roleId: role.id, added })) } });
    throw error;
  }
}

async function drawGiveaway(giveawayId: string): Promise<void> {
  await withGuildAdvisoryLock(`giveaway:${giveawayId}`, async () => {
    const [giveaway] = await db.update(giveaways).set({ state: "DRAWING" }).where(and(eq(giveaways.id, giveawayId), eq(giveaways.state, "ACTIVE"), sql`${giveaways.endsAt} <= now()`)).returning();
    if (!giveaway) return;
    const entries = await db.select({ userId: giveawayEntries.userId }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, giveawayId));
    const poolUsers = entries.map((entry) => entry.userId);
    const winners = drawWinners(poolUsers, giveaway.winnerCount);
    await db.transaction(async (tx) => {
      const completed = await tx.update(giveaways).set({ state: "COMPLETED", winners }).where(and(eq(giveaways.id, giveawayId), eq(giveaways.state, "DRAWING"))).returning({ id: giveaways.id });
      if (!completed.length) return;
      await tx.insert(auditEvents).values({ id: randomUUID(), jobId: giveawayId, guildId: giveaway.guildId, actorId: giveaway.hostId, action: "giveaway.draw", outcome: "success", detail: { entryCount: entries.length, winners } });
      await tx.insert(giveawayNotifications).values({
        id: randomUUID(), giveawayId, guildId: giveaway.guildId, channelId: giveaway.channelId,
        content: giveawayResultMessage(giveaway.prize, winners), allowedUsers: winners,
      });
    });
  });
}

async function dispatchGiveawayNotifications(): Promise<void> {
  const now = new Date();
  const due = await db.select().from(giveawayNotifications).where(or(
    and(eq(giveawayNotifications.state, "PENDING"), lte(giveawayNotifications.availableAt, now)),
    and(eq(giveawayNotifications.state, "SENDING"), sql`${giveawayNotifications.leaseExpiresAt} < ${now}`),
  )).orderBy(giveawayNotifications.createdAt).limit(20);

  for (const row of due) {
    const owner = randomUUID();
    const [claimed] = await db.update(giveawayNotifications).set({
      state: "SENDING", leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 120_000), attempts: sql`${giveawayNotifications.attempts} + 1`,
    }).where(and(eq(giveawayNotifications.id, row.id), or(
      and(eq(giveawayNotifications.state, "PENDING"), lte(giveawayNotifications.availableAt, new Date())),
      and(eq(giveawayNotifications.state, "SENDING"), sql`${giveawayNotifications.leaseExpiresAt} < now()`),
    ))).returning();
    if (!claimed) continue;

    try {
      const guild = client.guilds.cache.get(claimed.guildId) ?? await client.guilds.fetch(claimed.guildId);
      const channel = await guild.channels.fetch(claimed.channelId);
      if (!channel?.isSendable()) throw new Error("Giveaway通知チャンネルを利用できません。");
      const allowedUsers = Array.isArray(claimed.allowedUsers) ? claimed.allowedUsers.filter((user): user is string => typeof user === "string") : [];
      await channel.send({ content: claimed.content, allowedMentions: { parse: [], users: allowedUsers } });
      await db.update(giveawayNotifications).set({ state: "SENT", sentAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null })
        .where(and(eq(giveawayNotifications.id, claimed.id), eq(giveawayNotifications.state, "SENDING"), eq(giveawayNotifications.leaseOwner, owner)));
    } catch (error) {
      const retryAt = new Date(Date.now() + giveawayNotificationRetryDelayMs(claimed.attempts));
      const lastError = error instanceof Error ? error.message.slice(0, 500) : "unknown notification delivery failure";
      await db.update(giveawayNotifications).set({ state: "PENDING", availableAt: retryAt, leaseOwner: null, leaseExpiresAt: null, lastError })
        .where(and(eq(giveawayNotifications.id, claimed.id), eq(giveawayNotifications.state, "SENDING"), eq(giveawayNotifications.leaseOwner, owner)));
      console.error(JSON.stringify({ level: "error", event: "giveaway.notification_retry", notificationId: claimed.id, attempts: claimed.attempts, retryAt, error: lastError }));
    }
  }
}

async function recoverInterruptedDraws(): Promise<number> {
  const pending = await db.select({ id: giveaways.id }).from(giveaways).where(eq(giveaways.state, "DRAWING"));
  let recovered = 0;
  for (const row of pending) {
    await withGuildAdvisoryLock(`giveaway:${row.id}`, async () => {
      const result = await db.update(giveaways).set({ state: "ACTIVE" }).where(and(eq(giveaways.id, row.id), eq(giveaways.state, "DRAWING"))).returning({ id: giveaways.id });
      recovered += result.length;
    });
  }
  return recovered;
}

async function handleWorkflowAutocomplete(interaction: import("discord.js").AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== "agent" || interaction.options.getFocused(true).name !== "workflow_id" || !interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.respond([]);
    return;
  }
  const query = interaction.options.getFocused().trim();
  const rows = await db.select({ id: interactiveWorkflows.id, name: interactiveWorkflows.name, version: interactiveWorkflows.version }).from(interactiveWorkflows)
    .where(and(eq(interactiveWorkflows.guildId, interaction.guildId), eq(interactiveWorkflows.state, "ACTIVE"), or(ilike(interactiveWorkflows.name, `%${query}%`), ilike(interactiveWorkflows.id, `%${query}%`))))
    .orderBy(sql`${interactiveWorkflows.updatedAt} desc`).limit(25);
  await interaction.respond(rows.map((workflow) => ({ name: `${workflow.name} (v${workflow.version})`.slice(0, 100), value: workflow.id })));
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleWorkflowAutocomplete(interaction);
    if (await handleClarificationInteraction(interaction)) return;
    if (await handleInteractiveWorkflowInteraction(interaction)) return;
    if (interaction.isChatInputCommand() && interaction.commandName === "agent") return await handleAgent(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === "autocord") {
      if (!interaction.guild) return void await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "status") {
        const jobId = interaction.options.getString("job_id", true);
        parseSkillInput("job.status", { jobId });
        const [job] = await db.select().from(agentJobs).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!))).limit(1);
        if (!job || job.requesterId !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error("ジョブが見つからないか、参照権限がありません。");
        const steps = await db.select().from(agentJobSteps).where(eq(agentJobSteps.jobId, job.id)).orderBy(agentJobSteps.sequence).limit(8);
        const stepText = steps.length ? `\n${steps.map((step) => `• ${step.sequence + 1}. ${step.skillId}: ${step.state}`).join("\n")}` : "";
        return void await interaction.editReply(`Job ${job.id}: ${job.state} / ${job.mode}${stepText}`);
      }
      const commandSkill: Record<string, AgentSkillId> = {
        skills: "skills.list",
        workflows: "workflow.list",
        panels: "panel.list", roles: "role.list", channels: "channel.list", usage: "usage.read",
        settings: "settings.read", history: "audit.list", undo: "panel.undo",
      };
      const skillId = commandSkill[subcommand];
      if (!skillId) throw new Error("未対応のAutocord Skillです。");
      assertSkillPermissions(skillId, member);
      if (subcommand === "skills") {
        parseSkillInput("skills.list", {});
        const skills = listAgentSkills().map((skill) => `• ${skill.id} — ${skill.risk}${skill.approvalRequired ? " / 承認" : ""}`);
        return void await interaction.editReply(`**Agentcord Skills (${skills.length})**\n${skills.join("\n")}`);
      }
      if (subcommand === "workflows") {
        parseSkillInput("workflow.list", {});
        const rows = await db.select({ id: interactiveWorkflows.id, name: interactiveWorkflows.name, version: interactiveWorkflows.version, channelId: interactiveWorkflows.channelId, messageId: interactiveWorkflows.messageId })
          .from(interactiveWorkflows).where(and(eq(interactiveWorkflows.guildId, interaction.guildId!), eq(interactiveWorkflows.state, "ACTIVE"))).orderBy(sql`${interactiveWorkflows.createdAt} desc`).limit(25);
        return void await interaction.editReply(rows.length ? rows.map((workflow) => `• ${workflow.name} (v${workflow.version}, ID: ${workflow.id}, channel: ${workflow.channelId}, message: ${workflow.messageId})`).join("\n") : "Interactive Workflowはありません。");
      }
      if (subcommand === "undo") {
        const input = parseSkillInput("panel.undo", { id: interaction.options.getString("job_id", true) }) as { id: string };
        const message = await prepareUndo(interaction, input.id);
        return void await interaction.editReply(message);
      }
      if (subcommand === "panels") {
        parseSkillInput("panel.list", {});
        const rows = await db.select().from(panels).where(eq(panels.guildId, interaction.guildId!)).orderBy(sql`${panels.updatedAt} desc`).limit(25);
        return void await interaction.editReply(rows.length ? rows.map((panel) => `• ${panel.title} (ID: ${panel.id}, revision ${panel.revision})`).join("\n") : "このサーバーにパネルはありません。");
      }
      if (subcommand === "roles") {
        parseSkillInput("role.list", {});
        const rows = await db.select({ roleId: managedRoles.roleId }).from(managedRoles).where(eq(managedRoles.guildId, interaction.guildId!)).limit(25);
        const names = await Promise.all(rows.map(async ({ roleId }) => (await interaction.guild!.roles.fetch(roleId).catch(() => null))?.name ?? `削除済み (${roleId})`));
        return void await interaction.editReply(names.length ? names.map((name) => `• ${name}`).join("\n") : "Autocord管理ロールはありません。");
      }
      if (subcommand === "channels") {
        parseSkillInput("channel.list", {});
        const channelList = [...(await interaction.guild.channels.fetch()).values()].flatMap((channel) => { const line = displaySendableChannel(channel); return line ? [line] : []; }).slice(0, 25);
        return void await interaction.editReply(channelList.length ? channelList.join("\n") : "利用可能なチャンネルはありません。");
      }
      if (subcommand === "usage") {
        parseSkillInput("usage.read", {});
        const period = new Date().toISOString().slice(0, 7);
        const rows = await db.select({ mode: usageRecords.mode, count: sql<number>`count(*)::int`, input: sql<number>`sum(${usageRecords.inputTokens})::int`, output: sql<number>`sum(${usageRecords.outputTokens})::int`, cost: sql<string>`sum(${usageRecords.estimatedCostUsd}::numeric)::text` }).from(usageRecords).where(and(eq(usageRecords.guildId, interaction.guildId!), eq(usageRecords.period, period))).groupBy(usageRecords.mode);
        return void await interaction.editReply(rows.length ? rows.map((row) => `${row.mode}: ${row.count}回 / 入力${row.input ?? 0}・出力${row.output ?? 0} tokens / 推定$${row.cost ?? "0"}`).join("\n") : "今月の利用はありません。");
      }
      if (subcommand === "settings") {
        const mini = interaction.options.getInteger("mini_monthly");
        const max = interaction.options.getInteger("max_monthly");
        if (mini !== null || max !== null) {
          assertSkillPermissions("settings.update", member);
          const settingsInput = parseSkillInput("settings.update", { miniMonthly: mini, maxMonthly: max }) as { miniMonthly: number | null; maxMonthly: number | null };
          const serviceMiniCap = Number(process.env.MINI_MONTHLY_LIMIT ?? 30);
          const serviceMaxCap = Number(process.env.MAX_MONTHLY_LIMIT ?? 5);
          if (settingsInput.miniMonthly !== null && serviceMiniCap > 0 && settingsInput.miniMonthly > serviceMiniCap || settingsInput.maxMonthly !== null && serviceMaxCap > 0 && settingsInput.maxMonthly > serviceMaxCap) throw new Error("設定値はサービス上限を超えられません。");
          await db.insert(guildSettings).values({ guildId: interaction.guildId!, miniMonthlyLimit: settingsInput.miniMonthly ?? serviceMiniCap, maxMonthlyLimit: settingsInput.maxMonthly ?? serviceMaxCap, updatedAt: new Date() }).onConflictDoUpdate({ target: guildSettings.guildId, set: { ...(settingsInput.miniMonthly !== null ? { miniMonthlyLimit: settingsInput.miniMonthly } : {}), ...(settingsInput.maxMonthly !== null ? { maxMonthlyLimit: settingsInput.maxMonthly } : {}), updatedAt: new Date() } });
        }
        parseSkillInput("settings.read", {});
        await db.insert(guildSettings).values({ guildId: interaction.guildId!, miniMonthlyLimit: Number(process.env.MINI_MONTHLY_LIMIT ?? 30), maxMonthlyLimit: Number(process.env.MAX_MONTHLY_LIMIT ?? 5) }).onConflictDoNothing();
        const [settings] = await db.select().from(guildSettings).where(eq(guildSettings.guildId, interaction.guildId!)).limit(1);
        const miniLimit = settings!.miniMonthlyLimit > 0 ? `${settings!.miniMonthlyLimit}回` : "無制限";
        const maxLimit = settings!.maxMonthlyLimit > 0 ? `${settings!.maxMonthlyLimit}回` : "無制限";
        return void await interaction.editReply(`月間上限: Mini ${miniLimit} / Max ${maxLimit}\n同時ジョブ上限: ${Number(process.env.MAX_CONCURRENT_JOBS_PER_GUILD ?? 1)}件`);
      }
      parseSkillInput("audit.list", {});
      const rows = await db.select().from(auditEvents).where(eq(auditEvents.guildId, interaction.guildId!)).orderBy(sql`${auditEvents.createdAt} desc`).limit(10);
      return void await interaction.editReply(rows.length ? rows.map((row) => `${row.createdAt.toISOString()} ${row.action} ${row.outcome} job:${row.jobId}`).join("\n") : "操作履歴はありません。");
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "giveaway") {
      if (!interaction.guild || !interaction.channel?.isSendable()) return void await interaction.reply({ content: "サーバーのテキストチャンネルで実行してください。", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      const subcommand = interaction.options.getSubcommand();
      const giveawayId = interaction.options.getString("giveaway_id");
      const giveawaySkill: Record<string, AgentSkillId> = { create: "giveaway.create", end: "giveaway.end", reroll: "giveaway.reroll", pause: "giveaway.pause", resume: "giveaway.resume" };
      const skillId = giveawaySkill[subcommand];
      if (!skillId) throw new Error("未対応のGiveaway Skillです。");
      assertSkillPermissions(skillId, actor);
      if (subcommand === "end") {
        parseSkillInput("giveaway.end", { giveawayId });
        const [updated] = await db.update(giveaways).set({ endsAt: new Date() }).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "ACTIVE"))).returning({ id: giveaways.id });
        if (!updated) return void await interaction.editReply("開催中の企画が見つかりません。");
        await drawGiveaway(updated.id);
        return void await interaction.editReply("企画を終了して抽選しました。");
      }
      if (subcommand === "pause") {
        parseSkillInput("giveaway.pause", { giveawayId });
        const [paused] = await db.update(giveaways).set({ state: "PAUSED", remainingSeconds: sql`GREATEST(0, floor(extract(epoch from ${giveaways.endsAt} - now())))::int` }).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "ACTIVE"))).returning({ id: giveaways.id });
        if (!paused) return void await interaction.editReply("開催中の企画が見つかりません。");
        await db.insert(auditEvents).values({ id: randomUUID(), jobId: paused.id, guildId: interaction.guildId!, actorId: interaction.user.id, action: "giveaway.paused", outcome: "success" });
        return void await interaction.editReply("企画を一時停止しました。");
      }
      if (subcommand === "resume") {
        parseSkillInput("giveaway.resume", { giveawayId });
        const [paused] = await db.select().from(giveaways).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "PAUSED"))).limit(1);
        if (!paused) return void await interaction.editReply("一時停止中の企画が見つかりません。");
        const remaining = Math.max(1, paused.remainingSeconds ?? 1);
        const [resumed] = await db.update(giveaways).set({ state: "ACTIVE", endsAt: new Date(Date.now() + remaining * 1000), remainingSeconds: null }).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "PAUSED"))).returning({ id: giveaways.id });
        if (resumed) await db.insert(auditEvents).values({ id: randomUUID(), jobId: resumed.id, guildId: interaction.guildId!, actorId: interaction.user.id, action: "giveaway.resumed", outcome: "success" });
        return void await interaction.editReply(resumed ? "企画を再開しました。" : "企画状態が変わりました。再確認してください。");
      }
      if (subcommand === "reroll") {
        parseSkillInput("giveaway.reroll", { giveawayId });
        await withGuildAdvisoryLock(`giveaway:${giveawayId}`, async () => {
          const [entry] = await db.select().from(giveaways).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "COMPLETED"))).limit(1);
          if (!entry) throw new Error("終了済み企画が見つかりません。");
          const entries = await db.select({ userId: giveawayEntries.userId }).from(giveawayEntries).where(eq(giveawayEntries.giveawayId, entry.id));
          const previousWinners = new Set((entry.winners as string[] | null) ?? []);
          const candidates = entries.map((row) => row.userId).filter((userId) => !previousWinners.has(userId));
          const winners = drawWinners(candidates, entry.winnerCount);
          await db.transaction(async (tx) => {
            const updated = await tx.update(giveaways).set({ winners }).where(and(eq(giveaways.id, entry.id), eq(giveaways.state, "COMPLETED"))).returning({ id: giveaways.id });
            if (!updated.length) throw new Error("企画状態が変わりました。再度確認してください。");
            await tx.insert(auditEvents).values({ id: randomUUID(), jobId: entry.id, guildId: entry.guildId, actorId: interaction.user.id, action: "giveaway.reroll", outcome: "success", detail: { previousWinners: [...previousWinners], winners } });
            await tx.insert(giveawayNotifications).values({
              id: randomUUID(), giveawayId: entry.id, guildId: entry.guildId, channelId: entry.channelId,
              content: giveawayResultMessage(entry.prize, winners, true), allowedUsers: winners,
            });
          });
        });
        return void await interaction.editReply("再抽選を完了しました。");
      }
      const prize = interaction.options.getString("prize", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const winnerCount = interaction.options.getInteger("winners", true);
      const giveawayInput = parseSkillInput("giveaway.create", { prize, minutes, winners: winnerCount }) as { prize: string; minutes: number; winners: number };
      const id = randomUUID();
      const endsAt = new Date(Date.now() + giveawayInput.minutes * 60_000);
      const message = await interaction.channel.send({ content: `🎁 **${giveawayInput.prize}**\n当選者: ${giveawayInput.winners}人\n終了: <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n参加するにはボタンを押してください。`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`giveaway:${id}`).setLabel("参加").setStyle(ButtonStyle.Primary))] });
      try {
        await db.insert(giveaways).values({ id, guildId: interaction.guildId!, channelId: interaction.channelId!, messageId: message.id, hostId: interaction.user.id, prize: giveawayInput.prize, winnerCount: giveawayInput.winners, state: "ACTIVE", endsAt });
      } catch (error) {
        await message.delete().catch(() => undefined);
        throw error;
      }
      return void await interaction.editReply(`配布企画を開始しました（ID: ${id}）。`);
    }
    if (interaction.isButton() && interaction.customId.startsWith("giveaway:")) {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.customId.slice("giveaway:".length);
      const [giveaway] = await db.select().from(giveaways).where(and(eq(giveaways.id, id), eq(giveaways.guildId, interaction.guildId ?? ""), eq(giveaways.state, "ACTIVE"), gt(giveaways.endsAt, new Date()))).limit(1);
      if (!giveaway) return void await interaction.editReply("この企画は終了しています。");
      const existing = await db.select().from(giveawayEntries).where(and(eq(giveawayEntries.giveawayId, id), eq(giveawayEntries.userId, interaction.user.id))).limit(1);
      const skillId = existing.length ? "giveaway.leave" : "giveaway.join";
      parseSkillInput(skillId, { giveawayId: id });
      assertSkillPermissions(skillId, await interaction.guild!.members.fetch(interaction.user.id));
      if (existing.length) await db.delete(giveawayEntries).where(and(eq(giveawayEntries.giveawayId, id), eq(giveawayEntries.userId, interaction.user.id)));
      else await db.insert(giveawayEntries).values({ giveawayId: id, userId: interaction.user.id }).onConflictDoNothing();
      return void await interaction.editReply(existing.length ? "参加を取り消しました。" : "企画に参加しました。");
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("target:")) {
      if (!interaction.guild) return void await interaction.reply({ content: "サーバー内で操作してください。", ephemeral: true });
      await interaction.deferUpdate();
      requireAdmin(await interaction.guild.members.fetch(interaction.user.id));
      const jobId = interaction.customId.slice("target:".length);
      const claimed = await db.update(agentJobs).set({ state: "PLANNING", updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "AWAITING_PANEL_SELECTION"), gt(agentJobs.expiresAt, new Date()))).returning();
      if (!claimed.length) return void await interaction.followUp({ content: "この選択は期限切れ、または処理済みです。", ephemeral: true });
      const panelId = interaction.values[0]!;
      const [panel] = await db.select().from(panels).where(and(eq(panels.id, panelId), eq(panels.guildId, interaction.guildId!))).limit(1);
      if (!panel) {
        await db.update(agentJobs).set({ state: "FAILED", errorDetail: { reason: "selected panel not found in guild" }, updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!)));
        const [reservation] = await db.select({ id: usageRecords.id, period: usageRecords.period }).from(usageRecords).where(eq(usageRecords.jobId, jobId)).limit(1);
        if (reservation) await failUsageReservation(reservation);
        return void await interaction.followUp({ content: "選択されたパネルが見つかりません。", ephemeral: true });
      }
      const [job] = claimed;
      const reservationRows = await db.select().from(usageRecords).where(eq(usageRecords.jobId, jobId)).limit(1);
      const reservation = reservationRows[0] ? { id: reservationRows[0].id, period: reservationRows[0].period } : undefined;
      const previewCreated = await writePlan(interaction, jobId, job!.instruction, job!.mode as AgentMode, panel, reservation);
      if (previewCreated) return void await interaction.followUp({ content: "編集プレビューを作成しました。差分を確認してください。", ephemeral: true });
      return;
    }
    if (interaction.isButton() && (interaction.customId.startsWith("approve:") || interaction.customId.startsWith("deny:"))) {
      if (!interaction.guild) return void await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const approver = await interaction.guild.members.fetch(interaction.user.id);
      if (!approver.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error("サーバー管理の権限が必要です。");
      const [action, jobId] = interaction.customId.split(":");
      if (action === "deny") {
        const denied = await db.update(agentJobs).set({ state: "DENIED", approvalActorId: interaction.user.id, decisionAt: new Date(), updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId!), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "AWAITING_APPROVAL"))).returning({ id: agentJobs.id });
        if (denied.length) await db.insert(auditEvents).values({ id: randomUUID(), jobId: jobId!, guildId: interaction.guildId!, actorId: interaction.user.id, action: "plan.denied", outcome: "success" });
        return void await interaction.editReply(denied.length ? "プランを却下しました。" : "このプランは処理済みです。");
      }
      return void await interaction.editReply(await executeApproved(jobId!, interaction.guildId!, approver));
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rolepanel:") || interaction.isButton() && interaction.customId.startsWith("rolebutton:")) return await handlePanelComponent(interaction as never);
  } catch (error) {
    const internalMessage = error instanceof Error ? error.message : "unknown";
    const memberFacing = interaction.isButton() && (interaction.customId.startsWith("rolebutton:") || interaction.customId.startsWith("giveaway:"))
      || interaction.isStringSelectMenu() && interaction.customId.startsWith("rolepanel:");
    const message = memberFacing ? "処理に失敗しました。時間をおいて再度お試しください。" : internalMessage;
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => undefined);
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
    }
    console.error(JSON.stringify({ level: "error", event: "interaction.failed", error: internalMessage, interactionId: interaction.id }));
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  void handleWorkflowVoiceStateUpdate(oldState, newState).catch((error) => console.error(JSON.stringify({ level: "error", event: "workflow.voice_state_dispatch_failed", guildId: newState.guild.id, error: error instanceof Error ? error.message : "unknown" })));
});

client.once(Events.ClientReady, async (ready) => {
  console.info(JSON.stringify({ level: "info", event: "bot.ready", user: ready.user.tag, workerId }));
  const recovered = await recoverExpiredExecutionLeases().catch(() => 0);
  if (recovered) console.error(JSON.stringify({ level: "error", event: "jobs.recovery_required", count: recovered }));
  const recoveredDraws = await recoverInterruptedDraws().catch(() => 0);
  if (recoveredDraws) console.warn(JSON.stringify({ level: "warn", event: "giveaway.draw_recovered", count: recoveredDraws }));
  const recoveredWorkflowRuns = await recoverStaleInteractiveRuns().catch(() => 0);
  if (recoveredWorkflowRuns) console.warn(JSON.stringify({ level: "warn", event: "workflow.runs_recovery_required", count: recoveredWorkflowRuns }));
  setInterval(() => void recoverExpiredExecutionLeases().then((count) => { if (count) console.error(JSON.stringify({ level: "error", event: "jobs.recovery_required", count })); }).catch((error) => console.error("lease recovery failed", error)), 30_000).unref();
  setInterval(() => void db.select({ id: giveaways.id }).from(giveaways).where(and(eq(giveaways.state, "ACTIVE"), sql`${giveaways.endsAt} <= now()`)).then((due) => Promise.all(due.map((row) => drawGiveaway(row.id)))).catch((error) => console.error("giveaway scheduler failed", error)), 15_000).unref();
  setInterval(() => void recoverInterruptedDraws().catch((error) => console.error("giveaway draw recovery failed", error)), 60_000).unref();
  setInterval(() => void dispatchGiveawayNotifications().catch((error) => console.error("giveaway notification dispatcher failed", error)), 5_000).unref();
  setInterval(() => void recoverStaleInteractiveRuns().then((count) => { if (count) console.warn(JSON.stringify({ level: "warn", event: "workflow.runs_recovery_required", count })); }).catch((error) => console.error("interactive workflow recovery failed", error)), 60_000).unref();
  setInterval(() => void dispatchWorkflowSchedules(client).catch((error) => console.error("workflow schedule dispatcher failed", error)), 10_000).unref();
  setInterval(() => void cleanupEmptyWorkflowVoiceChannels(client).catch((error) => console.error("workflow voice cleanup failed", error)), 30_000).unref();
  void dispatchGiveawayNotifications().catch((error) => console.error("initial giveaway notification dispatch failed", error));
  void dispatchWorkflowSchedules(client).catch((error) => console.error("initial workflow schedule dispatch failed", error));
  void cleanupEmptyWorkflowVoiceChannels(client).catch((error) => console.error("initial workflow voice cleanup failed", error));
});

const rest = client.rest;
const health = createServer(async (request, response) => {
  if (request.url !== "/health") { response.writeHead(404).end(); return; }
  let database = false;
  try { await pool.query("SELECT 1"); database = true; } catch { /* readiness reflects database errors without exposing details */ }
  const ok = client.isReady() && database;
  response.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok, discord: client.isReady(), database }));
});
health.listen(Number(process.env.HEALTH_PORT ?? 3000));

async function shutdown(signal: string): Promise<void> {
  console.info(JSON.stringify({ level: "info", event: "shutdown", signal }));
  health.close();
  client.destroy();
  await pool.end();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(process.env.DISCORD_TOKEN);
