import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import type { PanelPlan } from "./agent/plan.js";
import { agentSkills, resolvePanelSkill, type AgentSkillId } from "./agent/skills/registry.js";
import { resolveResourceSkill } from "./agent/skills/registry.js";
import type { ResourceWorkflow } from "./agent/workflow.js";
import type { InteractiveWorkflow, InteractiveWorkflowStep } from "./agent/interactive-workflow.js";

const skillPermissionFlags = {
  ManageGuild: PermissionFlagsBits.ManageGuild,
  ManageRoles: PermissionFlagsBits.ManageRoles,
  ManageChannels: PermissionFlagsBits.ManageChannels,
} as const;

export function assertSkillPermissions(skillId: AgentSkillId, actor: GuildMember): void {
  const skill = agentSkills[skillId];
  const missing = skill.requiredPermissions.filter((permission) => !actor.permissions.has(skillPermissionFlags[permission]));
  const labels = { ManageGuild: "サーバー管理", ManageRoles: "ロール管理", ManageChannels: "チャンネル管理" } as const;
  if (missing.length) throw new Error(`必要なDiscord権限がありません: ${missing.map((permission) => labels[permission]).join("、")}`);
}

export function assertResourceWorkflowPermissions(guild: Guild, workflow: ResourceWorkflow, actor: GuildMember): void {
  if (!agentSkills["resource.workflow"].approval.required) throw new Error("リソース作成Workflowには承認ゲートが必要です。");
  const bot = guild.members.me;
  for (const step of workflow.steps) {
    const skillId = resolveResourceSkill(step);
    if (!agentSkills[skillId].approval.required) throw new Error(`Resource Skill requires an approval gate: ${skillId}`);
    assertSkillPermissions(skillId, actor);
    if (!bot) throw new Error("Botのサーバーメンバー情報を取得できません。");
    if (step.action === "role.create" && !bot.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error("Botにロール管理権限がありません。");
    if ((step.action === "channel.create_category" || step.action === "channel.create_text") && !bot.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Botにチャンネル管理権限がありません。");
  }
}

const interactiveActionSkills: Record<InteractiveWorkflowStep["action"], AgentSkillId> = {
  "entry.join": "workflow.entry.join",
  "entry.leave": "workflow.entry.leave",
  "state.set": "workflow.state.set",
  "role.grant": "workflow.role.grant",
  "role.revoke": "workflow.role.revoke",
  "message.send": "workflow.message.send",
  "message.edit": "workflow.message.edit",
  "panel.refresh": "workflow.panel.refresh",
  "voice.channel.create": "workflow.voice.channel.create",
  "voice.channel.delete": "workflow.voice.channel.delete",
  "resource.role.create": "workflow.resource.role.create",
  "resource.channel.create_category": "workflow.resource.channel.create_category",
  "resource.channel.create_text": "workflow.resource.channel.create_text",
  "giveaway.create": "workflow.giveaway.create",
  "giveaway.join": "workflow.giveaway.join",
  "giveaway.leave": "workflow.giveaway.leave",
  "giveaway.end": "workflow.giveaway.end",
  "giveaway.pause": "workflow.giveaway.pause",
  "giveaway.resume": "workflow.giveaway.resume",
  "giveaway.reroll": "workflow.giveaway.reroll",
};

export function assertInteractiveWorkflowPermissions(guild: Guild, workflow: InteractiveWorkflow, actor: GuildMember): void {
  if (!agentSkills["workflow.publish"].approval.required) throw new Error("Interactive Workflow publication requires approval.");
  assertSkillPermissions("workflow.publish", actor);
  const bot = guild.members.me;
  if (!bot) throw new Error("Bot guild member could not be resolved.");
  for (const trigger of workflow.triggers) {
    if (trigger.event === "voice.member_join_event") assertSkillPermissions("workflow.voice.member_join_event", actor);
    if (trigger.event === "voice.member_leave_event") assertSkillPermissions("workflow.voice.member_leave_event", actor);
    for (const step of trigger.steps) {
      const skillId = interactiveActionSkills[step.action];
      assertSkillPermissions(skillId, actor);
      if (step.action === "role.grant" || step.action === "role.revoke") {
        if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error("Bot needs Manage Roles for this Workflow.");
      }
      if (step.action === "message.send" || step.action === "message.edit" || step.action === "panel.refresh") {
        if (!bot.permissions.has(PermissionFlagsBits.SendMessages)) throw new Error("Bot needs Send Messages for this Workflow.");
      }
      if (step.action === "voice.channel.create" || step.action === "voice.channel.delete") {
        if (!bot.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot needs Manage Channels for Voice Workflow actions.");
        if (step.action === "voice.channel.create" && !bot.permissions.has(PermissionFlagsBits.MoveMembers)) throw new Error("Bot needs Move Members to gather the lobby occupants in a temporary voice channel.");
      }
      if (step.action === "resource.role.create" && !bot.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error("Bot needs Manage Roles for Workflow role creation.");
      if ((step.action === "resource.channel.create_category" || step.action === "resource.channel.create_text") && !bot.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("Bot needs Manage Channels for Workflow channel creation.");
    }
  }
}

export function assertInteractiveWorkflowUpdatePermission(actor: GuildMember): void {
  if (!agentSkills["workflow.update"].approval.required) throw new Error("Interactive Workflow updates require an approval gate.");
  assertSkillPermissions("workflow.update", actor);
}

export function assertPolicy(guild: Guild, actor: GuildMember, plan: PanelPlan): void {
  const skillId = resolvePanelSkill(plan).id;
  if (!agentSkills[skillId].approval.required) throw new Error(`Panel Skill requires an approval gate: ${skillId}`);
  assertSkillPermissions(skillId, actor);
  if (plan.options.length > 25) throw new Error("選択肢は25個までです。");
  const bot = guild.members.me;
  if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error("Botにロール管理権限がありません。");
  const roleNames = plan.options.map((option) => option.roleName);
  if (new Set(roleNames.map((name) => name.toLocaleLowerCase())).size !== roleNames.length) throw new Error("ロール名が重複しています。");
}

const forbiddenRolePermissions = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
];

export function assertDistributableRole(guild: Guild, role: Role, ownerJobId: string | undefined, actor: GuildMember): void {
  if (role.id === guild.id || role.managed) throw new Error("@everyoneと連携アプリ管理ロールは配布できません。");
  if (!ownerJobId) throw new Error(`Autocordが所有していない既存ロールは配布できません: ${role.name}`);
  if (containsForbiddenPermissions(role.permissions.bitfield)) throw new Error(`危険な権限を含むロールは配布できません: ${role.name}`);
  if (role.permissions.bitfield !== 0n) throw new Error(`権限が設定されたロールは配布できません: ${role.name}`);
  const bot = guild.members.me;
  if (!bot || !isBelowHierarchy(role.position, bot.roles.highest.position)) throw new Error(`Botのロール階層外です: ${role.name}`);
  if (actor.id !== guild.ownerId && !isBelowHierarchy(role.position, actor.roles.highest.position)) throw new Error(`実行者のロール階層外です: ${role.name}`);
}

export function assertSelfAssignableRole(guild: Guild, role: Role, ownerJobId: string | undefined): void {
  if (role.id === guild.id || role.managed) throw new Error("@everyoneと連携アプリ管理ロールはWorkflowで配布できません。");
  if (!ownerJobId) throw new Error(`Autocordが所有していない既存ロールはWorkflowで配布できません: ${role.name}`);
  if (role.permissions.bitfield !== 0n || containsForbiddenPermissions(role.permissions.bitfield)) throw new Error(`権限付きロールはWorkflowで配布できません: ${role.name}`);
  const bot = guild.members.me;
  if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= bot.roles.highest.position) throw new Error(`Botが操作できない階層のロールです: ${role.name}`);
}

export function containsForbiddenPermissions(bitfield: bigint): boolean {
  return forbiddenRolePermissions.some((permission) => (bitfield & permission) !== 0n);
}

export function isExpectedRevision(current: number, expected: number): boolean {
  return current === expected;
}

export function isBelowHierarchy(rolePosition: number, memberHighestPosition: number): boolean {
  return rolePosition < memberHighestPosition;
}
