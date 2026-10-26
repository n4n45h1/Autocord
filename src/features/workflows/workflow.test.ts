import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MessageFlags } from "discord.js";
import { compileInteractiveWorkflow, interactiveWorkflowSchema, orderInteractiveWorkflowSteps } from "../../agent/interactive-workflow.js";
import { evaluateWorkflowCondition, renderWorkflowTemplate } from "./conditions.js";
import { renderInteractiveWorkflow } from "./render.js";

const signup = compileInteractiveWorkflow(JSON.parse(readFileSync(new URL("../../../examples/workflows/valorant-recruitment.json", import.meta.url), "utf8")));
const onboarding = interactiveWorkflowSchema.parse(JSON.parse(readFileSync(new URL("../../../examples/workflows/onboarding-consent.json", import.meta.url), "utf8")));

describe("generic interactive Workflow definitions", () => {
  it("accepts the recruitment UI/actions without feature-specific schema branches", () => {
    expect(signup.triggers.flatMap((trigger) => trigger.steps).map((step) => step.action)).toEqual(["entry.join", "panel.refresh", "entry.leave", "panel.refresh"]);
  });

  it("accepts consent and managed-role grant as a composed onboarding flow", () => {
    expect(onboarding.triggers[0]?.steps.map((step) => step.action)).toEqual(["state.set", "role.grant", "panel.refresh"]);
  });

  it("accepts persistent interval/deadline triggers and rejects member-only scheduled actions", () => {
    const recurring = interactiveWorkflowSchema.parse({ ...signup, triggers: [
      ...signup.triggers,
      { id: "daily-refresh", event: "schedule", intervalSeconds: 86400, steps: [{ id: "refresh", action: "panel.refresh" }] },
      { id: "close-deadline", event: "deadline", afterSeconds: 86400, steps: [{ id: "close-message", action: "message.send", content: "募集を締め切りました。" }] },
    ] });
    expect(recurring.triggers.filter((trigger) => trigger.event === "schedule" || trigger.event === "deadline")).toHaveLength(2);
    expect(interactiveWorkflowSchema.safeParse({ ...signup, triggers: [
      ...signup.triggers,
      { id: "scheduled-role", event: "schedule", intervalSeconds: 3600, steps: [{ id: "grant", action: "role.grant", roleName: "Member" }] },
    ] }).success).toBe(false);
  });

  it("binds Modal submit fields to a typed Workflow trigger", () => {
    const modal = interactiveWorkflowSchema.parse({
      version: 1, name: "Reason form", title: "Reason", description: "Describe your request", color: "purple",
      components: [{ key: "reason_form", kind: "modal", label: "Open form", title: "Request", triggerId: "submit_reason", inputs: [{ key: "reason", label: "Reason", placeholder: null, style: "paragraph", required: true, maxLength: 500 }] }],
      triggers: [{ id: "submit_reason", event: "modal_submit", componentKey: "reason_form", steps: [{ id: "save_reason", action: "state.set", scope: "member", key: "request_reason", value: "{{input:reason}}" }] }],
    });
    expect(modal.triggers[0]?.event).toBe("modal_submit");
  });

  it("orders stable step IDs by dependency and rejects cycles", () => {
    const ordered = orderInteractiveWorkflowSteps([
      { id: "finish", dependsOn: ["join"], action: "panel.refresh" },
      { id: "join", dependsOn: [], action: "entry.join" },
    ]);
    expect(ordered.map((step) => step.id)).toEqual(["join", "finish"]);
    const cyclic = structuredClone(signup);
    cyclic.triggers[0]!.steps[0]!.dependsOn = ["refresh"];
    cyclic.triggers[0]!.steps[1]!.dependsOn = ["register"];
    expect(interactiveWorkflowSchema.safeParse(cyclic).success).toBe(false);
  });

  it("requires explicit dependencies before reading a previous step result", () => {
    const withResult = structuredClone(signup);
    withResult.triggers[0]!.steps = [
      { id: "register", dependsOn: [], action: "entry.join", collection: "participants", maxEntries: 5 },
      { id: "notify", dependsOn: ["register"], action: "message.send", content: "Count {{result:register:count}}" },
      { id: "refresh", dependsOn: ["register"], action: "panel.refresh" },
    ];
    expect(interactiveWorkflowSchema.safeParse(withResult).success).toBe(true);
    withResult.triggers[0]!.steps[1]!.dependsOn = [];
    expect(interactiveWorkflowSchema.safeParse(withResult).success).toBe(false);
  });

  it("compiles generic entry invariants into count display and panel refresh steps", () => {
    const compiled = compileInteractiveWorkflow({
      version: 1, name: "Recruitment", title: "Recruitment", description: "Join here", color: "blue",
      components: [{ key: "join", kind: "button", label: "Join", style: "primary", emoji: null, triggerId: "join-trigger", disabledWhen: { op: "entries.gte", collection: "players", value: 5 } }],
      triggers: [{ id: "join-trigger", event: "button", componentKey: "join", steps: [{ id: "register", action: "entry.join", collection: "players", maxEntries: 5 }] }],
    });
    expect(compiled.description).toContain("{{entries:players:count}}");
    expect(compiled.triggers[0]?.steps.map((step) => step.action)).toEqual(["entry.join", "panel.refresh"]);
  });

  it("normalizes entry triggers with a display-count and panel refresh", () => {
    const invalid = structuredClone(signup);
    invalid.components[0] = { ...invalid.components[0]!, kind: "button", key: "join", label: "参加", style: "success", emoji: null, triggerId: "join-trigger" } as typeof invalid.components[number];
    invalid.triggers[0]!.steps = [{ id: "register", dependsOn: [], action: "entry.join", collection: "participants", maxEntries: 5 }];
    const compiled = compileInteractiveWorkflow(invalid);
    expect(compiled.description).toContain("{{entries:participants:count}}");
    expect(compiled.triggers[0]?.steps.map((step) => step.action)).toEqual(["entry.join", "panel.refresh"]);
  });

  it("renders a Components V2 container and evaluates the cap condition", () => {
    const rendered = renderInteractiveWorkflow("workflow-id", signup, { entries: { participants: 5 }, states: {}, roleNames: new Set(), permissions: new Set() });
    const root = JSON.parse(JSON.stringify(rendered.components?.[0])) as { type: number; components: { type: number; components?: { type: number; disabled?: boolean }[]; accessory?: { disabled?: boolean; custom_id?: string } }[] };
    expect(rendered.flags).toBe(MessageFlags.IsComponentsV2);
    const join = root.components.find((component) => component.accessory?.custom_id?.endsWith(":join"));
    expect(join?.accessory?.disabled).toBe(true);
    expect(evaluateWorkflowCondition(signup.components[0]!.disabledWhen!, { entries: { participants: 5 }, states: {}, roleNames: new Set(), permissions: new Set() })).toBe(true);
  });

  it("renders scoped state/input templates as data, not executable expressions", () => {
    expect(renderWorkflowTemplate("count={{entries:participants:count}} state={{state:member:consent}} input={{input:reason}}", {
      entries: { participants: 3 }, states: { "member:consent": true }, inputs: { reason: "OK" }, selected: [], actorId: "u1",
    })).toBe("count=3 state=true input=OK");
    expect(renderWorkflowTemplate("registered={{result:register:joined}}", {
      entries: {}, states: {}, results: { register: { joined: true } }, selected: [], inputs: {},
    })).toBe("registered=true");
  });

  it("evaluates bounded time-window predicates in the condition DSL", () => {
    const now = Date.now();
    expect(evaluateWorkflowCondition({ op: "time.within", startAt: new Date(now - 1000).toISOString(), endAt: new Date(now + 1000).toISOString() }, {
      entries: {}, states: {}, roleNames: new Set(), permissions: new Set(),
    })).toBe(true);
    expect(evaluateWorkflowCondition({ op: "and", conditions: [
      { op: "entries.lt", collection: "participants", value: 5 },
      { op: "time.within", startAt: new Date(now - 1000).toISOString(), endAt: new Date(now - 500).toISOString() },
    ] }, { entries: { participants: 1 }, states: {}, roleNames: new Set(), permissions: new Set() })).toBe(false);
  });
});
