import { z } from "zod";

const key = z.string().regex(/^[a-z0-9._-]{1,40}$/);
const scalar = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const conditionLeaf = z.discriminatedUnion("op", [
  z.object({ op: z.literal("entries.lt"), collection: key, value: z.number().int().min(0).max(1000) }).strict(),
  z.object({ op: z.literal("entries.gte"), collection: key, value: z.number().int().min(0).max(1000) }).strict(),
  z.object({ op: z.literal("state.equals"), scope: z.enum(["workflow", "guild", "member"]), key, value: scalar }).strict(),
  z.object({ op: z.literal("member.has_role"), roleName: z.string().min(1).max(100) }).strict(),
  z.object({ op: z.literal("member.has_permission"), permission: z.enum(["ManageGuild", "ManageRoles", "ManageChannels", "Administrator"]) }).strict(),
  z.object({ op: z.literal("time.within"), startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }) }).strict().refine((condition) => Date.parse(condition.endAt) > Date.parse(condition.startAt), "time.within endAt must follow startAt"),
  z.object({ op: z.literal("result.equals"), stepId: key, field: key, value: scalar }).strict(),
]);

export const workflowConditionSchema = z.union([
  conditionLeaf,
  z.object({ op: z.enum(["and", "or"]), conditions: z.array(conditionLeaf).min(2).max(8) }).strict(),
]);

const stepBase = { id: key, dependsOn: z.array(key).max(12).default([]), when: workflowConditionSchema.optional() };
export const interactiveWorkflowStepSchema = z.discriminatedUnion("action", [
  z.object({ ...stepBase, action: z.literal("entry.join"), collection: key, maxEntries: z.number().int().min(1).max(1000) }).strict(),
  z.object({ ...stepBase, action: z.literal("entry.leave"), collection: key }).strict(),
  z.object({ ...stepBase, action: z.literal("state.set"), scope: z.enum(["workflow", "guild", "member"]), key, value: scalar }).strict(),
  z.object({ ...stepBase, action: z.literal("role.grant"), roleName: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("role.revoke"), roleName: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("message.send"), content: z.string().min(1).max(1900) }).strict(),
  z.object({ ...stepBase, action: z.literal("message.edit"), content: z.string().max(1900) }).strict(),
  z.object({ ...stepBase, action: z.literal("panel.refresh") }).strict(),
]);

const buttonComponent = z.object({ key, kind: z.literal("button"), label: z.string().min(1).max(80), style: z.enum(["primary", "secondary", "success", "danger"]), emoji: z.string().max(64).nullable(), disabledWhen: workflowConditionSchema.nullable().optional(), triggerId: key }).strict();
const selectComponent = z.object({
  key, kind: z.literal("select"), placeholder: z.string().min(1).max(150), minValues: z.number().int().min(0).max(25), maxValues: z.number().int().min(1).max(25), disabledWhen: workflowConditionSchema.nullable().optional(), triggerId: key,
  options: z.array(z.object({ key, label: z.string().min(1).max(100), description: z.string().max(100).nullable(), emoji: z.string().max(64).nullable() }).strict()).min(1).max(25),
}).strict().superRefine((component, ctx) => {
  if (component.minValues > component.maxValues || component.maxValues > component.options.length) ctx.addIssue({ code: "custom", message: "Select Menu selection bounds exceed its options." });
  if (new Set(component.options.map((option) => option.key)).size !== component.options.length) ctx.addIssue({ code: "custom", message: "Select Menu option keys must be unique." });
});
const modalComponent = z.object({
  key, kind: z.literal("modal"), label: z.string().min(1).max(80), triggerId: key, disabledWhen: workflowConditionSchema.nullable().optional(),
  title: z.string().min(1).max(45),
  inputs: z.array(z.object({ key, label: z.string().min(1).max(45), placeholder: z.string().max(100).nullable(), style: z.enum(["short", "paragraph"]), required: z.boolean(), maxLength: z.number().int().min(1).max(4000) }).strict()).min(1).max(5),
}).strict();

const triggerSchema = z.discriminatedUnion("event", [
  z.object({ id: key, event: z.enum(["button", "select", "modal_submit"]), componentKey: key, steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
  z.object({ id: key, event: z.literal("schedule"), intervalSeconds: z.number().int().min(60).max(604800), steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
  z.object({ id: key, event: z.literal("deadline"), afterSeconds: z.number().int().min(60).max(2_592_000), steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
]);

export const interactiveWorkflowDraftSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(80), title: z.string().min(1).max(80),
  description: z.string().max(1000), color: z.enum(["blue", "purple", "green", "red", "gray"]),
  components: z.array(z.discriminatedUnion("kind", [buttonComponent, selectComponent, modalComponent])).min(1).max(5),
  triggers: z.array(triggerSchema).min(1).max(15),
}).strict();

export const interactiveWorkflowSchema = interactiveWorkflowDraftSchema.superRefine((workflow, ctx) => {
  const componentByKey = new Map(workflow.components.map((component) => [component.key, component]));
  if (componentByKey.size !== workflow.components.length) ctx.addIssue({ code: "custom", message: "Workflow component keys must be unique." });
  const triggerIds = new Set<string>();
  const triggerKeys = new Set<string>();
  let totalSteps = 0;
  for (const trigger of workflow.triggers) {
    if (triggerIds.has(trigger.id)) ctx.addIssue({ code: "custom", message: `Duplicate trigger id: ${trigger.id}` });
    triggerIds.add(trigger.id);
    totalSteps += trigger.steps.length;
    if (trigger.event === "schedule" || trigger.event === "deadline") {
      for (const step of trigger.steps) {
        if (step.action === "entry.join" || step.action === "entry.leave" || step.action === "role.grant" || step.action === "role.revoke") ctx.addIssue({ code: "custom", message: `Scheduled trigger cannot use member-scoped action ${step.action}.` });
        if (step.action === "state.set" && step.scope === "member") ctx.addIssue({ code: "custom", message: "Scheduled triggers may not update member-scoped state." });
        if (step.when?.op === "member.has_role" || step.when?.op === "member.has_permission" || ((step.when?.op === "and" || step.when?.op === "or") && step.when.conditions.some((condition) => condition.op === "member.has_role" || condition.op === "member.has_permission"))) ctx.addIssue({ code: "custom", message: "Scheduled triggers cannot evaluate member-only conditions." });
      }
      continue;
    }
    if (triggerKeys.has(trigger.componentKey)) ctx.addIssue({ code: "custom", message: `Only one trigger may bind to component ${trigger.componentKey}.` });
    triggerKeys.add(trigger.componentKey);
    const component = componentByKey.get(trigger.componentKey);
    const expected = component?.kind === "button" ? "button" : component?.kind === "select" ? "select" : component?.kind === "modal" ? "modal_submit" : null;
    if (!component || expected !== trigger.event || component.triggerId !== trigger.id) ctx.addIssue({ code: "custom", message: `Trigger ${trigger.id} does not match its UI component.` });
    if (new Set(trigger.steps.map((step) => step.id)).size !== trigger.steps.length) ctx.addIssue({ code: "custom", message: `Trigger ${trigger.id} has duplicate step IDs.` });
    const stepIds = new Set(trigger.steps.map((step) => step.id));
    const stepById = new Map(trigger.steps.map((step) => [step.id, step]));
    const dependsOnAncestor = (stepId: string, ancestorId: string, visited = new Set<string>()): boolean => {
      if (visited.has(stepId)) return false;
      visited.add(stepId);
      const current = stepById.get(stepId);
      if (!current) return false;
      return current.dependsOn.some((dependency) => dependency === ancestorId || dependsOnAncestor(dependency, ancestorId, visited));
    };
    const requireResultDependency = (stepId: string, referenceId: string, location: string) => {
      if (!stepIds.has(referenceId)) ctx.addIssue({ code: "custom", message: `${location} references missing result step ${referenceId}.` });
      else if (!dependsOnAncestor(stepId, referenceId)) ctx.addIssue({ code: "custom", message: `${location} must declare a dependency path to result step ${referenceId}.` });
    };
    for (const step of trigger.steps) for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) ctx.addIssue({ code: "custom", message: `Step ${step.id} depends on missing step ${dependency}.` });
      if (dependency === step.id) ctx.addIssue({ code: "custom", message: `Step ${step.id} cannot depend on itself.` });
    }
    for (const step of trigger.steps) {
      const text = step.action === "state.set" && typeof step.value === "string" ? step.value : step.action === "message.send" || step.action === "message.edit" ? step.content : "";
      for (const match of text.matchAll(/\{\{result:([a-z0-9._-]{1,40}):[a-z0-9._-]{1,40}\}\}/g)) requireResultDependency(step.id, match[1]!, `Step ${step.id}`);
      const conditions = step.when ? step.when.op === "and" || step.when.op === "or" ? step.when.conditions : [step.when] : [];
      for (const condition of conditions) if (condition.op === "result.equals") requireResultDependency(step.id, condition.stepId, `Condition on ${step.id}`);
    }
    const pending = new Set(trigger.steps.map((step) => step.id));
    while (pending.size) {
      const ready = trigger.steps.filter((step) => pending.has(step.id) && step.dependsOn.every((dependency) => !pending.has(dependency)));
      if (!ready.length) {
        ctx.addIssue({ code: "custom", message: `Trigger ${trigger.id} contains a dependency cycle.` });
        break;
      }
      for (const step of ready) pending.delete(step.id);
    }
    if (component && (component.kind === "button" || component.kind === "select")) {
      for (const step of trigger.steps) if (step.action === "entry.join") {
        const disabledWhen = component.disabledWhen;
        const hasCapacityGuard = disabledWhen && (disabledWhen.op === "entries.gte"
          ? disabledWhen.collection === step.collection && disabledWhen.value === step.maxEntries
          : disabledWhen.op === "and" || disabledWhen.op === "or"
            ? disabledWhen.conditions.some((condition) => condition.op === "entries.gte" && condition.collection === step.collection && condition.value === step.maxEntries)
            : false);
        if (!hasCapacityGuard) ctx.addIssue({ code: "custom", message: `Join component ${component.key} must disable at the ${step.maxEntries}-entry cap.` });
      }
    }
    const entrySteps = trigger.steps.filter((step) => step.action === "entry.join" || step.action === "entry.leave");
    if (entrySteps.length) {
      const refresh = trigger.steps.find((step) => step.action === "panel.refresh");
      if (!refresh) ctx.addIssue({ code: "custom", message: `Entry trigger ${trigger.id} must refresh its panel.` });
      else for (const entryStep of entrySteps) if (!dependsOnAncestor(refresh.id, entryStep.id)) ctx.addIssue({ code: "custom", message: `Panel refresh in ${trigger.id} must depend on entry step ${entryStep.id}.` });
    }
  }
  if (totalSteps > 24) ctx.addIssue({ code: "custom", message: "Interactive workflow has more than 24 total action steps." });
  for (const component of workflow.components) if (!triggerIds.has(component.triggerId)) ctx.addIssue({ code: "custom", message: `UI component ${component.key} has no trigger.` });
});

export type InteractiveWorkflow = z.infer<typeof interactiveWorkflowSchema>;
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;
export type InteractiveWorkflowTrigger = InteractiveWorkflow["triggers"][number];
export type InteractiveWorkflowStep = InteractiveWorkflowTrigger["steps"][number];
export type WorkflowComponent = InteractiveWorkflow["components"][number];

export function compileInteractiveWorkflow(input: unknown): InteractiveWorkflow {
  const workflow = interactiveWorkflowDraftSchema.parse(input);
  const compiled = structuredClone(workflow);
  const collections = new Set<string>();
  for (const trigger of compiled.triggers) {
    const hasEntries = trigger.steps.some((step) => step.action === "entry.join" || step.action === "entry.leave");
    for (const step of trigger.steps) if (step.action === "entry.join" || step.action === "entry.leave") collections.add(step.collection);
    const entryStepIds = trigger.steps.filter((step) => step.action === "entry.join" || step.action === "entry.leave").map((step) => step.id);
    const refresh = trigger.steps.find((step) => step.action === "panel.refresh");
    if (refresh) refresh.dependsOn = [...new Set([...refresh.dependsOn, ...entryStepIds])];
    if (hasEntries && !trigger.steps.some((step) => step.action === "panel.refresh")) {
      const baseId = `refresh-${trigger.id}`.slice(0, 40);
      let id = baseId;
      let suffix = 1;
      while (trigger.steps.some((step) => step.id === id)) id = `${baseId.slice(0, 37)}-${suffix++}`;
      trigger.steps.push({ id, action: "panel.refresh", dependsOn: entryStepIds });
    }
  }
  const missingCounts = [...collections].filter((collection) => !compiled.description.includes(`{{entries:${collection}:count}}`));
  if (missingCounts.length) {
    const countSummary = missingCounts.map((collection) => `参加者 ${collection}: {{entries:${collection}:count}}`).join("\n");
    compiled.description = `${compiled.description}${compiled.description ? "\n" : ""}${countSummary}`;
  }
  return interactiveWorkflowSchema.parse(compiled);
}

export function orderInteractiveWorkflowSteps<T extends { id: string; dependsOn: string[] }>(steps: readonly T[]): T[] {
  const pending = new Set(steps.map((step) => step.id));
  const ordered: T[] = [];
  while (pending.size) {
    const ready = steps.filter((step) => pending.has(step.id) && step.dependsOn.every((dependency) => !pending.has(dependency)));
    if (!ready.length) throw new Error("Workflow action dependency cycle.");
    for (const step of ready) {
      pending.delete(step.id);
      ordered.push(step);
    }
  }
  return ordered;
}
