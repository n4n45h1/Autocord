import { describe, expect, it } from "vitest";
import { compileInteractiveWorkflow, type InteractiveWorkflow } from "../interactive-workflow.js";
import type { RequirementGraph } from "./intent.js";
import { makeReasonerPlan } from "./orchestrator.js";
import { runDryRun } from "./simulator.js";
import type { WorkflowCandidate } from "./synthesizer.js";
import { verifyCandidate } from "./verifier.js";
import { interactiveWorkflowSummary } from "../../features/workflows/preview.js";

function requirements(request: string, statements: { id: string; kind: RequirementGraph["requirements"][number]["kind"]; statement: string; quote: string; effects: RequirementGraph["requirements"][number]["authorizedSideEffects"]; success: string }[]): RequirementGraph {
  return {
    version: 1, target: "interactive", contradictions: [],
    requirements: statements.map((item) => ({
      id: item.id, kind: item.kind, fulfillmentLayer: "workflow", statement: item.statement,
      source: { quote: item.quote, start: null, end: null }, importance: "hard", certainty: "explicit",
      authorizedAdapters: [],
      dependsOn: [], missingInformation: [], successCondition: item.success, forbiddenSideEffects: [],
      authorizedSideEffects: item.effects, requiredSideEffects: item.effects, sideEffectLimits: item.effects.map((kind) => ({ kind, maxCount: 8 })), forbiddenSideEffectKinds: [],
    })),
  };
}

function plan(workflow: unknown, coverage: WorkflowCandidate["coverage"]): WorkflowCandidate {
  return { target: "interactive", workflow, coverage };
}

describe("ARE requested workflow cases", () => {
  it("Test 1: keeps a single inquiry form private and creates no DM or role side effect", () => {
    const request = "Create one inquiry form and store the submitted detail for staff review.";
    const graph = requirements(request, [
      { id: "r01", kind: "input", statement: "One inquiry form accepts a detail field", quote: "one inquiry form", effects: ["ui.component.create"], success: "The member can submit one form" },
      { id: "r02", kind: "state", statement: "Store the submitted detail", quote: "store the submitted detail", effects: ["data.state.write"], success: "The detail is persisted" },
    ]);
    const candidate = plan({
      version: 1, name: "Inquiry", title: "Inquiry", description: "Submit a private inquiry", color: "blue",
      components: [{ key: "inquiry", kind: "modal", label: "Inquiry", triggerId: "submit", title: "Inquiry", inputs: [{ key: "detail", label: "Detail", placeholder: null, style: "paragraph", required: true, maxLength: 1000 }] }],
      triggers: [{ id: "submit", event: "modal_submit", componentKey: "inquiry", steps: [{ id: "save", action: "state.set", scope: "member", key: "inquiry_detail", value: "{{input:detail}}", dependsOn: [] }] }],
    }, [
      { requirementId: "r01", workflowElementIds: ["inquiry", "submit"], adapterCapabilities: [], rationale: "The form component collects the requested field." },
      { requirementId: "r02", workflowElementIds: ["save"], adapterCapabilities: [], rationale: "The submission is persisted per member." },
    ]);
    const result = verifyCandidate(graph, candidate, new Set(["trigger:modal_submit", "action:state.set", "action:panel.refresh"]));
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    expect(result.sideEffects.map((effect) => effect.kind)).not.toContain("discord.dm.send");
    expect(result.sideEffects.map((effect) => effect.kind)).not.toContain("discord.role.create");
    const summary = interactiveWorkflowSummary((result.workflow as { workflow: InteractiveWorkflow }).workflow);
    expect(summary).toContain("1 Discord buttons: 0 regular + 1 Modal launchers");
    expect(summary).toContain("DMs sent=none");
    expect(summary).not.toContain("DM: ");
  });

  it("Test 2: routes ticket form content only to a configured staff-only channel", () => {
    const roleId = "12345678901234567";
    const request = "Create a staff-only ticket and post the submitted detail in that channel.";
    const graph = requirements(request, [
      { id: "r01", kind: "effect", statement: "Create one private staff channel", quote: "staff-only ticket", effects: ["ui.component.create", "discord.channel.create"], success: "A staff-only channel is created" },
      { id: "r02", kind: "output", statement: "Post the detail in that private channel", quote: "post the submitted detail in that channel", effects: ["discord.private_channel.message.send"], success: "The detail appears only in the staff ticket" },
    ]);
    const candidate = plan({
      version: 1, name: "Ticket", title: "Ticket", description: "Private staff support", color: "purple",
      components: [{ key: "ticket", kind: "modal", label: "Open ticket", triggerId: "submit", title: "Support", inputs: [{ key: "detail", label: "Detail", placeholder: null, style: "paragraph", required: true, maxLength: 1000 }] }],
      triggers: [{ id: "submit", event: "modal_submit", componentKey: "ticket", steps: [
        { id: "create", action: "channel.create_text", name: "ticket", topic: null, visibility: "staff_only", staffRoleId: roleId, dependsOn: [] },
        { id: "post", action: "message.send", delivery: "workflow_channel_step", channelStepId: "create", content: "{{input:detail}}", dependsOn: ["create"] },
      ] }],
    }, [
      { requirementId: "r01", workflowElementIds: ["ticket", "submit", "create"], adapterCapabilities: [], rationale: "The modal opens a configured private ticket." },
      { requirementId: "r02", workflowElementIds: ["post"], adapterCapabilities: [], rationale: "The content is bound to that exact private channel." },
    ]);
    const result = verifyCandidate(graph, candidate, new Set(["trigger:modal_submit", "action:channel.create_text", "action:message.send", "action:panel.refresh"]), { staffRoleIds: [roleId] });
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    expect(result.sideEffects.some((effect) => effect.kind === "discord.dm.send")).toBe(false);
    expect(result.sideEffects.some((effect) => effect.kind === "discord.private_channel.message.send" && effect.authorizedBy.includes("r02"))).toBe(true);
  });

  it("Test 3: uses atomic entry registration rather than a client-only capacity guard", () => {
    const workflow = compileInteractiveWorkflow({
      version: 1, name: "Capped", title: "Capped", description: "Five places", color: "green",
      components: [{ key: "join", kind: "button", label: "Join", style: "success", emoji: null, disabledWhen: { op: "entries.gte", collection: "people", value: 5 }, triggerId: "join" }],
      triggers: [{ id: "join", event: "button", componentKey: "join", steps: [{ id: "register", action: "entry.join", collection: "people", maxEntries: 5, dependsOn: [] }] }],
    });
    expect(workflow.triggers[0]?.steps.find((step) => step.action === "entry.join")).toMatchObject({ maxEntries: 5 });
    expect(workflow.components[0]?.disabledWhen).toEqual({ op: "entries.gte", collection: "people", value: 5 });
  });

  it("Test 4: composes button registration, owner-authorized VC creation, bounded participant movement, and empty cleanup", () => {
    const managerVoiceGuard = { op: "and", conditions: [
      { op: "workflow.owner_has_permission", permission: "ManageGuild" },
      { op: "workflow.owner_has_permission", permission: "ManageChannels" },
    ] } as const;
    const moveGuard = { op: "and", conditions: [
      { op: "workflow.owner_has_permission", permission: "ManageGuild" },
      { op: "workflow.owner_has_permission", permission: "MoveMembers" },
    ] } as const;
    const workflow = compileInteractiveWorkflow({
      version: 1, name: "Party", title: "Party", description: "Two registered members enter their own room.", color: "blue",
      components: [{ key: "join", kind: "button", label: "Join", style: "success", emoji: null, disabledWhen: { op: "entries.gte", collection: "party", value: 2 }, triggerId: "join-trigger" }],
      triggers: [
        { id: "join-trigger", event: "button", componentKey: "join", steps: [
          { id: "register", action: "entry.join", collection: "party", maxEntries: 2, dependsOn: [] },
          { id: "create-room", action: "channel.create_voice", name: "Party", when: { op: "and", conditions: [...managerVoiceGuard.conditions, { op: "result.equals", stepId: "register", field: "joined", value: true }, { op: "result.equals", stepId: "register", field: "count", value: 2 }] }, dependsOn: ["register"] },
          { id: "move-registered", action: "channel.move_members", channelStepId: "create-room", collection: "party", maxMembers: 2, when: moveGuard, dependsOn: ["register", "create-room"] },
          { id: "refresh", action: "panel.refresh", dependsOn: ["create-room", "move-registered"] },
        ] },
        { id: "cleanup-trigger", event: "workflow.channel_empty", steps: [{ id: "delete-empty", action: "channel.delete_empty", dependsOn: [] }, { id: "refresh-empty", action: "panel.refresh", dependsOn: ["delete-empty"] }] },
      ],
    });
    expect(workflow.triggers[0]!.steps.map((step) => step.action)).toContain("channel.move_members");
    expect(workflow.triggers[1]?.event).toBe("workflow.channel_empty");
    expect(runDryRun(workflow).find((scenario) => scenario.id === "group-capacity")?.status).toBe("survives");
    const wrongTrigger = structuredClone(workflow);
    wrongTrigger.triggers[0]!.steps.push({ id: "unsafe-cleanup", action: "channel.delete_empty", dependsOn: [] });
    expect(() => compileInteractiveWorkflow(wrongTrigger)).toThrow(/internal workflow.channel_empty trigger/);
  });

  it("Test 5: preserves user-specified point values and requires an atomic debit", () => {
    const request = "Award 50 points on first signup and debit 300 points for an exchange.";
    const graph = requirements(request, [
      { id: "r01", kind: "effect", statement: "Award fifty points on unique signup", quote: "Award 50 points", effects: ["data.entry.write", "data.state.write", "ui.component.create"], success: "A first-time registration adds 50 points" },
      { id: "r02", kind: "effect", statement: "Debit three hundred points atomically", quote: "debit 300 points", effects: ["data.state.write", "ui.component.create"], success: "The balance is debited only when it is at least 300" },
    ]);
    const candidate = plan({
      version: 1, name: "Points", title: "Points", description: "Signup and exchange", color: "blue",
      components: [
        { key: "join", kind: "button", label: "Join", style: "success", emoji: null, disabledWhen: { op: "entries.gte", collection: "participants", value: 1000 }, triggerId: "join" },
        { key: "redeem", kind: "button", label: "Redeem", style: "primary", emoji: null, triggerId: "redeem" },
      ],
      triggers: [
        { id: "join", event: "button", componentKey: "join", steps: [{ id: "entry", action: "entry.join", collection: "participants", maxEntries: 1000, dependsOn: [] }, { id: "award", action: "state.increment", scope: "member", key: "points", amount: 50, when: { op: "result.equals", stepId: "entry", field: "joined", value: true }, dependsOn: ["entry"] }] },
        { id: "redeem", event: "button", componentKey: "redeem", steps: [{ id: "debit", action: "state.debit", scope: "member", key: "points", amount: 300, minimumBalance: 300, idempotencyKey: "exchange", dependsOn: [] }] },
      ],
    }, [
      { requirementId: "r01", workflowElementIds: ["join", "entry", "award"], adapterCapabilities: [], rationale: "Registration and award use the requested value 50." },
      { requirementId: "r02", workflowElementIds: ["redeem", "debit"], adapterCapabilities: [], rationale: "The database debit uses the requested value 300 and an idempotency key." },
    ]);
    const result = verifyCandidate(graph, candidate, new Set(["trigger:button", "action:entry.join", "action:state.increment", "action:state.debit", "action:panel.refresh"]));
    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    const workflow = (result.workflow as { workflow: InteractiveWorkflow }).workflow;
    expect(workflow.triggers.flatMap((trigger) => trigger.steps).find((step) => step.action === "state.increment")).toMatchObject({ amount: 50 });
    expect(workflow.triggers.flatMap((trigger) => trigger.steps).find((step) => step.action === "state.debit")).toMatchObject({ amount: 300, minimumBalance: 300 });
  });

  it("Test 6: validates an unknown composition from generic state, event, and message capabilities", () => {
    const workflow = compileInteractiveWorkflow({
      version: 1, name: "Preference", title: "Preference", description: "Opt into a digest", color: "purple",
      components: [{ key: "enable", kind: "button", label: "Enable", style: "primary", emoji: null, triggerId: "enable" }],
      triggers: [{ id: "enable", event: "button", componentKey: "enable", steps: [{ id: "save", action: "state.set", scope: "member", key: "digest_opt_in", value: true, dependsOn: [] }, { id: "confirm", action: "message.dm", recipient: "trigger_member", content: "Digest enabled", dependsOn: ["save"] }] }],
    });
    expect(workflow.triggers[0]!.steps.map((step) => step.action)).toEqual(["state.set", "message.dm", "panel.refresh"]);
  });

  it("Test 7: reports contradictory Requirements rather than changing either one", async () => {
    const request = "Always send a DM and never send a DM.";
    const contradictory = { ...requirements(request, [
      { id: "r01", kind: "effect", statement: "Send a DM", quote: "Always send a DM", effects: ["discord.dm.send"], success: "The member receives a DM" },
      { id: "r02", kind: "prohibition", statement: "Do not send a DM", quote: "never send a DM", effects: [], success: "No DM is sent" },
    ]), contradictions: [{ requirements: ["r01", "r02"], explanation: "The same workflow both requires and forbids a DM." }] };
    const result = await makeReasonerPlan(request, "max", { call: async () => ({ object: contradictory, model: "mock", inputTokens: 1, outputTokens: 1 }) });
    expect(result.diagnostics?.reasoner?.failureClass).toBe("conflicting_requirements");
    expect(result.interactiveWorkflow).toBeUndefined();
  });

  it("Test 8: leaves an external-action failure inconclusive instead of replaying it in the dry run", () => {
    const workflow = compileInteractiveWorkflow({
      version: 1, name: "Failure", title: "Failure", description: "State then message", color: "gray",
      components: [{ key: "run", kind: "button", label: "Run", style: "primary", emoji: null, triggerId: "run" }],
      triggers: [{ id: "run", event: "button", componentKey: "run", steps: [
        { id: "increment", action: "state.increment", scope: "member", key: "count", amount: 1, dependsOn: [] },
        { id: "send", action: "message.send", delivery: "workflow_channel", content: "Done", channelStepId: null, dependsOn: ["increment"] },
      ] }],
    });
    const scenario = runDryRun(workflow).find((item) => item.id === "partial-action-failure");
    expect(scenario?.status).toBe("inconclusive");
    expect(scenario?.evidence).toContain("External effects are not executed");
  });
});
