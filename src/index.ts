import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, PermissionFlagsBits, StringSelectMenuBuilder, type ChatInputCommandInteraction, type GuildMember, type MessageCreateOptions, type Role } from "discord.js";
import { eq, and } from "drizzle-orm";
import { db } from "./db/client.js";
import { agentJobs, panels, panelOptions, auditEvents } from "./db/schema.js";
import { makePlan } from "./agent/planner.js";
import { panelPlanSchema, type PanelPlan } from "./agent/plan.js";
import { assertPolicy } from "./policy.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
function makePreview(plan: PanelPlan, jobId: string): MessageCreateOptions {
  const summary = plan.options.map((option, index) => `${index + 1}. ${option.label} → ロール「${option.roleName}」`).join("\n");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve:${jobId}`).setLabel("承認して実行").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny:${jobId}`).setLabel("却下").setStyle(ButtonStyle.Secondary),
  );
  return { content: `**${plan.intent === "create" ? "新規作成" : "編集"}プレビュー: ${plan.title}**\n${plan.description}\n\n${summary}\n\n変更を確認して承認してください。`, components: [row], allowedMentions: { parse: [] } };
}

async function handleAgent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.member || !interaction.channel || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "サーバー管理権限が必要です。", ephemeral: true }); return;
  }
  await interaction.deferReply({ ephemeral: true });
  const actor = await interaction.guild.members.fetch(interaction.user.id);
  const instruction = interaction.options.getString("指示", true);
  const jobId = randomUUID();
  try {
    const plan = await makePlan(instruction);
    if (plan.channelId && plan.channelId !== interaction.channelId) throw new Error("このMVPでは現在のチャンネルへの発行のみ対応しています。");
    assertPolicy(interaction.guild, actor, plan);
    const hash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    const expiresAt = new Date(Date.now() + Number(process.env.APPROVAL_TTL_MINUTES ?? 10) * 60_000);
    await db.insert(agentJobs).values({ id: jobId, guildId: interaction.guildId!, requesterId: interaction.user.id, state: "AWAITING_APPROVAL", instruction, plan, planHash: hash, expiresAt });
    await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "plan.created", outcome: "success", detail: { planHash: hash } });
    await interaction.editReply({ content: "プランを作成しました。承認プレビューをこのチャンネルに表示します。" });
    if (interaction.channel.isSendable()) await interaction.channel.send(makePreview(plan, jobId));
  } catch (error) {
    await db.insert(auditEvents).values({ id: randomUUID(), jobId, guildId: interaction.guildId!, actorId: interaction.user.id, action: "plan.failed", outcome: "rejected", detail: { message: error instanceof Error ? error.message : "unknown" } });
    await interaction.editReply(`計画を作成できませんでした: ${error instanceof Error ? error.message : "不明なエラー"}`);
  }
}

async function executeApproved(jobId: string, guildId: string, actor: GuildMember): Promise<string> {
  const [job] = await db.select().from(agentJobs).where(and(eq(agentJobs.id, jobId), eq(agentJobs.guildId, guildId))).limit(1);
  if (!job || job.state !== "AWAITING_APPROVAL" || !job.plan || !job.planHash || !job.expiresAt || job.expiresAt < new Date()) throw new Error("承認プランが見つからないか、有効期限が切れています。");
  const plan = panelPlanSchema.parse(job.plan);
  if (createHash("sha256").update(JSON.stringify(plan)).digest("hex") !== job.planHash) throw new Error("承認後にプランが変更されています。");
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error("サーバーを取得できません。");
  assertPolicy(guild, actor, plan);
  await db.update(agentJobs).set({ state: "EXECUTING", updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId), eq(agentJobs.state, "AWAITING_APPROVAL")));
  try {
    const channel = await guild.channels.fetch(plan.channelId ?? "") ?? actor.guild.channels.cache.find((item) => item.isTextBased() && "send" in item);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error("発行先チャンネルが見つかりません。");
    const roles: { option: PanelPlan["options"][number]; role: Role }[] = [];
    for (const option of plan.options) {
      let role = guild.roles.cache.find((candidate) => candidate.name === option.roleName);
      if (!role) role = await guild.roles.create({ name: option.roleName, reason: `Autocord job ${jobId}` });
      if (role.position >= guild.members.me!.roles.highest.position) throw new Error(`Botより上位のロールはパネル化できません: ${role.name}`);
      roles.push({ option, role });
    }
    const panelId = plan.intent === "edit" && plan.panelId ? plan.panelId : randomUUID();
    const [existing] = await db.select().from(panels).where(and(eq(panels.id, panelId), eq(panels.guildId, guildId))).limit(1);
    const component = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`rolepanel:${panelId}`).setPlaceholder("付与するロールを選択").setMinValues(0).setMaxValues(Math.min(roles.length, 25)).addOptions(roles.map(({ option, role }) => ({ label: option.label, value: role.id, description: option.roleName.slice(0, 100) }))));
    const content = { content: `**${plan.title}**\n${plan.description}`, components: [component], allowedMentions: { parse: [] as const } };
    let messageId = existing?.messageId;
    if (existing) {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(content);
    } else {
      const message = await channel.send(content);
      messageId = message.id;
    }
    await db.transaction(async (tx) => {
      await tx.insert(panels).values({ id: panelId, guildId, channelId: channel.id, messageId: messageId!, title: plan.title, description: plan.description, color: plan.color, revision: (existing?.revision ?? 0) + 1, spec: plan }).onConflictDoUpdate({ target: panels.id, set: { channelId: channel.id, messageId: messageId!, title: plan.title, description: plan.description, color: plan.color, revision: (existing?.revision ?? 0) + 1, spec: plan, updatedAt: new Date() } });
      await tx.delete(panelOptions).where(eq(panelOptions.panelId, panelId));
      await tx.insert(panelOptions).values(roles.map(({ option, role }) => ({ id: randomUUID(), panelId, key: option.key, label: option.label, roleId: role.id })));
      await tx.update(agentJobs).set({ state: "COMPLETED", updatedAt: new Date() }).where(eq(agentJobs.id, jobId));
      await tx.insert(auditEvents).values({ id: randomUUID(), jobId, guildId, actorId: actor.id, action: "panel.published", outcome: "success", detail: { panelId, messageId } });
    });
    return `パネル「${plan.title}」を${existing ? "更新" : "作成"}しました。`;
  } catch (error) {
    await db.update(agentJobs).set({ state: "FAILED", updatedAt: new Date() }).where(eq(agentJobs.id, jobId));
    throw error;
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "agent") return await handleAgent(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === "autocord") {
      const rows = await db.select().from(panels).where(eq(panels.guildId, interaction.guildId ?? ""));
      return interaction.reply({ content: rows.length ? rows.map((panel) => `• ${panel.title} (ID: ${panel.id}, revision ${panel.revision})`).join("\n") : "このサーバーにパネルはありません。", ephemeral: true });
    }
    if (interaction.isButton() && (interaction.customId.startsWith("approve:") || interaction.customId.startsWith("deny:"))) {
      if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "サーバー管理権限が必要です。", ephemeral: true });
      const [action, jobId] = interaction.customId.split(":");
      await interaction.deferReply({ ephemeral: true });
      if (action === "deny") {
        await db.update(agentJobs).set({ state: "DENIED", updatedAt: new Date() }).where(and(eq(agentJobs.id, jobId!), eq(agentJobs.guildId, interaction.guildId!), eq(agentJobs.state, "AWAITING_APPROVAL")));
        return interaction.editReply("プランを却下しました。");
      }
      return interaction.editReply(await executeApproved(jobId!, interaction.guildId!, await interaction.guild.members.fetch(interaction.user.id)));
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rolepanel:")) {
      if (!interaction.guild || !interaction.member) return;
      const panelId = interaction.customId.slice("rolepanel:".length);
      const [panel] = await db.select().from(panels).where(and(eq(panels.id, panelId), eq(panels.guildId, interaction.guildId!))).limit(1);
      if (!panel) return interaction.reply({ content: "このパネルは利用できません。", ephemeral: true });
      const options = await db.select().from(panelOptions).where(eq(panelOptions.panelId, panelId));
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const selected = new Set(interaction.values);
      for (const option of options) {
        const role = interaction.guild.roles.cache.get(option.roleId);
        if (!role || role.managed || role.position >= interaction.guild.members.me!.roles.highest.position) continue;
        if (selected.has(role.id) && !member.roles.cache.has(role.id)) await member.roles.add(role, `Role panel ${panelId}`);
        if (!selected.has(role.id) && member.roles.cache.has(role.id)) await member.roles.remove(role, `Role panel ${panelId}`);
      }
      return interaction.reply({ content: "ロールを更新しました。", ephemeral: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました。";
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => undefined);
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
    }
    console.error("interaction failed", { error: message });
  }
});

client.once(Events.ClientReady, (ready) => console.info(`Autocord online as ${ready.user.tag}`));
await client.login(process.env.DISCORD_TOKEN);
