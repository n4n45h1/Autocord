import { z } from "zod";
import { interactiveWorkflowStepSchema, type InteractiveWorkflow, type WorkflowCondition } from "./interactive-workflow.js";

export const structuredMaxRequirementsSchema = z.object({
  target: z.enum(["panel", "resources", "interactive", "unimplemented"]),
  requiredActions: z.array(z.string().regex(/^[a-z0-9._-]{1,80}$/)).max(40),
  requiredTriggers: z.array(z.string().regex(/^[a-z0-9._-]{1,80}$/)).max(20),
  invariants: z.array(z.enum(["unique_per_member", "atomic_debit", "no_duplicate_redemption", "one_vote_per_member", "private_staff_channel", "empty_voice_cleanup", "restart_resilient", "weekly_timezone", "game_loop"])).max(20),
}).strict();

export type StructuredMaxRequirements = z.infer<typeof structuredMaxRequirementsSchema>;

const actionNames = new Set([
  ...interactiveWorkflowStepSchema.options.map((option) => option.shape.action.value),
  "role.create", "channel.create_category", "channel.create_text",
  "panel.set_title", "panel.set_description", "panel.set_color", "panel.set_render_mode", "panel.set_selection_mode", "panel.set_component_style",
  "option.add", "option.remove", "option.rename_role", "option.set_label", "option.set_emoji",
]);
const triggerNames = new Set([
  "button", "select", "modal_submit", "schedule", "schedule.at", "deadline", "voice.member_join_event", "voice.member_leave_event",
  "member.join", "member.leave", "member.role_added", "member.role_removed", "message.created", "message.deleted", "reaction.added", "reaction.removed",
]);

function conditionLeaves(condition: WorkflowCondition | undefined): WorkflowCondition[] {
  if (!condition) return [];
  if (condition.op === "not") return conditionLeaves(condition.condition);
  if (condition.op === "and" || condition.op === "or") return condition.conditions.flatMap(conditionLeaves);
  return [condition];
}

export function validateStructuredRequirementCapabilities(requirements: StructuredMaxRequirements): string[] {
  const missing = new Set<string>();
  for (const action of requirements.requiredActions) if (!actionNames.has(action as never)) missing.add(action);
  for (const trigger of requirements.requiredTriggers) if (!triggerNames.has(trigger)) missing.add(`trigger.${trigger}`);
  if (requirements.target === "unimplemented") missing.add("requested_workflow_target");
  if (requirements.invariants.includes("game_loop")) missing.add("workflow.game_loop");
  return [...missing];
}

export function validateStructuredWorkflow(requirements: StructuredMaxRequirements, workflow: InteractiveWorkflow): string[] {
  const issues: string[] = [];
  const steps = workflow.triggers.flatMap((trigger) => trigger.steps);
  const actions = new Set(steps.map((step) => step.action));
  const triggers = new Set(workflow.triggers.map((trigger) => trigger.event));
  for (const action of requirements.requiredActions) if (!actions.has(action as InteractiveWorkflow["triggers"][number]["steps"][number]["action"])) issues.push(`required action is missing: ${action}`);
  for (const trigger of requirements.requiredTriggers) if (!triggers.has(trigger as InteractiveWorkflow["triggers"][number]["event"])) issues.push(`required trigger is missing: ${trigger}`);
  if (requirements.invariants.includes("unique_per_member") && !steps.some((step) => step.action === "entry.join" || step.action === "collection.add" && (step.scope === "member" || typeof step.item === "string" && step.item.includes("{{input:authorId}}")))) issues.push("unique_per_member invariant lacks a unique entry or actor-keyed Collection add");
  if (requirements.invariants.includes("atomic_debit") && !steps.some((step) => step.action === "state.debit")) issues.push("atomic_debit invariant requires state.debit");
  if (requirements.invariants.includes("no_duplicate_redemption")) {
    const debit = steps.find((step) => step.action === "state.debit");
    if (!debit || !steps.some((step) => step.action === "message.dm" && step.dependsOn.includes(debit.id) && step.when && conditionLeaves(step.when).some((condition) => condition.op === "result.equals" && condition.stepId === debit.id && condition.field === "debited" && condition.value === true))) issues.push("no_duplicate_redemption requires an atomic debit and success-guarded reward");
  }
  if (requirements.invariants.includes("one_vote_per_member") && !steps.some((step) => step.action === "collection.add" && step.scope === "workflow" && typeof step.item === "string" && step.item.includes("{{input:authorId}}"))) issues.push("one_vote_per_member invariant requires a workflow collection keyed by event authorId");
  if (requirements.invariants.includes("empty_voice_cleanup")) {
    const deleteStep = steps.find((step) => step.action === "voice.channel.delete");
    if (!workflow.triggers.some((trigger) => trigger.event === "voice.member_leave_event") || !conditionLeaves(deleteStep?.when).some((condition) => condition.op === "voice.members.eq" && condition.value === 0)) issues.push("empty_voice_cleanup requires a voice leave trigger guarded by zero members");
  }
  if (requirements.invariants.includes("restart_resilient") && !steps.some((step) => step.action === "workflow.wait") && !workflow.triggers.some((trigger) => trigger.event === "schedule" || trigger.event === "deadline")) issues.push("restart_resilient requires a persistent wait or schedule");
  if (requirements.invariants.includes("weekly_timezone") && !workflow.triggers.some((trigger) => trigger.event === "schedule.at")) issues.push("weekly_timezone requires a schedule.at trigger with explicit timeZone/day/hour/minute");
  if (requirements.invariants.includes("private_staff_channel")) {
    const ticket = steps.find((step) => step.action === "channel.create_text" && step.visibility === "staff_only" && Boolean(step.staffRoleId));
    const privateSend = ticket && steps.some((step) => step.action === "message.send" && step.delivery === "workflow_channel_step" && step.channelStepId === ticket.id);
    const staffClose = workflow.triggers.some((trigger) => trigger.event === "modal_submit" && trigger.steps.some((step) => step.action === "channel.delete" && typeof step.channelId === "string" && step.channelId.includes("{{input:") && step.when && conditionLeaves(step.when).some((condition) => condition.op === "member.has_role")));
    if (!ticket || !privateSend || !staffClose) issues.push("private_staff_channel requires a ticket preset, a send bound to that ticket, and a staff-guarded close action");
  }
  return issues;
}
