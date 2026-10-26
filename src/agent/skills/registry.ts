import { z } from "zod";
import { panelPlanSchema, type PanelPlan } from "../plan.js";
import { maxWorkflowSchema, resourceWorkflowSchema, resourceSkillId, type MaxWorkflow, type ResourceWorkflow, type ResourceWorkflowStep } from "../workflow.js";
import { interactiveWorkflowSchema, interactiveWorkflowStepSchema } from "../interactive-workflow.js";

const emptyInput = z.object({}).strict();
const idInput = z.object({ id: z.string().min(1).max(80) }).strict();
const giveawayIdInput = z.object({ giveawayId: z.string().min(1).max(80) }).strict();

export const agentSkills = {
  "skills.list": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["skill-catalog.read"],
  },
  "panel.create": {
    inputSchema: panelPlanSchema.refine((plan) => plan.intent === "create", "panel.create requires intent=create"),
    requiredPermissions: ["ManageGuild", "ManageRoles"],
    targetScope: "authenticated-guild",
    risk: "guild-state-write",
    approval: { required: true, binds: ["guildId", "planHash", "expiresAt"] },
    effects: ["role.create(permissionless)", "panel.publish"],
  },
  "panel.edit": {
    inputSchema: panelPlanSchema.refine((plan) => plan.intent === "edit", "panel.edit requires intent=edit"),
    requiredPermissions: ["ManageGuild", "ManageRoles"],
    targetScope: "authenticated-guild-and-panel-revision",
    risk: "guild-state-write",
    approval: { required: true, binds: ["guildId", "panelId", "revision", "planHash", "expiresAt"] },
    effects: ["owned-role.rename", "panel.edit", "panel-option.update"],
  },
  "panel.list": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["panel.read"],
  },
  "panel.undo": {
    inputSchema: idInput,
    requiredPermissions: ["ManageGuild", "ManageRoles"], targetScope: "authenticated-guild-and-source-job", risk: "guild-state-write",
    approval: { required: true, binds: ["guildId", "sourceJobId", "panelId", "revision", "planHash", "expiresAt"] }, effects: ["panel.compensating-edit"],
  },
  "panel.workflow": {
    inputSchema: maxWorkflowSchema,
    requiredPermissions: ["ManageGuild", "ManageRoles"],
    targetScope: "single-authenticated-guild-and-resolved-panel",
    risk: "guild-state-write",
    approval: { required: true, binds: ["guildId", "panelId", "revision", "compiledPlanHash", "expiresAt"] },
    effects: ["panel.plan.compile", "permissionless-role.create-or-owned-role.edit", "panel.publish-or-edit"],
  },
  "resource.workflow": {
    inputSchema: resourceWorkflowSchema,
    requiredPermissions: ["ManageGuild"],
    targetScope: "authenticated-guild",
    risk: "guild-resource-create",
    approval: { required: true, binds: ["guildId", "resourceWorkflowHash", "expiresAt"] },
    effects: ["role.create(permissionless)", "channel.create(category-or-text)"],
  },
  "workflow.publish": {
    inputSchema: interactiveWorkflowSchema,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild-and-current-channel", risk: "guild-state-write",
    approval: { required: true, binds: ["guildId", "channelId", "workflowHash", "expiresAt"] }, effects: ["workflow.v2-panel.publish"],
  },
  "workflow.update": {
    inputSchema: interactiveWorkflowSchema,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild-and-workflow-version", risk: "guild-state-write",
    approval: { required: true, binds: ["guildId", "workflowId", "expectedVersion", "workflowHash", "expiresAt"] }, effects: ["workflow.definition.update", "workflow.message.edit"],
  },
  "workflow.list": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["workflow-definition.read"],
  },
  "workflow.entry.join": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "entry.join", "workflow.entry.join requires entry.join"),
    requiredPermissions: [], targetScope: "interaction-member-and-workflow-collection", risk: "member-entry-write",
    approval: { required: false, binds: ["guildId", "workflowId", "memberId", "collection"] }, effects: ["unique-entry.register-with-cap"],
  },
  "workflow.entry.leave": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "entry.leave", "workflow.entry.leave requires entry.leave"),
    requiredPermissions: [], targetScope: "interaction-member-and-workflow-collection", risk: "member-entry-write",
    approval: { required: false, binds: ["guildId", "workflowId", "memberId", "collection"] }, effects: ["unique-entry.remove"],
  },
  "workflow.state.set": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "state.set", "workflow.state.set requires state.set"),
    requiredPermissions: [], targetScope: "declared-workflow-state-key", risk: "workflow-state-write",
    approval: { required: false, binds: ["workflowId", "stepId", "scope", "stateKey"] }, effects: ["workflow.state.upsert"],
  },
  "workflow.role.grant": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "role.grant", "workflow.role.grant requires role.grant"),
    requiredPermissions: [], targetScope: "interaction-member-and-owned-permissionless-role", risk: "member-self-role-change",
    approval: { required: false, binds: ["guildId", "workflowId", "memberId", "managedRoleId"] }, effects: ["managed-role.assign-to-member"],
  },
  "workflow.role.revoke": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "role.revoke", "workflow.role.revoke requires role.revoke"),
    requiredPermissions: [], targetScope: "interaction-member-and-owned-permissionless-role", risk: "member-self-role-change",
    approval: { required: false, binds: ["guildId", "workflowId", "memberId", "managedRoleId"] }, effects: ["managed-role.remove-from-member"],
  },
  "workflow.message.send": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "message.send", "workflow.message.send requires message.send"),
    requiredPermissions: [], targetScope: "workflow-owned-channel", risk: "guild-message-write",
    approval: { required: false, binds: ["workflowId", "channelId", "stepId"] }, effects: ["message.send-without-mentions"],
  },
  "workflow.message.edit": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "message.edit", "workflow.message.edit requires message.edit"),
    requiredPermissions: [], targetScope: "workflow-owned-panel-message", risk: "guild-message-write",
    approval: { required: false, binds: ["workflowId", "messageId", "stepId"] }, effects: ["workflow-panel-message.edit"],
  },
  "workflow.panel.refresh": {
    inputSchema: interactiveWorkflowStepSchema.refine((step) => step.action === "panel.refresh", "workflow.panel.refresh requires panel.refresh"),
    requiredPermissions: [], targetScope: "workflow-owned-panel-message", risk: "guild-message-write",
    approval: { required: false, binds: ["workflowId", "messageId", "stepId"] }, effects: ["workflow-panel.render-state"],
  },
  "role.create": {
    inputSchema: z.object({ id: z.string(), dependsOn: z.array(z.string()), action: z.literal("role.create"), name: z.string().min(1).max(100) }).strict(),
    requiredPermissions: ["ManageGuild", "ManageRoles"],
    targetScope: "authenticated-guild",
    risk: "guild-resource-create",
    approval: { required: true, binds: ["guildId", "resourceWorkflowHash", "expiresAt"] },
    effects: ["role.create(permissionless)"],
  },
  "role.list": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["managed-role.read"],
  },
  "role.assign": {
    inputSchema: z.object({ panelId: z.string().min(1).max(80), key: z.string().regex(/^[a-z0-9_-]{1,40}$/) }).strict(),
    requiredPermissions: [], targetScope: "interaction-member-self-and-guild-panel", risk: "member-self-role-change",
    approval: { required: false, binds: ["guildId", "memberId", "panelId", "optionKey"] }, effects: ["owned-role.assign-to-self"],
  },
  "role.revoke": {
    inputSchema: z.object({ panelId: z.string().min(1).max(80), key: z.string().regex(/^[a-z0-9_-]{1,40}$/) }).strict(),
    requiredPermissions: [], targetScope: "interaction-member-self-and-guild-panel", risk: "member-self-role-change",
    approval: { required: false, binds: ["guildId", "memberId", "panelId", "optionKey"] }, effects: ["owned-role.remove-from-self"],
  },
  "channel.create_category": {
    inputSchema: z.object({ id: z.string(), dependsOn: z.array(z.string()), action: z.literal("channel.create_category"), name: z.string().min(1).max(100) }).strict(),
    requiredPermissions: ["ManageGuild", "ManageChannels"],
    targetScope: "authenticated-guild",
    risk: "guild-resource-create",
    approval: { required: true, binds: ["guildId", "resourceWorkflowHash", "expiresAt"] },
    effects: ["channel.create(category)"],
  },
  "channel.create_text": {
    inputSchema: z.object({ id: z.string(), dependsOn: z.array(z.string()), action: z.literal("channel.create_text"), name: z.string().min(1).max(100), topic: z.string().max(1024).nullable(), categoryStepId: z.string().nullable() }).strict(),
    requiredPermissions: ["ManageGuild", "ManageChannels"],
    targetScope: "authenticated-guild",
    risk: "guild-resource-create",
    approval: { required: true, binds: ["guildId", "resourceWorkflowHash", "expiresAt"] },
    effects: ["channel.create(text)"],
  },
  "channel.list": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["channel.read"],
  },
  "giveaway.create": {
    inputSchema: z.object({ prize: z.string().min(1).max(100), minutes: z.number().int().min(1).max(10080), winners: z.number().int().min(1).max(20) }).strict(),
    requiredPermissions: ["ManageGuild", "ManageRoles"], targetScope: "authenticated-guild-and-current-channel", risk: "guild-state-write",
    approval: { required: false, binds: ["guildId", "actorId", "channelId", "slashCommandInteraction"] }, effects: ["giveaway.create-and-publish"],
  },
  "giveaway.end": {
    inputSchema: giveawayIdInput,
    requiredPermissions: ["ManageGuild", "ManageRoles"], targetScope: "authenticated-guild-and-giveaway", risk: "guild-state-write",
    approval: { required: false, binds: ["guildId", "actorId", "giveawayId", "slashCommandInteraction"] }, effects: ["giveaway.end-and-draw"],
  },
  "giveaway.reroll": {
    inputSchema: giveawayIdInput,
    requiredPermissions: ["ManageGuild", "ManageRoles"], targetScope: "authenticated-guild-and-giveaway", risk: "guild-state-write",
    approval: { required: false, binds: ["guildId", "actorId", "giveawayId", "slashCommandInteraction"] }, effects: ["giveaway.reroll-and-audit"],
  },
  "giveaway.pause": {
    inputSchema: giveawayIdInput,
    requiredPermissions: ["ManageGuild", "ManageRoles"], targetScope: "authenticated-guild-and-giveaway", risk: "guild-state-write",
    approval: { required: false, binds: ["guildId", "actorId", "giveawayId", "slashCommandInteraction"] }, effects: ["giveaway.pause"],
  },
  "giveaway.resume": {
    inputSchema: giveawayIdInput,
    requiredPermissions: ["ManageGuild", "ManageRoles"], targetScope: "authenticated-guild-and-giveaway", risk: "guild-state-write",
    approval: { required: false, binds: ["guildId", "actorId", "giveawayId", "slashCommandInteraction"] }, effects: ["giveaway.resume"],
  },
  "giveaway.join": {
    inputSchema: giveawayIdInput,
    requiredPermissions: [], targetScope: "interaction-member-and-current-guild-giveaway", risk: "member-entry-write",
    approval: { required: false, binds: ["guildId", "memberId", "giveawayId"] }, effects: ["giveaway.entry.upsert"],
  },
  "giveaway.leave": {
    inputSchema: giveawayIdInput,
    requiredPermissions: [], targetScope: "interaction-member-and-current-guild-giveaway", risk: "member-entry-write",
    approval: { required: false, binds: ["guildId", "memberId", "giveawayId"] }, effects: ["giveaway.entry.delete"],
  },
  "usage.read": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["usage.read"],
  },
  "settings.read": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["guild-settings.read"],
  },
  "settings.update": {
    inputSchema: z.object({ miniMonthly: z.number().int().min(0).nullable(), maxMonthly: z.number().int().min(0).nullable() }).strict(),
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "guild-config-write",
    approval: { required: false, binds: ["guildId", "actorId", "slashCommandInteraction"] }, effects: ["guild-settings.update-with-service-cap"] ,
  },
  "audit.list": {
    inputSchema: emptyInput,
    requiredPermissions: ["ManageGuild"], targetScope: "authenticated-guild", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["audit.read"],
  },
  "job.status": {
    inputSchema: z.object({ jobId: z.string().min(1).max(80) }).strict(),
    requiredPermissions: [], targetScope: "requester-or-guild-manager-and-guild-job", risk: "read-only",
    approval: { required: false, binds: [] }, effects: ["job.read"],
  },
} as const;

export type AgentSkillId = keyof typeof agentSkills;
export type AgentSkillDefinition = typeof agentSkills[AgentSkillId];
export type PanelMutationSkillId = "panel.create" | "panel.edit";

export function resolvePanelSkill(plan: PanelPlan): { id: PanelMutationSkillId; definition: AgentSkillDefinition } {
  return plan.intent === "create"
    ? { id: "panel.create", definition: agentSkills["panel.create"] }
    : { id: "panel.edit", definition: agentSkills["panel.edit"] };
}

export function parseSkillInput(skillId: "panel.create" | "panel.edit", input: unknown): PanelPlan;
export function parseSkillInput(skillId: AgentSkillId, input: unknown): unknown;
export function parseSkillInput(skillId: AgentSkillId, input: unknown): unknown {
  if (skillId === "panel.workflow" || skillId === "resource.workflow") throw new Error(`Use the dedicated parser for ${skillId}.`);
  return agentSkills[skillId].inputSchema.parse(input);
}

export function parseWorkflowSkillInput(input: unknown): MaxWorkflow {
  return agentSkills["panel.workflow"].inputSchema.parse(input);
}

export function parseResourceWorkflowInput(input: unknown): ResourceWorkflow {
  return agentSkills["resource.workflow"].inputSchema.parse(input);
}

export function resolveResourceSkill(step: ResourceWorkflowStep): AgentSkillId {
  return resourceSkillId(step);
}

export function listAgentSkills(): { id: AgentSkillId; risk: string; approvalRequired: boolean; targetScope: string }[] {
  return Object.entries(agentSkills).map(([id, definition]) => ({
    id: id as AgentSkillId,
    risk: definition.risk,
    approvalRequired: definition.approval.required,
    targetScope: definition.targetScope,
  }));
}
