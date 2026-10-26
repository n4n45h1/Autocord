import "dotenv/config";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GatewayIntentBits, PermissionFlagsBits, StringSelectMenuBuilder,
  type ChatInputCommandInteraction, type GuildMember, type InteractionReplyOptions, type MessageCreateOptions, type Role,
} from "discord.js";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import { db, pool } from "./db/client.js";
import { agentJobs, auditEvents, giveaways, giveawayEntries, giveawayNotifications, guildSettings, managedRoles, panelOptions, panelRevisions, panels, usageRecords } from "./db/schema.js";
import { makePlan, type AgentMode } from "./agent/planner.js";
import { panelPlanSchema, type PanelPlan } from "./agent/plan.js";
import { failUsageReservation, finishUsage, reserveUsage, type UsageReservation } from "./agent/core/usage.js";
import { assertDistributableRole, assertPolicy, isExpectedRevision } from "./policy.js";
import { claimApproval, recoverExpiredExecutionLeases, withGuildAdvisoryLock } from "./jobs/claim.js";
import { commands } from "./discord/commands.js";
import { drawWinners, giveawayNotificationRetryDelayMs, giveawayResultMessage } from "./features/giveaways/draw.js";
import { renderPanel } from "./features/panels/render.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
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

function preview(plan: PanelPlan, jobId: string, before?: PanelPlan): InteractionReplyOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve:${jobId}`).setLabel("承認して実行").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny:${jobId}`).setLabel("却下").setStyle(ButtonStyle.Secondary),
  );
  return { content: `**Agentcord ${plan.intent === "create" ? "作成" : "編集"}プレビュー**\n${planDiff(before, plan)}\n\nジョブ: \`${jobId}\`\n10分以内に管理者が承認してください。`, components: [row], allowedMentions: { parse: [] } };
}

type PlanInteraction = Pick<ChatInputCommandInteraction, "guild" | "guildId" | "user" | "channel" | "channelId" | "followUp">;

async function writePlan(interaction: PlanInteraction, jobId: string, instruction: string, mode: AgentMode, selectedPanel?: typeof panels.$inferSelect, reservation?: UsageReservation): Promise<void> {
  const existing = selectedPanel ? stablePanelPlan(panelPlanSchema.parse(selectedPanel.spec), selectedPanel.id, selectedPanel.revision) : undefined;
  try {
    const result = await makePlan(instruction, existing, mode);
    let plan = result.plan;
    if (selectedPanel && (plan.intent !== "edit" || plan.panelId !== selectedPanel.id || plan.expectedRevision !== selectedPanel.revision)) throw new Error("編集対象またはrevisionが一致しません。もう一度パネルを選んでください。");
    if (!selectedPanel && plan.intent !== "create") throw new Error("編集対象パネルを確定できませんでした。");
    if (selectedPanel && panelPlanSchema.parse(selectedPanel.spec).renderMode !== plan.renderMode) throw new Error("Discordのメッセージ仕様上、既存パネルの描画方式は変更できません。別パネルとして作成してください。");
    const trustedChannelId = selectedPanel?.channelId ?? interaction.channelId;
    if (!trustedChannelId || plan.channelId && plan.channelId !== trustedChannelId) throw new Error("この操作では依頼したチャンネルへの発行のみ対応しています。");
    plan = panelPlanSchema.parse({ ...plan, channelId: trustedChannelId });
    const actor = await interaction.guild!.members.fetch(interaction.user.id);
    assertPolicy(interaction.guild!, actor, plan);
    const hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const expiresAt = new Date(Date.now() + Number(process.env.APPROVAL_TTL_MINUTES ?? 10) * 60_000);
    const saved = await db.update(agentJobs).set({ state: "AWAITING_APPROVAL", mode, plan, planHash: hash, revision: selectedPanel?.revision ?? null, expiresAt, updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "PLANNING"))).returning({ id: agentJobs.id });
    if (saved.length !== 1) throw new Error("ジョブ状態が変化しました。もう一度依頼してください。");
    const reservationRow = reservation ? await db.select().from(usageRecords).where(eq(usageRecords.id, reservation.id)).limit(1) : [];
    if (reservation && reservationRow.length) await finishUsage(reservation, result.model, result.inputTokens, result.outputTokens);
    await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "plan.created", outcome: "success", detail: { planHash: hash, mode, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, beforeRevision: selectedPanel?.revision ?? null } });
    await interaction.followUp({ ...preview(plan, jobId, existing), ephemeral: true });
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
    requireAdmin(actor);
    const mode = (interaction.options.getString("mode") ?? "mini") as AgentMode;
    const instruction = interaction.options.getString("指示", true);
    reservation = await reserveUsage(interaction.guildId!, interaction.user.id, jobId, mode, instruction);
    const matches = isLikelyEdit(instruction) ? await db.select().from(panels).where(eq(panels.guildId, interaction.guildId!)).orderBy(sql`${panels.updatedAt} desc`).limit(25) : [];
    if (isLikelyEdit(instruction) && matches.length > 1) {
      await db.update(agentJobs).set({ state: "AWAITING_PANEL_SELECTION", updatedAt: new Date() }).where(eq(agentJobs.id, jobId));
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`target:${jobId}`).setPlaceholder("編集するパネルを選択").addOptions(matches.map((panel) => ({ label: panel.title.slice(0, 100), value: panel.id, description: `revision ${panel.revision}` }))));
      await interaction.editReply({ content: "編集対象のパネルを選んでください。選択後に変更プレビューを作成します。", components: [row] });
      return;
    }
    const selectedPanel = matches.length === 1 ? matches[0] : undefined;
    await writePlan(interaction, jobId, instruction, mode, selectedPanel, reservation);
    await interaction.editReply({ content: "プレビューを作成しました。表示された差分を確認してください。" });
  } catch (error) {
    if (reservation) await failUsageReservation(reservation);
    const message = error instanceof Error ? error.message : "処理に失敗しました。";
    await interaction.editReply({ content: message }).catch(() => undefined);
  }
}

async function executeApproved(jobId: string, guildId: string, actor: GuildMember): Promise<string> {
  requireAdmin(actor);
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
    if (!job?.plan || !job.planHash || job.state !== "EXECUTING") throw new Error("実行対象ジョブが見つかりません。");
    const plan = panelPlanSchema.parse(job.plan);
    if (createHash("sha256").update(JSON.stringify(plan)).digest("hex") !== job.planHash) throw new Error("承認後にプランが変更されています。");
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("サーバーを取得できません。");
    const freshActor = await guild.members.fetch(actor.id);
    assertPolicy(guild, freshActor, plan);
    const [existing] = plan.panelId ? await db.select().from(panels).where(and(eq(panels.id, plan.panelId), eq(panels.guildId, guildId))).limit(1) : [];
    if (plan.intent === "edit" && (!existing || !isExpectedRevision(existing.revision, plan.expectedRevision!) || !isExpectedRevision(existing.revision, job.revision!))) throw new Error("対象パネルが別の操作で更新されました。新しいプレビューを作成してください。");
    const [channel] = plan.channelId ? [await guild.channels.fetch(plan.channelId)] : [await guild.channels.fetch(existing?.channelId ?? "")];
    const targetChannel = channel ?? guild.channels.cache.find((candidate) => candidate.isSendable());
    if (!targetChannel?.isSendable()) throw new Error("パネル発行先チャンネルを取得できません。");
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
      await db.update(agentJobs).set({ state, leaseExpiresAt: null, errorDetail: { message: error instanceof Error ? error.message : "unknown", compensationFailed }, updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)));
      await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId: actor.id, action: "panel.execute", outcome: compensationFailed ? "recovery_required" : "compensated", detail: { message: error instanceof Error ? error.message : "unknown" } });
      throw error;
    }
    });
  } catch (error) {
    await db.update(agentJobs).set({ state: "FAILED", leaseExpiresAt: null, errorDetail: { message: error instanceof Error ? error.message : "unknown" }, updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId), eq(agentJobs.state, "EXECUTING"), eq(agentJobs.leaseOwner, leaseOwner)));
    throw error;
  } finally {
    clearInterval(heartbeat);
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
  const planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const restoreBindings = revision.beforeBindings as { key: string; label: string; roleId: string }[] | null;
  await db.insert(agentJobs).values({ id: jobId, guildId: interaction.guildId!, requesterId: interaction.user.id, state: "AWAITING_APPROVAL", mode: "mini", idempotencyKey: jobId, instruction: `Undo job ${targetJobId}`, plan, planHash, revision: panel.revision, executionContext: { restoreBindings: restoreBindings ?? [] }, expiresAt: new Date(Date.now() + 600_000) });
  await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "panel.undo.requested", outcome: "pending_approval", detail: { targetJobId, panelId: panel.id, revision: panel.revision } });
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
        if (hasRole) { await member.roles.remove(role, `Autocord panel ${panel.id}`); changed.push({ role, added: false }); }
        else { await member.roles.add(role, `Autocord panel ${panel.id}`); changed.push({ role, added: true }); }
      } else if (kind === "rolepanel") {
        const shouldHave = chosenKeys.has(binding.key);
        if (shouldHave && !hasRole) { await member.roles.add(role, `Autocord panel ${panel.id}`); changed.push({ role, added: true }); }
        if (!shouldHave && hasRole) { await member.roles.remove(role, `Autocord panel ${panel.id}`); changed.push({ role, added: false }); }
      }
    }
    if (kind === "rolebutton" && currentSpec.selectionMode === "single" && chosenKeys.size) {
      for (const binding of bindings.filter((item) => item.key !== key)) {
        const role = interaction.guild.roles.cache.get(binding.roleId);
        if (role?.id && member.roles.cache.has(role.id)) {
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

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "agent") return await handleAgent(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === "autocord") {
      if (!interaction.guild) return void await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const member = await interaction.guild.members.fetch(interaction.user.id);
      requireAdmin(member);
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "undo") {
        const message = await prepareUndo(interaction, interaction.options.getString("job_id", true));
        return void await interaction.editReply(message);
      }
      if (subcommand === "panels") {
        const rows = await db.select().from(panels).where(eq(panels.guildId, interaction.guildId!)).orderBy(sql`${panels.updatedAt} desc`).limit(25);
        return void await interaction.editReply(rows.length ? rows.map((panel) => `• ${panel.title} (ID: ${panel.id}, revision ${panel.revision})`).join("\n") : "このサーバーにパネルはありません。");
      }
      if (subcommand === "roles") {
        const rows = await db.select({ roleId: managedRoles.roleId }).from(managedRoles).where(eq(managedRoles.guildId, interaction.guildId!)).limit(25);
        const names = await Promise.all(rows.map(async ({ roleId }) => (await interaction.guild!.roles.fetch(roleId).catch(() => null))?.name ?? `削除済み (${roleId})`));
        return void await interaction.editReply(names.length ? names.map((name) => `• ${name}`).join("\n") : "Autocord管理ロールはありません。");
      }
      if (subcommand === "channels") {
        const channelList = [...(await interaction.guild.channels.fetch()).values()].flatMap((channel) => { const line = displaySendableChannel(channel); return line ? [line] : []; }).slice(0, 25);
        return void await interaction.editReply(channelList.length ? channelList.join("\n") : "利用可能なチャンネルはありません。");
      }
      if (subcommand === "usage") {
        const period = new Date().toISOString().slice(0, 7);
        const rows = await db.select({ mode: usageRecords.mode, count: sql<number>`count(*)::int`, input: sql<number>`sum(${usageRecords.inputTokens})::int`, output: sql<number>`sum(${usageRecords.outputTokens})::int`, cost: sql<string>`sum(${usageRecords.estimatedCostUsd}::numeric)::text` }).from(usageRecords).where(and(eq(usageRecords.guildId, interaction.guildId!), eq(usageRecords.period, period))).groupBy(usageRecords.mode);
        return void await interaction.editReply(rows.length ? rows.map((row) => `${row.mode}: ${row.count}回 / 入力${row.input ?? 0}・出力${row.output ?? 0} tokens / 推定$${row.cost ?? "0"}`).join("\n") : "今月の利用はありません。");
      }
      if (subcommand === "settings") {
        const mini = interaction.options.getInteger("mini_monthly");
        const max = interaction.options.getInteger("max_monthly");
        if (mini !== null || max !== null) {
          const serviceMiniCap = Number(process.env.MINI_MONTHLY_LIMIT ?? 30);
          const serviceMaxCap = Number(process.env.MAX_MONTHLY_LIMIT ?? 5);
          if (mini !== null && mini > serviceMiniCap || max !== null && max > serviceMaxCap) throw new Error("設定値はサービス上限を超えられません。");
          await db.insert(guildSettings).values({ guildId: interaction.guildId!, miniMonthlyLimit: mini ?? serviceMiniCap, maxMonthlyLimit: max ?? serviceMaxCap, updatedAt: new Date() }).onConflictDoUpdate({ target: guildSettings.guildId, set: { ...(mini !== null ? { miniMonthlyLimit: mini } : {}), ...(max !== null ? { maxMonthlyLimit: max } : {}), updatedAt: new Date() } });
        }
        await db.insert(guildSettings).values({ guildId: interaction.guildId!, miniMonthlyLimit: Number(process.env.MINI_MONTHLY_LIMIT ?? 30), maxMonthlyLimit: Number(process.env.MAX_MONTHLY_LIMIT ?? 5) }).onConflictDoNothing();
        const [settings] = await db.select().from(guildSettings).where(eq(guildSettings.guildId, interaction.guildId!)).limit(1);
        return void await interaction.editReply(`月間上限: Mini ${settings!.miniMonthlyLimit}回 / Max ${settings!.maxMonthlyLimit}回\n同時ジョブ上限: ${Number(process.env.MAX_CONCURRENT_JOBS_PER_GUILD ?? 1)}件`);
      }
      const rows = await db.select().from(auditEvents).where(eq(auditEvents.guildId, interaction.guildId!)).orderBy(sql`${auditEvents.createdAt} desc`).limit(10);
      return void await interaction.editReply(rows.length ? rows.map((row) => `${row.createdAt.toISOString()} ${row.action} ${row.outcome} job:${row.jobId}`).join("\n") : "操作履歴はありません。");
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "giveaway") {
      if (!interaction.guild || !interaction.channel?.isSendable()) return void await interaction.reply({ content: "サーバーのテキストチャンネルで実行してください。", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      requireAdmin(actor);
      const subcommand = interaction.options.getSubcommand();
      const giveawayId = interaction.options.getString("giveaway_id");
      if (subcommand === "end") {
        const [updated] = await db.update(giveaways).set({ endsAt: new Date() }).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "ACTIVE"))).returning({ id: giveaways.id });
        if (!updated) return void await interaction.editReply("開催中の企画が見つかりません。");
        await drawGiveaway(updated.id);
        return void await interaction.editReply("企画を終了して抽選しました。");
      }
      if (subcommand === "pause") {
        const [paused] = await db.update(giveaways).set({ state: "PAUSED", remainingSeconds: sql`GREATEST(0, floor(extract(epoch from ${giveaways.endsAt} - now())))::int` }).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "ACTIVE"))).returning({ id: giveaways.id });
        if (!paused) return void await interaction.editReply("開催中の企画が見つかりません。");
        await db.insert(auditEvents).values({ id: randomUUID(), jobId: paused.id, guildId: interaction.guildId!, actorId: interaction.user.id, action: "giveaway.paused", outcome: "success" });
        return void await interaction.editReply("企画を一時停止しました。");
      }
      if (subcommand === "resume") {
        const [paused] = await db.select().from(giveaways).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "PAUSED"))).limit(1);
        if (!paused) return void await interaction.editReply("一時停止中の企画が見つかりません。");
        const remaining = Math.max(1, paused.remainingSeconds ?? 1);
        const [resumed] = await db.update(giveaways).set({ state: "ACTIVE", endsAt: new Date(Date.now() + remaining * 1000), remainingSeconds: null }).where(and(eq(giveaways.id, giveawayId!), eq(giveaways.guildId, interaction.guildId!), eq(giveaways.state, "PAUSED"))).returning({ id: giveaways.id });
        if (resumed) await db.insert(auditEvents).values({ id: randomUUID(), jobId: resumed.id, guildId: interaction.guildId!, actorId: interaction.user.id, action: "giveaway.resumed", outcome: "success" });
        return void await interaction.editReply(resumed ? "企画を再開しました。" : "企画状態が変わりました。再確認してください。");
      }
      if (subcommand === "reroll") {
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
      const id = randomUUID();
      const endsAt = new Date(Date.now() + minutes * 60_000);
      const message = await interaction.channel.send({ content: `🎁 **${prize}**\n当選者: ${winnerCount}人\n終了: <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n参加するにはボタンを押してください。`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`giveaway:${id}`).setLabel("参加").setStyle(ButtonStyle.Primary))] });
      try {
        await db.insert(giveaways).values({ id, guildId: interaction.guildId!, channelId: interaction.channelId!, messageId: message.id, hostId: interaction.user.id, prize, winnerCount, state: "ACTIVE", endsAt });
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
      await writePlan(interaction, jobId, job!.instruction, job!.mode as AgentMode, panel, reservation);
      return void await interaction.followUp({ content: "編集プレビューを作成しました。差分を確認してください。", ephemeral: true });
    }
    if (interaction.isButton() && (interaction.customId.startsWith("approve:") || interaction.customId.startsWith("deny:"))) {
      if (!interaction.guild) return void await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      requireAdmin(await interaction.guild.members.fetch(interaction.user.id));
      const [action, jobId] = interaction.customId.split(":");
      if (action === "deny") {
        const denied = await db.update(agentJobs).set({ state: "DENIED", approvalActorId: interaction.user.id, decisionAt: new Date(), updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId!), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "AWAITING_APPROVAL"))).returning({ id: agentJobs.id });
        if (denied.length) await db.insert(auditEvents).values({ id: randomUUID(), jobId: jobId!, guildId: interaction.guildId!, actorId: interaction.user.id, action: "plan.denied", outcome: "success" });
        return void await interaction.editReply(denied.length ? "プランを却下しました。" : "このプランは処理済みです。");
      }
      return void await interaction.editReply(await executeApproved(jobId!, interaction.guildId!, await interaction.guild.members.fetch(interaction.user.id)));
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

client.once(Events.ClientReady, async (ready) => {
  console.info(JSON.stringify({ level: "info", event: "bot.ready", user: ready.user.tag, workerId }));
  const recovered = await recoverExpiredExecutionLeases().catch(() => 0);
  if (recovered) console.error(JSON.stringify({ level: "error", event: "jobs.recovery_required", count: recovered }));
  const recoveredDraws = await recoverInterruptedDraws().catch(() => 0);
  if (recoveredDraws) console.warn(JSON.stringify({ level: "warn", event: "giveaway.draw_recovered", count: recoveredDraws }));
  setInterval(() => void recoverExpiredExecutionLeases().then((count) => { if (count) console.error(JSON.stringify({ level: "error", event: "jobs.recovery_required", count })); }).catch((error) => console.error("lease recovery failed", error)), 30_000).unref();
  setInterval(() => void db.select({ id: giveaways.id }).from(giveaways).where(and(eq(giveaways.state, "ACTIVE"), sql`${giveaways.endsAt} <= now()`)).then((due) => Promise.all(due.map((row) => drawGiveaway(row.id)))).catch((error) => console.error("giveaway scheduler failed", error)), 15_000).unref();
  setInterval(() => void recoverInterruptedDraws().catch((error) => console.error("giveaway draw recovery failed", error)), 60_000).unref();
  setInterval(() => void dispatchGiveawayNotifications().catch((error) => console.error("giveaway notification dispatcher failed", error)), 5_000).unref();
  void dispatchGiveawayNotifications().catch((error) => console.error("initial giveaway notification dispatch failed", error));
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
