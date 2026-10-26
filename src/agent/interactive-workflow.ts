import { z } from "zod";

const key = z.string().regex(/^[a-z0-9._-]{1,40}$/);
const scalar = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const finiteNumber = z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000);
const numericOperand = z.union([finiteNumber, z.string().max(100)]);
const conditionLeaf = z.discriminatedUnion("op", [
  z.object({ op: z.literal("entries.lt"), collection: key, value: z.number().int().min(0).max(1000) }).strict(),
  z.object({ op: z.literal("entries.gte"), collection: key, value: z.number().int().min(0).max(1000) }).strict(),
  z.object({ op: z.literal("state.equals"), scope: z.enum(["workflow", "guild", "member"]), key, value: scalar }).strict(),
  z.object({ op: z.enum(["number.eq", "number.gt", "number.gte", "number.lt", "number.lte"]), scope: z.enum(["workflow", "guild", "member"]), key, value: finiteNumber }).strict(),
  z.object({ op: z.enum(["string.equals", "string.contains", "string.starts_with"]), scope: z.enum(["workflow", "guild", "member"]), key, value: z.string().max(1000) }).strict(),
  z.object({ op: z.literal("list.contains"), scope: z.enum(["workflow", "guild", "member"]), key: key.optional(), collection: key.optional(), value: scalar }).strict().refine((condition) => Boolean(condition.key) !== Boolean(condition.collection), "list.contains requires exactly one of key or collection"),
  z.object({ op: z.literal("state.exists"), scope: z.enum(["workflow", "guild", "member"]), key }).strict(),
  z.object({ op: z.literal("state.not_exists"), scope: z.enum(["workflow", "guild", "member"]), key }).strict(),
  z.object({ op: z.literal("member.has_role"), roleName: z.string().min(1).max(100) }).strict(),
  z.object({ op: z.literal("member.has_permission"), permission: z.enum(["ManageGuild", "ManageRoles", "ManageChannels", "Administrator"]) }).strict(),
  z.object({ op: z.literal("time.within"), startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }) }).strict().refine((condition) => Date.parse(condition.endAt) > Date.parse(condition.startAt), "time.within endAt must follow startAt"),
  z.object({ op: z.literal("random.chance"), percent: z.number().min(0).max(100) }).strict(),
  z.object({ op: z.literal("result.equals"), stepId: key, field: key, value: scalar }).strict(),
  z.object({ op: z.literal("voice.members.gte"), value: z.number().int().min(1).max(99) }).strict(),
  z.object({ op: z.literal("voice.members.eq"), value: z.number().int().min(0).max(99) }).strict(),
  z.object({ op: z.literal("voice.session.exists") }).strict(),
]);

type ConditionLeaf = z.infer<typeof conditionLeaf>;
export type WorkflowCondition = ConditionLeaf | { op: "and" | "or"; conditions: WorkflowCondition[] } | { op: "not"; condition: WorkflowCondition };
const conditionNode: z.ZodType<WorkflowCondition> = z.lazy(() => z.union([
  conditionLeaf,
  z.object({ op: z.enum(["and", "or"]), conditions: z.array(conditionNode).min(2).max(8) }).strict(),
  z.object({ op: z.literal("not"), condition: conditionNode }).strict(),
]));

export const workflowConditionSchema = conditionNode.superRefine((condition, ctx) => {
  let nodes = 0;
  const visit = (current: WorkflowCondition, depth: number) => {
    nodes++;
    if (depth > 8) ctx.addIssue({ code: "custom", message: "Condition nesting limit is 8." });
    if (nodes > 64) return;
    if (current.op === "not") visit(current.condition, depth + 1);
    else if (current.op === "and" || current.op === "or") current.conditions.forEach((child) => visit(child, depth + 1));
  };
  visit(condition, 1);
  if (nodes > 64) ctx.addIssue({ code: "custom", message: "Condition node limit is 64." });
});

function conditionLeaves(condition?: WorkflowCondition): ConditionLeaf[] {
  if (!condition) return [];
  if (condition.op === "not") return conditionLeaves(condition.condition);
  if (condition.op === "and" || condition.op === "or") return condition.conditions.flatMap(conditionLeaves);
  return [condition as ConditionLeaf];
}

function conditionUsesVoice(condition: WorkflowCondition): boolean {
  return conditionLeaves(condition).some((leaf) => leaf.op === "voice.members.gte" || leaf.op === "voice.members.eq" || leaf.op === "voice.session.exists");
}

function conditionsOf(condition?: WorkflowCondition) {
  return conditionLeaves(condition);
}

function conditionUsesMember(condition: WorkflowCondition): boolean {
  return conditionLeaves(condition).some((leaf) => leaf.op === "member.has_role" || leaf.op === "member.has_permission");
}

const stepBase = { id: key, dependsOn: z.array(key).max(12).default([]), when: workflowConditionSchema.optional() };
export const interactiveWorkflowStepSchema = z.discriminatedUnion("action", [
  z.object({ ...stepBase, action: z.literal("entry.join"), collection: key, maxEntries: z.number().int().min(1).max(1000) }).strict(),
  z.object({ ...stepBase, action: z.literal("entry.leave"), collection: key }).strict(),
  z.object({ ...stepBase, action: z.literal("state.set"), scope: z.enum(["workflow", "guild", "member"]), key, value: scalar }).strict(),
  z.object({ ...stepBase, action: z.literal("state.get"), scope: z.enum(["workflow", "guild", "member"]), key }).strict(),
  z.object({ ...stepBase, action: z.literal("state.increment"), scope: z.enum(["workflow", "guild", "member"]), key, amount: numericOperand }).strict(),
  z.object({ ...stepBase, action: z.literal("state.decrement"), scope: z.enum(["workflow", "guild", "member"]), key, amount: numericOperand }).strict(),
  z.object({ ...stepBase, action: z.literal("state.multiply"), scope: z.enum(["workflow", "guild", "member"]), key, factor: numericOperand }).strict(),
  z.object({ ...stepBase, action: z.literal("state.delete"), scope: z.enum(["workflow", "guild", "member"]), key }).strict(),
  z.object({ ...stepBase, action: z.literal("state.reset"), scope: z.enum(["workflow", "guild", "member"]), key: key.nullable(), value: scalar.default(null) }).strict(),
  z.object({ ...stepBase, action: z.literal("state.append"), scope: z.enum(["workflow", "guild", "member"]), key, value: scalar }).strict(),
  z.object({ ...stepBase, action: z.literal("state.remove"), scope: z.enum(["workflow", "guild", "member"]), key, value: scalar }).strict(),
  z.object({ ...stepBase, action: z.literal("role.grant"), roleName: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("role.revoke"), roleName: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("message.send"), delivery: z.enum(["workflow_channel", "workflow_owner_dm"]).default("workflow_channel"), content: z.string().min(1).max(1900) }).strict(),
  z.object({ ...stepBase, action: z.literal("message.edit"), content: z.string().max(1900) }).strict(),
  z.object({ ...stepBase, action: z.literal("panel.refresh") }).strict(),
  z.object({ ...stepBase, action: z.literal("voice.channel.create"), name: z.string().min(1).max(100), moveMembers: z.boolean().default(true) }).strict(),
  z.object({ ...stepBase, action: z.literal("voice.channel.delete") }).strict(),
  z.object({ ...stepBase, action: z.literal("resource.role.create"), name: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("resource.channel.create_category"), name: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("resource.channel.create_text"), name: z.string().min(1).max(100), topic: z.string().max(1024).nullable(), categoryStepId: key.nullable() }).strict(),
  z.object({ ...stepBase, action: z.literal("giveaway.create"), prize: z.string().min(1).max(100), durationSeconds: z.number().int().min(60).max(604800), winnerCount: z.number().int().min(1).max(20) }).strict(),
  z.object({ ...stepBase, action: z.literal("giveaway.join"), giveawayId: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("giveaway.leave"), giveawayId: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("giveaway.end"), giveawayId: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("giveaway.pause"), giveawayId: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("giveaway.resume"), giveawayId: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("giveaway.reroll"), giveawayId: z.string().min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("math.add"), left: numericOperand, right: numericOperand }).strict(),
  z.object({ ...stepBase, action: z.literal("math.subtract"), left: numericOperand, right: numericOperand }).strict(),
  z.object({ ...stepBase, action: z.literal("math.multiply"), left: numericOperand, right: numericOperand }).strict(),
  z.object({ ...stepBase, action: z.literal("math.divide"), left: numericOperand, right: numericOperand }).strict(),
  z.object({ ...stepBase, action: z.literal("math.min"), values: z.array(numericOperand).min(1).max(25) }).strict(),
  z.object({ ...stepBase, action: z.literal("math.max"), values: z.array(numericOperand).min(1).max(25) }).strict(),
  z.object({ ...stepBase, action: z.literal("math.clamp"), value: numericOperand, min: finiteNumber, max: finiteNumber }).strict().refine((step) => step.max >= step.min, "math.clamp max must be >= min"),
  z.object({ ...stepBase, action: z.literal("random.integer"), min: z.number().int().min(-1_000_000_000).max(1_000_000_000), max: z.number().int().min(-1_000_000_000).max(1_000_000_000) }).strict().refine((step) => step.max >= step.min, "random.integer max must be >= min"),
  z.object({ ...stepBase, action: z.literal("random.choice"), values: z.array(scalar).min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("random.weighted_choice"), options: z.array(z.object({ value: scalar, weight: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(100) }).strict(),
  z.object({ ...stepBase, action: z.literal("collection.add"), scope: z.enum(["workflow", "guild", "member"]), collection: key, item: scalar, maxItems: z.number().int().min(1).max(10000).default(1000) }).strict(),
  z.object({ ...stepBase, action: z.literal("collection.remove"), scope: z.enum(["workflow", "guild", "member"]), collection: key, item: scalar }).strict(),
  z.object({ ...stepBase, action: z.literal("collection.count"), scope: z.enum(["workflow", "guild", "member"]), collection: key }).strict(),
  z.object({ ...stepBase, action: z.literal("collection.contains"), scope: z.enum(["workflow", "guild", "member"]), collection: key, item: scalar }).strict(),
  z.object({ ...stepBase, action: z.literal("collection.list"), scope: z.enum(["workflow", "guild", "member"]), collection: key, limit: z.number().int().min(1).max(100).default(50) }).strict(),
  z.object({ ...stepBase, action: z.literal("collection.rank"), scope: z.enum(["workflow", "guild", "member"]), collection: key, value: numericOperand, order: z.enum(["asc", "desc"]).default("desc") }).strict(),
  z.object({ ...stepBase, action: z.literal("collection.clear"), scope: z.enum(["workflow", "guild", "member"]), collection: key }).strict(),
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

export const interactiveWorkflowTriggerSchema = z.discriminatedUnion("event", [
  z.object({ id: key, event: z.enum(["button", "select", "modal_submit"]), componentKey: key, steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
  z.object({ id: key, event: z.literal("schedule"), intervalSeconds: z.number().int().min(60).max(604800), steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
  z.object({ id: key, event: z.literal("deadline"), afterSeconds: z.number().int().min(60).max(2_592_000), steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
  z.object({ id: key, event: z.literal("voice.member_join_event"), voiceChannelId: z.string().regex(/^\d{17,20}$/), steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
  z.object({ id: key, event: z.literal("voice.member_leave_event"), steps: z.array(interactiveWorkflowStepSchema).min(1).max(12) }).strict(),
]);

export const interactiveWorkflowDraftSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(80), title: z.string().min(1).max(80),
  description: z.string().max(1000), color: z.enum(["blue", "purple", "green", "red", "gray"]),
  components: z.array(z.discriminatedUnion("kind", [buttonComponent, selectComponent, modalComponent])).max(5),
  triggers: z.array(interactiveWorkflowTriggerSchema).min(1).max(15),
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
    for (const step of trigger.steps) if (step.action === "resource.channel.create_text" && step.categoryStepId) {
      const categoryStep = stepById.get(step.categoryStepId);
      if (!categoryStep || categoryStep.action !== "resource.channel.create_category") ctx.addIssue({ code: "custom", message: `Text channel ${step.id} references a missing category step.` });
      else if (!dependsOnAncestor(step.id, step.categoryStepId)) ctx.addIssue({ code: "custom", message: `Text channel ${step.id} must depend on category step ${step.categoryStepId}.` });
    }
    for (const step of trigger.steps) if (step.action === "role.grant" || step.action === "role.revoke") {
      const createdRole = trigger.steps.find((candidate) => candidate.action === "resource.role.create" && candidate.name === step.roleName);
      if (createdRole && !dependsOnAncestor(step.id, createdRole.id)) ctx.addIssue({ code: "custom", message: `Role operation ${step.id} must depend on Workflow role creation step ${createdRole.id}.` });
    }
    for (const step of trigger.steps) {
      const text = Object.values(step).filter((value): value is string => typeof value === "string").join("\n");
      for (const match of text.matchAll(/\{\{result:([a-z0-9._-]{1,40}):[a-z0-9._-]{1,40}\}\}/g)) requireResultDependency(step.id, match[1]!, `Step ${step.id}`);
      const conditions = conditionsOf(step.when);
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
    const panelMutationSteps = trigger.steps.filter((step) => step.action.startsWith("state.") || step.action.startsWith("collection.") || ["entry.join", "entry.leave", "resource.role.create", "resource.channel.create_category", "resource.channel.create_text", "giveaway.create", "giveaway.join", "giveaway.leave", "giveaway.end", "giveaway.pause", "giveaway.resume", "giveaway.reroll", "voice.channel.create", "voice.channel.delete"].includes(step.action));
    if (panelMutationSteps.length) {
      const refresh = trigger.steps.find((step) => step.action === "panel.refresh");
      if (!refresh) ctx.addIssue({ code: "custom", message: `Trigger ${trigger.id} must refresh its UI after changing Workflow-visible state/resources.` });
      else for (const mutation of panelMutationSteps) if (!dependsOnAncestor(refresh.id, mutation.id)) ctx.addIssue({ code: "custom", message: `Panel refresh in ${trigger.id} must depend on mutation ${mutation.id}.` });
    }
    if (trigger.event === "schedule" || trigger.event === "deadline") {
      for (const step of trigger.steps) {
        if (step.action === "entry.join" || step.action === "entry.leave" || step.action === "role.grant" || step.action === "role.revoke" || step.action === "voice.channel.create" || step.action === "voice.channel.delete" || step.action === "resource.role.create" || step.action === "resource.channel.create_category" || step.action === "resource.channel.create_text" || step.action.startsWith("giveaway.")) ctx.addIssue({ code: "custom", message: `Scheduled trigger cannot use member/resource action ${step.action}.` });
        if ((step.action.startsWith("state.") || step.action.startsWith("collection.")) && "scope" in step && step.scope === "member") ctx.addIssue({ code: "custom", message: "Scheduled triggers may not access member-scoped state or collections." });
        if (step.when && conditionUsesVoice(step.when)) ctx.addIssue({ code: "custom", message: "Scheduled triggers cannot evaluate VoiceState conditions." });
        if (step.when && conditionLeaves(step.when).some((condition) => condition.op === "member.has_role" || condition.op === "member.has_permission" || ("scope" in condition && condition.scope === "member"))) ctx.addIssue({ code: "custom", message: "Scheduled triggers cannot evaluate member-only conditions or member-scoped data." });
      }
      continue;
    }
    if (trigger.event === "voice.member_join_event" || trigger.event === "voice.member_leave_event") {
      const expectedAction = trigger.event === "voice.member_join_event" ? "voice.channel.create" : "voice.channel.delete";
      const forbiddenAction = trigger.event === "voice.member_join_event" ? "voice.channel.delete" : "voice.channel.create";
      if (!trigger.steps.some((step) => step.action === expectedAction)) ctx.addIssue({ code: "custom", message: `${trigger.event} must use ${expectedAction}.` });
      if (trigger.steps.some((step) => step.action === forbiddenAction)) ctx.addIssue({ code: "custom", message: `${trigger.event} cannot use ${forbiddenAction}.` });
      if (trigger.steps.some((step) => step.action === "resource.role.create" || step.action === "resource.channel.create_category" || step.action === "resource.channel.create_text" || step.action.startsWith("giveaway."))) ctx.addIssue({ code: "custom", message: "Resource and giveaway management actions are only available on explicit component/modal triggers." });
      continue;
    }
    for (const step of trigger.steps) {
      if (step.action === "voice.channel.create" || step.action === "voice.channel.delete") ctx.addIssue({ code: "custom", message: "Voice channel actions require VoiceState event triggers." });
      if (step.when && conditionUsesVoice(step.when)) ctx.addIssue({ code: "custom", message: "VoiceState conditions require VoiceState event triggers." });
      const requiredPermission = step.action === "resource.role.create" ? "ManageRoles"
        : step.action === "resource.channel.create_category" || step.action === "resource.channel.create_text" ? "ManageChannels"
          : step.action === "giveaway.create" || step.action === "giveaway.end" || step.action === "giveaway.reroll" || step.action === "giveaway.pause" || step.action === "giveaway.resume" ? "ManageRoles"
          : null;
      if (requiredPermission) {
        const conditions = step.when?.op === "and" ? step.when.conditions : [];
        if (step.when?.op !== "and") ctx.addIssue({ code: "custom", message: `Resource action ${step.action} must use an AND permission guard.` });
        if (!conditions.some((condition) => condition.op === "member.has_permission" && condition.permission === "ManageGuild")) ctx.addIssue({ code: "custom", message: `Resource action ${step.action} must guard with member.has_permission ManageGuild.` });
        if (!conditions.some((condition) => condition.op === "member.has_permission" && condition.permission === requiredPermission)) ctx.addIssue({ code: "custom", message: `Resource action ${step.action} must guard with member.has_permission ${requiredPermission}.` });
      }
    }
    if (triggerKeys.has(trigger.componentKey)) ctx.addIssue({ code: "custom", message: `Only one trigger may bind to component ${trigger.componentKey}.` });
    triggerKeys.add(trigger.componentKey);
    const component = componentByKey.get(trigger.componentKey);
    const expected = component?.kind === "button" ? "button" : component?.kind === "select" ? "select" : component?.kind === "modal" ? "modal_submit" : null;
    if (!component || expected !== trigger.event || component.triggerId !== trigger.id) ctx.addIssue({ code: "custom", message: `Trigger ${trigger.id} does not match its UI component.` });
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
      for (const step of trigger.steps) if (step.action === "giveaway.join") {
        const disabledWhen = component.disabledWhen;
        const hasGiveawayGuard = disabledWhen && (disabledWhen.op === "state.not_exists"
          ? disabledWhen.scope === "workflow" && disabledWhen.key === "active_giveaway_id"
          : disabledWhen.op === "and" || disabledWhen.op === "or"
            ? disabledWhen.conditions.some((condition) => condition.op === "state.not_exists" && condition.scope === "workflow" && condition.key === "active_giveaway_id")
            : false);
        if (!hasGiveawayGuard) ctx.addIssue({ code: "custom", message: `Giveaway join component ${component.key} must disable until active_giveaway_id exists.` });
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
export type InteractiveWorkflowTrigger = InteractiveWorkflow["triggers"][number];
export type InteractiveWorkflowStep = InteractiveWorkflowTrigger["steps"][number];
export type WorkflowComponent = InteractiveWorkflow["components"][number];

export function compileInteractiveWorkflow(input: unknown): InteractiveWorkflow {
  const workflow = interactiveWorkflowDraftSchema.parse(input);
  const compiled = structuredClone(workflow);
  const collections = new Set<string>();
  for (const trigger of compiled.triggers) {
    const mutationStepIds = trigger.steps.filter((step) => step.action.startsWith("state.") || step.action.startsWith("collection.") || ["entry.join", "entry.leave", "resource.role.create", "resource.channel.create_category", "resource.channel.create_text", "giveaway.create", "giveaway.join", "giveaway.leave", "giveaway.end", "giveaway.pause", "giveaway.resume", "giveaway.reroll", "voice.channel.create", "voice.channel.delete"].includes(step.action)).map((step) => step.id);
    for (const step of trigger.steps) if (step.action === "entry.join" || step.action === "entry.leave") collections.add(step.collection);
    const refresh = trigger.steps.find((step) => step.action === "panel.refresh");
    if (refresh) refresh.dependsOn = [...new Set([...refresh.dependsOn, ...mutationStepIds])];
    if (mutationStepIds.length && !trigger.steps.some((step) => step.action === "panel.refresh")) {
      const baseId = `refresh-${trigger.id}`.slice(0, 40);
      let id = baseId;
      let suffix = 1;
      while (trigger.steps.some((step) => step.id === id)) id = `${baseId.slice(0, 37)}-${suffix++}`;
      trigger.steps.push({ id, action: "panel.refresh", dependsOn: mutationStepIds });
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
