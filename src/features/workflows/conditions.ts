import type { WorkflowCondition } from "../../agent/interactive-workflow.js";

export type WorkflowConditionContext = {
  entries: Record<string, number>;
  states: Record<string, unknown>;
  results?: Record<string, unknown>;
  roleNames: ReadonlySet<string>;
  permissions: ReadonlySet<string>;
};

export function evaluateWorkflowCondition(condition: WorkflowCondition, context: WorkflowConditionContext): boolean {
  switch (condition.op) {
    case "and": return condition.conditions.every((child) => evaluateWorkflowCondition(child, context));
    case "or": return condition.conditions.some((child) => evaluateWorkflowCondition(child, context));
    case "entries.lt": return (context.entries[condition.collection] ?? 0) < condition.value;
    case "entries.gte": return (context.entries[condition.collection] ?? 0) >= condition.value;
    case "state.equals": return Object.is(context.states[`${condition.scope}:${condition.key}`], condition.value);
    case "member.has_role": return context.roleNames.has(condition.roleName);
    case "member.has_permission": return context.permissions.has(condition.permission);
    case "time.within": return Date.now() >= Date.parse(condition.startAt) && Date.now() < Date.parse(condition.endAt);
    case "result.equals": {
      const result = context.results?.[condition.stepId];
      return Boolean(result && typeof result === "object" && Object.is((result as Record<string, unknown>)[condition.field], condition.value));
    }
  }
}

export function renderWorkflowTemplate(template: string, values: { entries: Record<string, number>; states: Record<string, unknown>; results?: Record<string, unknown>; inputs?: Record<string, string>; selected?: readonly string[]; actorId?: string }): string {
  return template.replace(/\{\{(entries|state|result|input|selected|actor)(?::([^}:]+))?(?::([^}]+))?\}\}/g, (_match, kind: string, first?: string, second?: string) => {
    if (kind === "actor") return values.actorId ? `<@${values.actorId}>` : "";
    if (kind === "entries") return String(values.entries[first ?? ""] ?? 0);
    if (kind === "state") {
      const value = values.states[`${first ?? "workflow"}:${second ?? ""}`];
      return value === undefined || value === null ? "" : String(value);
    }
    if (kind === "result") {
      const result = values.results?.[first ?? ""];
      const value = result && typeof result === "object" ? (result as Record<string, unknown>)[second ?? ""] : undefined;
      return value === undefined || value === null ? "" : String(value);
    }
    if (kind === "input") return values.inputs?.[first ?? ""] ?? "";
    if (kind === "selected") return values.selected?.[Number(first ?? 0)] ?? "";
    return "";
  });
}
