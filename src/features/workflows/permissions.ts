import { PermissionFlagsBits } from "discord.js";

export type WorkflowPrivatePreset = "private_member" | "staff_only";

export function buildWorkflowPrivateOverwrites(input: { guildId: string; botId: string; preset: WorkflowPrivatePreset; memberId?: string; staffRoleId?: string }) {
  if (input.preset === "private_member" && !input.memberId) throw new Error("private_member preset requires the triggering member.");
  if (input.preset === "staff_only" && (!input.staffRoleId || input.staffRoleId === input.guildId)) throw new Error("staff_only preset requires a non-everyone staff role.");
  const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  return [
    { id: input.guildId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: input.botId, allow },
    ...(input.preset === "private_member" && input.memberId ? [{ id: input.memberId, allow }] : []),
    ...(input.preset === "staff_only" && input.staffRoleId ? [{ id: input.staffRoleId, allow }] : []),
  ];
}

export function mayCloseWorkflowChannel(input: { createdForMemberId: string | null; staffRoleId: string | null; memberId: string; memberRoleIds: Pick<ReadonlySet<string>, "has">; isGuildManager: boolean }): boolean {
  return input.isGuildManager || input.createdForMemberId === input.memberId || Boolean(input.staffRoleId && input.memberRoleIds.has(input.staffRoleId));
}
