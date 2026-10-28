import type { WorkflowCondition } from "../../agent/interactive-workflow.js";
import { randomInt } from "node:crypto";

export type WorkflowConditionContext = {
  entries: Record<string, number>;
  states: Record<string, unknown>;
  collections?: Record<string, unknown[]>;
  results?: Record<string, unknown>;
  voice?: { memberCount: number; sessionExists: boolean };
  roleNames: ReadonlySet<string>;
  permissions: ReadonlySet<string>;
  ownerPermissions?: ReadonlySet<string>;
};

export function evaluateWorkflowCondition(condition: WorkflowCondition, context: WorkflowConditionContext): boolean {
  switch (condition.op) {
    case "and": return condition.conditions.every((child) => evaluateWorkflowCondition(child, context));
    case "or": return condition.conditions.some((child) => evaluateWorkflowCondition(child, context));
    case "entries.lt": return (context.entries[condition.collection] ?? 0) < condition.value;
    case "entries.gte": return (context.entries[condition.collection] ?? 0) >= condition.value;
    case "state.equals": return Object.is(context.states[`${condition.scope}:${condition.key}`], condition.value);
    case "number.eq": return typeof context.states[`${condition.scope}:${condition.key}`] === "number" && context.states[`${condition.scope}:${condition.key}`] === condition.value;
    case "number.gt": return typeof context.states[`${condition.scope}:${condition.key}`] === "number" && (context.states[`${condition.scope}:${condition.key}`] as number) > condition.value;
    case "number.gte": return typeof context.states[`${condition.scope}:${condition.key}`] === "number" && (context.states[`${condition.scope}:${condition.key}`] as number) >= condition.value;
    case "number.lt": return typeof context.states[`${condition.scope}:${condition.key}`] === "number" && (context.states[`${condition.scope}:${condition.key}`] as number) < condition.value;
    case "number.lte": return typeof context.states[`${condition.scope}:${condition.key}`] === "number" && (context.states[`${condition.scope}:${condition.key}`] as number) <= condition.value;
    case "string.equals": return context.states[`${condition.scope}:${condition.key}`] === condition.value;
    case "string.contains": return typeof context.states[`${condition.scope}:${condition.key}`] === "string" && (context.states[`${condition.scope}:${condition.key}`] as string).includes(condition.value);
    case "string.starts_with": return typeof context.states[`${condition.scope}:${condition.key}`] === "string" && (context.states[`${condition.scope}:${condition.key}`] as string).startsWith(condition.value);
    case "list.contains": {
      const list = condition.key ? context.states[`${condition.scope}:${condition.key}`] : context.collections?.[`${condition.scope}:${condition.collection}`];
      return Array.isArray(list) && list.some((item) => Object.is(item, condition.value));
    }
    case "state.exists": return Object.hasOwn(context.states, `${condition.scope}:${condition.key}`);
    case "state.not_exists": return !Object.hasOwn(context.states, `${condition.scope}:${condition.key}`);
    case "member.has_role": return context.roleNames.has(condition.roleName);
    case "member.has_permission": return context.permissions.has(condition.permission);
    case "workflow.owner_has_permission": return context.ownerPermissions?.has(condition.permission) === true;
    case "time.within": return Date.now() >= Date.parse(condition.startAt) && Date.now() < Date.parse(condition.endAt);
    case "random.chance": return randomInt(0, 10_000) < condition.percent * 100;
    case "result.equals": {
      const result = context.results?.[condition.stepId];
      return Boolean(result && typeof result === "object" && Object.is((result as Record<string, unknown>)[condition.field], condition.value));
    }
    case "voice.members.gte": return (context.voice?.memberCount ?? 0) >= condition.value;
    case "voice.members.eq": return (context.voice?.memberCount ?? 0) === condition.value;
    case "voice.session.exists": return context.voice?.sessionExists === true;
    case "not": return !evaluateWorkflowCondition(condition.condition, context);
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
