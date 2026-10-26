import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
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
