import { compileMaxWorkflow, maxAgentWorkflowSchema, maxWorkflowSchema, orderResourceSteps, resourceWorkflowSchema } from "../workflow.js";
import { compileInteractiveWorkflow } from "../interactive-workflow.js";
import { authorizedSideEffectKinds, type RequirementGraph } from "./intent.js";
import { capabilityOutputFields } from "./capabilities.js";
import type { WorkflowCandidate } from "./synthesizer.js";
import { critiqueWorkflow } from "./critic.js";
import type { InteractiveWorkflow } from "../interactive-workflow.js";

export type VerificationResult = {
  valid: boolean;
  target: WorkflowCandidate["target"];
  workflow: unknown;
  issues: string[];
  coverage: { requirementId: string; status: "mapped_unverified" | "satisfied_by_adapter" | "uncovered"; workflowElementIds: string[]; adapterCapabilities: string[] }[];
  semanticChecks: { requirementId: string; status: "unverified"; reason: string }[];
  scenarios: ReturnType<typeof critiqueWorkflow>["scenarios"];
  unresolved: string[];
  sideEffects: { elementId: string; kind: string; authorizedBy: string[]; requiredAuxiliary: boolean }[];
  cost: { actionCount: number; triggerCount: number; dependencyEdges: number };
};

export type VerificationContext = { managedRoles?: string[]; staffRoleIds?: string[]; channelIds?: string[]; voiceChannelIds?: string[]; existingWorkflow?: InteractiveWorkflow };
type WorkflowStepRef = { id: string; dependsOn: string[]; action: string; name?: unknown; roleName?: unknown; staffRoleId?: unknown };
type TriggerRef = { id: string; event: string; voiceChannelId?: unknown; channelId?: unknown; roleId?: unknown; steps: WorkflowStepRef[] };
type SideEffect = { elementId: string; kind: typeof authorizedSideEffectKinds[number]; requiredAuxiliary?: boolean; linkedElementId?: string };

function actionSideEffects(step: Record<string, unknown>): SideEffect[] {
  const action = String(step.action);
  const id = String(step.id);
  if (action === "message.send") return [{ elementId: id, kind: step.delivery === "workflow_owner_dm" ? "discord.dm.send" : step.delivery === "workflow_channel_step" ? "discord.private_channel.message.send" : "discord.message.send" }];
  if (action === "message.dm") return [{ elementId: id, kind: "discord.dm.send" }];
  if (action === "message.reply") return [{ elementId: id, kind: "discord.message.send" }];
  if (action === "message.edit" || action === "message.pin" || action === "message.unpin") return [{ elementId: id, kind: "discord.message.update" }];
  if (action === "message.delete") return [{ elementId: id, kind: "discord.message.delete" }];
  if (action === "panel.refresh") return [{ elementId: id, kind: "ui.panel.update" }];
  if (action === "state.set" || action === "state.increment" || action === "state.decrement" || action === "state.multiply" || action === "state.debit" || action === "state.delete" || action === "state.reset" || action === "state.append" || action === "state.remove") return [{ elementId: id, kind: "data.state.write" }];
  if (action === "collection.add" || action === "collection.remove" || action === "collection.clear") return [{ elementId: id, kind: "data.collection.write" }];
  if (action === "entry.join" || action === "entry.leave") return [{ elementId: id, kind: "data.entry.write" }];
  if (action.startsWith("giveaway.")) return [{ elementId: id, kind: "data.giveaway.write" }];
  if (action === "role.grant") return [{ elementId: id, kind: "discord.role.grant" }];
  if (action === "role.revoke") return [{ elementId: id, kind: "discord.role.revoke" }];
  if (action === "role.rename") return [{ elementId: id, kind: "discord.role.update" }];
  if (action === "resource.role.create" || action === "role.create") return [{ elementId: id, kind: "discord.role.create" }];
  if (action === "resource.channel.create_category" || action === "resource.channel.create_text" || action === "channel.create_category" || action === "channel.create_text" || action === "channel.create_voice") return [{ elementId: id, kind: "discord.channel.create" }];
  if (action === "channel.rename") return [{ elementId: id, kind: "discord.channel.update" }];
  if (action === "channel.delete") return [{ elementId: id, kind: "discord.channel.delete" }];
  if (action === "channel.set_permission") return [{ elementId: id, kind: "discord.permission.update" }];
  if (action === "channel.move_member" || action === "channel.move_members") return [{ elementId: id, kind: "discord.member.move" }];
  if (action === "channel.delete_empty") return [{ elementId: id, kind: "discord.channel.delete" }];
  if (action === "voice.channel.create") return [{ elementId: id, kind: "discord.voice.create" }];
  if (action === "voice.channel.delete") return [{ elementId: id, kind: "discord.voice.delete" }];
  if (action === "workflow.wait") return [{ elementId: id, kind: "scheduler.create" }];
  if (action === "option.add") return [{ elementId: id, kind: "ui.panel.update" }, { elementId: id, kind: "discord.role.create" }];
  if (action === "option.rename_role") return [{ elementId: id, kind: "ui.panel.update" }, { elementId: id, kind: "discord.role.update" }];
  if (action.startsWith("option.") || action.startsWith("panel.")) return [{ elementId: id, kind: "ui.panel.update" }];
  return [];
}

function candidateSideEffects(candidate: WorkflowCandidate, normalized: unknown, context: VerificationContext): SideEffect[] {
  const effects: SideEffect[] = [];
  if (candidate.target === "interactive" && normalized && typeof normalized === "object" && "workflow" in normalized) {
    const workflow = (normalized as { workflow: InteractiveWorkflow }).workflow;
    const prior = context.existingWorkflow;
    for (const component of workflow.components) {
      const old = prior?.components.find((item) => item.key === component.key);
      if (!old || JSON.stringify(old) !== JSON.stringify(component)) effects.push({ elementId: component.key, kind: old ? "ui.panel.update" : "ui.component.create" });
    }
    for (const trigger of workflow.triggers) {
      if (["schedule", "schedule.at", "deadline"].includes(trigger.event)) {
        const old = prior?.triggers.find((item) => item.id === trigger.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(trigger)) effects.push({ elementId: trigger.id, kind: "scheduler.create" });
      }
      const generatedRefreshId = `refresh-${trigger.id}`.slice(0, 40);
      for (const step of trigger.steps) effects.push(...actionSideEffects(step as unknown as Record<string, unknown>).map((effect) => ({
        ...effect,
        requiredAuxiliary: step.action === "panel.refresh" && step.id === generatedRefreshId,
        ...(step.action === "panel.refresh" && step.id === generatedRefreshId ? { linkedElementId: trigger.id } : {}),
      })));
    }
  } else if (candidate.target === "resources" && normalized && typeof normalized === "object" && "workflow" in normalized) {
    const workflow = (normalized as { workflow: { steps: Record<string, unknown>[] } }).workflow;
    for (const step of workflow.steps) effects.push(...actionSideEffects(step));
  } else if (candidate.target === "panel" && normalized && typeof normalized === "object" && "workflow" in normalized) {
    const workflow = (normalized as { workflow: { operations: Record<string, unknown>[] } }).workflow;
    for (const operation of workflow.operations) effects.push(...actionSideEffects(operation));
  }
  return effects;
}

function authorizeSideEffects(graph: RequirementGraph, effects: SideEffect[], coverage: { requirementId: string; workflowElementIds: string[] }[]): { issues: string[]; effects: { elementId: string; kind: string; authorizedBy: string[]; requiredAuxiliary: boolean }[] } {
  const issues: string[] = [];
  const requirements = new Map(graph.requirements.map((requirement) => [requirement.id, requirement]));
  const actualCounts = new Map<string, number>();
  const limitByKind = new Map<string, number>();
  const authorizedRequirementKinds = new Set<string>();
  const details = effects.map((effect) => {
    if (!effect.requiredAuxiliary) actualCounts.set(effect.kind, (actualCounts.get(effect.kind) ?? 0) + 1);
    const mappings = coverage.filter((item) => item.workflowElementIds.includes(effect.elementId) || effect.linkedElementId && item.workflowElementIds.includes(effect.linkedElementId));
    const authorized = mappings.filter((mapping) => requirements.get(mapping.requirementId)?.authorizedSideEffects.includes(effect.kind));
    if (!authorized.length && !effect.requiredAuxiliary) issues.push(`Unauthorized side effect ${effect.kind} at ${effect.elementId}: no traced Requirement authorizes it.`);
    const forbiddenBy = graph.requirements.filter((requirement) => requirement.forbiddenSideEffectKinds.includes(effect.kind));
    if (forbiddenBy.length) issues.push(`Forbidden side effect ${effect.kind} at ${effect.elementId} violates ${forbiddenBy.map((item) => item.id).join(", ")}.`);
    for (const mapping of authorized) authorizedRequirementKinds.add(`${mapping.requirementId}:${effect.kind}`);
    return { ...effect, authorizedBy: [...authorized.map((item) => item.requirementId), ...(effect.requiredAuxiliary ? ["required runtime panel refresh"] : [])], requiredAuxiliary: effect.requiredAuxiliary === true };
  });
  for (const entry of authorizedRequirementKinds) {
    const separator = entry.lastIndexOf(":");
    const requirementId = entry.slice(0, separator);
    const kind = entry.slice(separator + 1);
    const requirement = requirements.get(requirementId)!;
    const configured = requirement.sideEffectLimits.find((limit) => limit.kind === kind)?.maxCount ?? 1;
    limitByKind.set(kind, (limitByKind.get(kind) ?? 0) + configured);
  }
  for (const [kind, count] of actualCounts) {
    const limit = limitByKind.get(kind) ?? 0;
    if (count > limit) issues.push(`Side effect budget exceeded for ${kind}: candidate has ${count}, RequirementGraph authorizes ${limit}.`);
  }
  for (const requirement of graph.requirements) {
    for (const effect of requirement.requiredSideEffects) {
      if (!requirement.authorizedSideEffects.includes(effect)) issues.push(`${requirement.id} requires ${effect} but does not authorize it.`);
      if (!details.some((candidate) => candidate.kind === effect && candidate.authorizedBy.includes(requirement.id))) issues.push(`${requirement.id} requires side effect ${effect}, but no traced Workflow element performs it.`);
    }
    for (const limit of requirement.sideEffectLimits) if (!requirement.authorizedSideEffects.includes(limit.kind)) issues.push(`${requirement.id} sets a side-effect limit for unauthorized category ${limit.kind}.`);
  }
  return { issues, effects: details };
}

function validateResultReferences(workflow: unknown): string[] {
  const issues: string[] = [];
  const steps = new Map<string, WorkflowStepRef>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.action === "string") steps.set(record.id, record as unknown as WorkflowStepRef);
    Object.values(record).forEach(collect);
  };
  collect(workflow);
  const check = (stepId: string, field: string) => {
    const source = steps.get(stepId);
    if (!source) issues.push(`Result reference points to missing step ${stepId}.`);
    else if (capabilityOutputFields[source.action] && !capabilityOutputFields[source.action]!.includes(field)) issues.push(`Action ${source.action} does not produce result field ${field} (referenced by ${stepId}).`);
  };
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{\{result:([a-z0-9._-]+):([A-Za-z0-9._-]+)\}\}/g)) check(match[1]!, match[2]!);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.op === "result.equals" && typeof record.stepId === "string" && typeof record.field === "string") check(record.stepId, record.field);
      Object.values(record).forEach(visit);
    }
  };
  visit(workflow);
  return [...new Set(issues)];
}

export function verifyCandidate(graph: RequirementGraph, candidate: WorkflowCandidate, permittedCapabilities?: ReadonlySet<string>, context: VerificationContext = {}): VerificationResult {
  const issues: string[] = [];
  let normalized: unknown;
  let scenarios: VerificationResult["scenarios"] = [];
  let unresolved: string[] = [];
  try {
    normalized = maxAgentWorkflowSchema.parse({ target: candidate.target, workflow: candidate.workflow });
    if (candidate.target === "interactive") {
      const critique = critiqueWorkflow(candidate.workflow);
      normalized = { target: candidate.target, workflow: critique.workflow };
      issues.push(...critique.issues);
      scenarios = critique.scenarios;
      unresolved = critique.unresolved;
    }
    if (candidate.target === "panel") compileMaxWorkflow(undefined, candidate.workflow);
    if (candidate.target === "resources") {
      const resourcePlan = resourceWorkflowSchema.parse(candidate.workflow);
      orderResourceSteps(resourcePlan.steps);
    }
    issues.push(...validateResultReferences(candidate.workflow));
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const actionStepIds = new Set<string>();
  const traceIds = new Set<string>();
  let actionCount = 0;
  let triggerCount = 0;
  let dependencyEdges = 0;
  if (candidate.target === "interactive" && normalized && typeof normalized === "object" && "workflow" in normalized) {
    const workflow = (normalized as { workflow: { triggers: TriggerRef[] } }).workflow;
    const compiledWorkflow = workflow as unknown as { components?: { key: string }[] };
    for (const component of compiledWorkflow.components ?? []) traceIds.add(component.key);
    triggerCount = workflow.triggers.length;
    const entryCollections = new Set(workflow.triggers.flatMap((trigger) => trigger.steps.filter((step) => step.action === "entry.join" || step.action === "entry.leave").map((step) => (step as unknown as { collection: string }).collection)));
    for (const step of workflow.triggers.flatMap((trigger) => trigger.steps)) if (step.action === "collection.count" && entryCollections.has((step as unknown as { collection: string }).collection)) issues.push(`collection.count(${(step as unknown as { collection: string }).collection}) cannot observe entry.join/entry.leave records; those capabilities use separate persistent stores.`);
    for (const trigger of workflow.triggers) {
      traceIds.add(trigger.id);
      if (permittedCapabilities && !permittedCapabilities.has(`trigger:${trigger.event}`)) issues.push(`Unselected trigger capability used: ${trigger.event}`);
      if (typeof trigger.voiceChannelId === "string" && context.voiceChannelIds && !context.voiceChannelIds.includes(trigger.voiceChannelId)) issues.push(`Voice trigger source ${trigger.voiceChannelId} is not in trusted Guild context.`);
      if (typeof trigger.channelId === "string" && trigger.channelId !== "workflow_channel" && /^\d{17,20}$/.test(trigger.channelId) && context.channelIds && !context.channelIds.includes(trigger.channelId)) issues.push(`Trigger channel ${trigger.channelId} is not in trusted Guild context.`);
      if (typeof trigger.roleId === "string" && context.staffRoleIds && !context.staffRoleIds.includes(trigger.roleId)) issues.push(`Trigger role ${trigger.roleId} is not in trusted Guild context.`);
      for (const step of trigger.steps) {
        if (step.action !== "panel.refresh" && permittedCapabilities && !permittedCapabilities.has(`action:${step.action}`)) issues.push(`Unselected action capability used: ${step.action}`);
        if (typeof step.staffRoleId === "string" && context.staffRoleIds && !context.staffRoleIds.includes(step.staffRoleId)) issues.push(`Staff Role ${step.staffRoleId} is not in trusted Guild context.`);
        if (typeof step.roleName === "string" && ["role.grant", "role.revoke", "role.rename", "role.member_count"].includes(step.action) && context.managedRoles && !context.managedRoles.includes(step.roleName)
          && !workflow.triggers.some((candidateTrigger) => candidateTrigger.steps.some((candidateStep) => candidateStep.action === "resource.role.create" && candidateStep.name === step.roleName))) issues.push(`Role ${step.roleName} is not Workflow-managed or newly created by this candidate.`);
        const generatedRefreshId = `refresh-${trigger.id}`.slice(0, 40);
        if (step.action !== "panel.refresh" || step.id !== generatedRefreshId) { actionStepIds.add(step.id); traceIds.add(step.id); }
        actionCount++; dependencyEdges += step.dependsOn.length;
      }
    }
  } else if (candidate.target === "resources" && normalized && typeof normalized === "object" && "workflow" in normalized) {
    const workflow = (normalized as { workflow: { steps: WorkflowStepRef[] } }).workflow;
    for (const step of workflow.steps) { if (permittedCapabilities && !permittedCapabilities.has(`action:${step.action}`)) issues.push(`Unselected action capability used: ${step.action}`); actionStepIds.add(step.id); traceIds.add(step.id); actionCount++; dependencyEdges += step.dependsOn.length; }
  } else if (candidate.target === "panel" && normalized && typeof normalized === "object" && "workflow" in normalized) {
    const workflow = maxWorkflowSchema.parse((normalized as { workflow: unknown }).workflow);
    for (const step of workflow.operations) { if (permittedCapabilities && !permittedCapabilities.has(`action:${step.action}`)) issues.push(`Unselected action capability used: ${step.action}`); actionStepIds.add(step.id); traceIds.add(step.id); actionCount++; dependencyEdges += step.dependsOn.length; }
  }
  const covered = new Map(candidate.coverage.map((entry) => [entry.requirementId, entry]));
  const coverage = graph.requirements.map((requirement) => {
    const mapping = covered.get(requirement.id);
    const ids = mapping?.workflowElementIds ?? [];
    const adapters = mapping?.adapterCapabilities ?? [];
    const dangling = ids.filter((id) => !traceIds.has(id));
    if (dangling.length) issues.push(`${requirement.id} maps to unknown step(s): ${dangling.join(", ")}`);
    const allowedAdapters = new Set(requirement.authorizedAdapters);
    const adapterSatisfied = requirement.fulfillmentLayer === "approval_adapter" && adapters.length > 0 && adapters.every((adapter) => allowedAdapters.has(adapter));
    if (adapters.some((adapter) => !allowedAdapters.has(adapter))) issues.push(`${requirement.id} maps to an application adapter that does not implement the cited outcome.`);
    if (adapters.length && requirement.fulfillmentLayer !== "approval_adapter") issues.push(`${requirement.id} is a Workflow requirement and cannot be satisfied by an application adapter.`);
    if (requirement.fulfillmentLayer === "approval_adapter" && !adapterSatisfied) issues.push(`${requirement.id} requires an explicit application-adapter mapping.`);
    const satisfied = ids.length > 0 && !dangling.length || adapterSatisfied;
    if (requirement.importance === "hard" && !satisfied) issues.push(`${requirement.id} is a hard requirement with no candidate trace mapping.`);
    return { requirementId: requirement.id, status: adapterSatisfied ? "satisfied_by_adapter" as const : ids.length && !dangling.length ? "mapped_unverified" as const : "uncovered" as const, workflowElementIds: dangling.length ? [] : ids, adapterCapabilities: adapters };
  });
  for (const mapping of candidate.coverage) if (!graph.requirements.some((requirement) => requirement.id === mapping.requirementId)) issues.push(`Coverage references unknown requirement ${mapping.requirementId}.`);
  const mappedSteps = new Set(candidate.coverage.flatMap((mapping) => mapping.workflowElementIds));
  for (const stepId of actionStepIds) if (!mappedSteps.has(stepId)) issues.push(`Step ${stepId} has no traceable RequirementGraph justification.`);
  const sideEffectCheck = authorizeSideEffects(graph, candidateSideEffects(candidate, normalized, context), candidate.coverage);
  issues.push(...sideEffectCheck.issues);
  const hardMissing = graph.requirements.filter((requirement) => requirement.importance === "hard" && !coverage.find((entry) => entry.requirementId === requirement.id)?.status.match(/^(?:mapped_unverified|satisfied_by_adapter)$/));
  if (hardMissing.length) issues.push(`Hard requirements remain uncovered: ${hardMissing.map((item) => item.id).join(", ")}`);
  const semanticChecks = graph.requirements.map((requirement) => ({ requirementId: requirement.id, status: "unverified" as const, reason: "Semantic satisfaction cannot be proven by schema and graph checks alone." }));
  return { valid: issues.length === 0 && hardMissing.length === 0, target: candidate.target, workflow: normalized, issues, coverage, semanticChecks, scenarios, unresolved, sideEffects: sideEffectCheck.effects, cost: { actionCount, triggerCount, dependencyEdges } };
}
