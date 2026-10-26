import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import type { PanelPlan } from "./agent/plan.js";

export function assertPolicy(guild: Guild, actor: GuildMember, plan: PanelPlan): void {
  if (!actor.permissions.has(PermissionFlagsBits.ManageRoles) || !actor.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error("ロール管理とサーバー管理の権限が必要です。");
  }
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

export function containsForbiddenPermissions(bitfield: bigint): boolean {
  return forbiddenRolePermissions.some((permission) => (bitfield & permission) !== 0n);
}

export function isExpectedRevision(current: number, expected: number): boolean {
  return current === expected;
}

export function isBelowHierarchy(rolePosition: number, memberHighestPosition: number): boolean {
  return rolePosition < memberHighestPosition;
}
