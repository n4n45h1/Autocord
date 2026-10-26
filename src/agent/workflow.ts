import { z } from "zod";
import { panelPlanSchema, type PanelPlan } from "./plan.js";

const stepBase = { id: z.string().regex(/^[a-z0-9_-]{1,40}$/), dependsOn: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).max(7) };

const operationSchema = z.discriminatedUnion("action", [
  z.object({ ...stepBase, action: z.literal("panel.set_title"), value: z.string().min(1).max(80) }).strict(),
  z.object({ ...stepBase, action: z.literal("panel.set_description"), value: z.string().max(1000) }).strict(),
  z.object({ ...stepBase, action: z.literal("panel.set_color"), value: z.enum(["blue", "purple", "green", "red", "gray"]) }).strict(),
  z.object({ ...stepBase, action: z.literal("panel.set_render_mode"), value: z.enum(["classic", "components_v2"]) }).strict(),
  z.object({ ...stepBase, action: z.literal("panel.set_selection_mode"), value: z.enum(["single", "multiple"]) }).strict(),
  z.object({ ...stepBase, action: z.literal("panel.set_component_style"), value: z.enum(["select", "buttons"]) }).strict(),
  z.object({ ...stepBase, action: z.literal("option.add"), key: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().min(1).max(80), roleName: z.string().min(1).max(100), emoji: z.string().max(64).nullable() }).strict(),
  z.object({ ...stepBase, action: z.literal("option.remove"), key: z.string().regex(/^[a-z0-9_-]{1,40}$/) }).strict(),
  z.object({ ...stepBase, action: z.literal("option.rename_role"), key: z.string().regex(/^[a-z0-9_-]{1,40}$/), roleName: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("option.set_label"), key: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().min(1).max(80) }).strict(),
  z.object({ ...stepBase, action: z.literal("option.set_emoji"), key: z.string().regex(/^[a-z0-9_-]{1,40}$/), emoji: z.string().max(64).nullable() }).strict(),
]);

export const maxWorkflowSchema = z.object({
  version: z.literal(1),
  operations: z.array(operationSchema).min(1).max(8),
}).strict().superRefine((workflow, ctx) => {
  const ids = new Set<string>();
  for (const operation of workflow.operations) {
    if (ids.has(operation.id)) ctx.addIssue({ code: "custom", message: `duplicate workflow step id: ${operation.id}` });
    ids.add(operation.id);
  }
  for (const operation of workflow.operations) {
    if (new Set(operation.dependsOn).size !== operation.dependsOn.length) ctx.addIssue({ code: "custom", message: `duplicate dependency on step: ${operation.id}` });
    for (const dependency of operation.dependsOn) {
      if (!ids.has(dependency)) ctx.addIssue({ code: "custom", message: `unknown dependency ${dependency} on step: ${operation.id}` });
      if (dependency === operation.id) ctx.addIssue({ code: "custom", message: `workflow step cannot depend on itself: ${operation.id}` });
    }
  }
});

export type MaxWorkflow = z.infer<typeof maxWorkflowSchema>;
export type MaxWorkflowOperation = MaxWorkflow["operations"][number];

function orderDependencyGraph<T extends { id: string; dependsOn: string[] }>(operations: readonly T[]): T[] {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const remaining = new Set(byId.keys());
  const completed = new Set<string>();
  const result: T[] = [];
  while (remaining.size) {
    const next = operations.find((operation) => remaining.has(operation.id) && operation.dependsOn.every((dependency) => completed.has(dependency)));
    if (!next) throw new Error("Agentcord Max workflow contains a dependency cycle.");
    result.push(next);
    remaining.delete(next.id);
    completed.add(next.id);
  }
  return result;
}

export function orderWorkflowOperations(operations: readonly MaxWorkflowOperation[]): MaxWorkflowOperation[] {
  return orderDependencyGraph(operations);
}

const roleCreateStepSchema = z.object({ ...stepBase, action: z.literal("role.create"), name: z.string().min(1).max(100) }).strict();
const categoryCreateStepSchema = z.object({ ...stepBase, action: z.literal("channel.create_category"), name: z.string().min(1).max(100) }).strict();
const textChannelCreateStepSchema = z.object({
  ...stepBase,
  action: z.literal("channel.create_text"),
  name: z.string().min(1).max(100),
  topic: z.string().max(1024).nullable(),
  categoryStepId: z.string().regex(/^[a-z0-9_-]{1,40}$/).nullable(),
}).strict();

const resourceStepSchema = z.discriminatedUnion("action", [roleCreateStepSchema, categoryCreateStepSchema, textChannelCreateStepSchema]);

export const resourceWorkflowSchema = z.object({ version: z.literal(1), steps: z.array(resourceStepSchema).min(1).max(8) }).strict().superRefine((workflow, ctx) => {
  const ids = new Set<string>();
  for (const step of workflow.steps) {
    if (ids.has(step.id)) ctx.addIssue({ code: "custom", message: `duplicate resource step id: ${step.id}` });
    ids.add(step.id);
  }
  for (const step of workflow.steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length) ctx.addIssue({ code: "custom", message: `duplicate dependency on resource step: ${step.id}` });
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) ctx.addIssue({ code: "custom", message: `unknown dependency ${dependency} on resource step: ${step.id}` });
      if (dependency === step.id) ctx.addIssue({ code: "custom", message: `resource step cannot depend on itself: ${step.id}` });
    }
    if (step.action === "channel.create_text" && step.categoryStepId) {
      const category = workflow.steps.find((candidate) => candidate.id === step.categoryStepId);
      if (category?.action !== "channel.create_category") ctx.addIssue({ code: "custom", message: `categoryStepId must refer to channel.create_category: ${step.id}` });
      if (!step.dependsOn.includes(step.categoryStepId)) ctx.addIssue({ code: "custom", message: `text channel must depend on its category: ${step.id}` });
    }
  }
});

export type ResourceWorkflow = z.infer<typeof resourceWorkflowSchema>;
export type ResourceWorkflowStep = ResourceWorkflow["steps"][number];

export const maxAgentWorkflowSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("panel"), workflow: maxWorkflowSchema }).strict(),
  z.object({ target: z.literal("resources"), workflow: resourceWorkflowSchema }).strict(),
]);

export type MaxAgentWorkflow = z.infer<typeof maxAgentWorkflowSchema>;

export function resourceSkillId(step: ResourceWorkflowStep): "role.create" | "channel.create_category" | "channel.create_text" {
  return step.action;
}

export function orderResourceSteps(steps: readonly ResourceWorkflowStep[]): ResourceWorkflowStep[] {
  return orderDependencyGraph(steps);
}

export function compileMaxWorkflow(existing: PanelPlan | undefined, workflowInput: unknown): PanelPlan {
  const workflow = maxWorkflowSchema.parse(workflowInput);
  const operations = orderWorkflowOperations(workflow.operations);
  const plan: PanelPlan = existing
    ? { ...existing, options: existing.options.map((option) => ({ ...option })) }
    : {
      intent: "create", panelId: null, expectedRevision: null, title: "ロールパネル",
      description: "ロールを選択してください。", color: "blue", renderMode: "components_v2",
      selectionMode: "multiple", componentStyle: "select", channelId: null, options: [],
    };

  for (const operation of operations) {
    const optionIndex = "key" in operation ? plan.options.findIndex((option) => option.key === operation.key) : -1;
    switch (operation.action) {
      case "panel.set_title": plan.title = operation.value; break;
      case "panel.set_description": plan.description = operation.value; break;
      case "panel.set_color": plan.color = operation.value; break;
      case "panel.set_render_mode": plan.renderMode = operation.value; break;
      case "panel.set_selection_mode": plan.selectionMode = operation.value; break;
      case "panel.set_component_style": plan.componentStyle = operation.value; break;
      case "option.add":
        if (optionIndex !== -1) throw new Error(`Max cannot add an existing option key: ${operation.key}`);
        plan.options.push({ key: operation.key, label: operation.label, roleName: operation.roleName, emoji: operation.emoji });
        break;
      case "option.remove":
        if (optionIndex === -1) throw new Error(`Max cannot remove a missing option key: ${operation.key}`);
        plan.options.splice(optionIndex, 1);
        break;
      case "option.rename_role":
        if (optionIndex === -1) throw new Error(`Max cannot rename a missing option key: ${operation.key}`);
        plan.options[optionIndex]!.roleName = operation.roleName;
        break;
      case "option.set_label":
        if (optionIndex === -1) throw new Error(`Max cannot relabel a missing option key: ${operation.key}`);
        plan.options[optionIndex]!.label = operation.label;
        break;
      case "option.set_emoji":
        if (optionIndex === -1) throw new Error(`Max cannot change emoji on a missing option key: ${operation.key}`);
        plan.options[optionIndex]!.emoji = operation.emoji;
        break;
    }
  }
  return panelPlanSchema.parse(plan);
}
