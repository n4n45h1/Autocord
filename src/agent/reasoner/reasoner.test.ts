import { describe, expect, it } from "vitest";
import { capabilityRegistry, triggerContracts } from "./capabilities.js";
import { requirementGraphSchema, validateRequirementGraph, type RequirementGraph } from "./intent.js";
import { runDryRun } from "./simulator.js";
import { verifyCandidate } from "./verifier.js";
import { makeReasonerPlan } from "./orchestrator.js";
import type { WorkflowCandidate } from "./synthesizer.js";
import { interactiveWorkflowStepSchema, interactiveWorkflowTriggerSchema } from "../interactive-workflow.js";
import { structuredRequirementCatalog } from "../structured-requirements.js";
import { maxWorkflowSchema, resourceWorkflowSchema } from "../workflow.js";
import { createEvaluationSet } from "./evaluation.js";
import { normalizeCandidateReferences } from "./synthesizer.js";

function graph(request: string, statement = request): RequirementGraph {
  return requirementGraphSchema.parse({
    version: 1,
    target: "interactive",
    requirements: [{ id: "r01", kind: "effect", statement, source: { quote: request, start: null, end: null }, importance: "hard", certainty: "explicit", authorizedSideEffects: ["data.state.write", "ui.component.create"], dependsOn: [], missingInformation: [], successCondition: "The member score increases by one.", forbiddenSideEffects: [] }],
    contradictions: [],
  });
}

function candidate(): WorkflowCandidate {
  return {
    target: "interactive",
    workflow: {
      version: 1, name: "Score", title: "Score", description: "Increase score", color: "blue",
      components: [{ key: "increase", kind: "button", label: "Increase", style: "primary", emoji: null, triggerId: "increase-trigger" }],
      triggers: [{ id: "increase-trigger", event: "button", componentKey: "increase", steps: [{ id: "increment", action: "state.increment", scope: "member", key: "score", amount: 1, dependsOn: [] }] }],
    },
    coverage: [{ requirementId: "r01", workflowElementIds: ["increase", "increment"], adapterCapabilities: [], rationale: "The button exposes the requested member interaction and the action mutates the member score." }],
  };
}

describe("ARE RequirementGraph and verifier", () => {
  it("rejects fabricated source spans and missing dependency targets", () => {
    const request = "Increase the score";
    const parsed = requirementGraphSchema.parse({ ...graph(request), requirements: [{ ...graph(request).requirements[0], source: { quote: "made up", start: 0, end: 8 }, dependsOn: ["r99"] }] });
    expect(validateRequirementGraph(parsed, request)).toContain("r01 source quote does not occur verbatim in the request.");
    expect(validateRequirementGraph(parsed, request)).toContain("r01 references unknown requirement r99.");
  });

  it("validates a typed candidate and reports semantic claims as unverified", () => {
    const request = "Increase the score";
    const verified = verifyCandidate(graph(request), candidate(), new Set(["action:state.increment", "trigger:button"]));
    expect(verified.valid, JSON.stringify(verified.issues)).toBe(true);
    expect(verified.coverage).toEqual([{ requirementId: "r01", status: "mapped_unverified", workflowElementIds: ["increase", "increment"], adapterCapabilities: [] }]);
    expect(verified.semanticChecks[0]?.status).toBe("unverified");
    expect(verified.scenarios.every((scenario) => scenario.status !== "counterexample")).toBe(true);
  });

  it("maps application preview requirements to the approval adapter instead of fake Workflow steps", () => {
    const request = "Increase the score and show me a preview.";
    const requirementGraph = requirementGraphSchema.parse({ ...graph(request), requirements: [
      { ...graph(request).requirements[0], source: { quote: "Increase the score", start: null, end: null } },
      { id: "r02", kind: "effect", fulfillmentLayer: "approval_adapter", authorizedAdapters: ["approval.preview"], statement: "Show an approval preview", source: { quote: "show me a preview", start: null, end: null }, importance: "hard", certainty: "explicit", dependsOn: ["r01"], missingInformation: [], successCondition: "The approval adapter renders the candidate before execution.", forbiddenSideEffects: [] },
    ] });
    const plan = candidate();
    plan.coverage.push({ requirementId: "r02", workflowElementIds: [], adapterCapabilities: ["approval.preview"], rationale: "The application preview adapter renders the candidate." });
    const verified = verifyCandidate(requirementGraph, plan, new Set(["action:state.increment", "trigger:button"]));
    expect(verified.valid).toBe(true);
    expect(verified.coverage[1]).toMatchObject({ requirementId: "r02", status: "satisfied_by_adapter", adapterCapabilities: ["approval.preview"] });
  });

  it("rejects an untraced action and a capability outside the selected search set", () => {
    const request = "Increase the score";
    const plan = candidate();
    const result = verifyCandidate(graph(request), plan, new Set(["trigger:button"]));
    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("Unselected action capability used: state.increment");
  });

  it("blocks a valid but unrequested DM side effect and enforces its declared count", () => {
    const plan = candidate();
    const workflow = plan.workflow as { triggers: { steps: Record<string, unknown>[] }[] };
    workflow.triggers[0]!.steps.push({ id: "extra-dm", action: "message.dm", recipient: "trigger_member", content: "Unrequested message", dependsOn: [] });
    plan.coverage[0]!.workflowElementIds.push("extra-dm");
    const selected = new Set(["action:state.increment", "action:message.dm", "trigger:button"]);
    const unauthorized = verifyCandidate(graph("Increase the score"), plan, selected);
    expect(unauthorized.issues).toContain("Unauthorized side effect discord.dm.send at extra-dm: no traced Requirement authorizes it.");

    const authorizedGraph = graph("Increase the score and DM the member");
    authorizedGraph.requirements[0]!.authorizedSideEffects.push("discord.dm.send");
    authorizedGraph.requirements[0]!.sideEffectLimits.push({ kind: "discord.dm.send", maxCount: 0 });
    const overBudget = verifyCandidate(authorizedGraph, plan, selected);
    expect(overBudget.issues).toContain("Side effect budget exceeded for discord.dm.send: candidate has 1, RequirementGraph authorizes 0.");
  });

  it("rejects extra UI controls when the requirement only authorizes one component", () => {
    const plan = candidate();
    const workflow = plan.workflow as { components: unknown[]; triggers: { id: string; event: string; componentKey?: string; steps: Record<string, unknown>[] }[] };
    workflow.components.push({ key: "extra", kind: "button", label: "Extra", style: "secondary", emoji: null, triggerId: "extra-trigger" });
    workflow.triggers.push({ id: "extra-trigger", event: "button", componentKey: "extra", steps: [{ id: "read", action: "state.get", scope: "member", key: "other", dependsOn: [] }] });
    plan.coverage[0]!.workflowElementIds.push("extra", "extra-trigger", "read");
    const result = verifyCandidate(graph("Increase the score"), plan, new Set(["action:state.increment", "action:state.get", "trigger:button"]));
    expect(result.issues).toContain("Side effect budget exceeded for ui.component.create: candidate has 2, RequirementGraph authorizes 1.");
  });

  it("blocks an unrequested DM even when the action and workflow schema are valid", () => {
    const plan = candidate();
    const workflow = plan.workflow as { triggers: { steps: Record<string, unknown>[] }[] };
    workflow.triggers[0]!.steps.push({ id: "extra-dm", action: "message.dm", recipient: "trigger_member", content: "Unexpected notification", dependsOn: [] });
    plan.coverage[0]!.workflowElementIds.push("extra-dm");
    const result = verifyCandidate(graph("Increase the score"), plan, new Set(["action:state.increment", "action:message.dm", "trigger:button"]));
    expect(result.issues).toContain("Unauthorized side effect discord.dm.send at extra-dm: no traced Requirement authorizes it.");
  });

  it("rejects a reference to a field the source Action does not return", () => {
    const plan = candidate();
    const workflow = plan.workflow as { triggers: { steps: Record<string, unknown>[] }[] };
    workflow.triggers[0]!.steps.push({ id: "notify", action: "message.send", delivery: "workflow_channel", channelStepId: null, content: "{{result:increment:joined}}", dependsOn: ["increment"], when: { op: "result.equals", stepId: "increment", field: "joined", value: true } });
    plan.coverage[0]!.workflowElementIds.push("notify");
    const requirementGraph = graph("Increase the score");
    requirementGraph.requirements[0]!.authorizedSideEffects.push("discord.message.send");
    const result = verifyCandidate(requirementGraph, plan, new Set(["action:state.increment", "action:message.send", "trigger:button"]));
    expect(result.issues).toContain("Action state.increment does not produce result field joined (referenced by increment).");
  });

  it("normalizes model shorthand references only when the referenced step produces a scalar value", () => {
    expect(normalizeCandidateReferences({ triggers: [{ steps: [
      { id: "sum", action: "math.add", left: 1, right: 2 },
      { id: "remaining", action: "state.set", scope: "workflow", key: "remaining", value: 6 },
      { id: "send", action: "message.send", content: "{{sum}} {{steps.sum.output}} {{remaining}}" },
    ] }] })).toEqual({ triggers: [{ steps: [
      { id: "sum", action: "math.add", left: 1, right: 2 },
      { id: "remaining", action: "state.set", scope: "workflow", key: "remaining", value: 6 },
      { id: "send", action: "message.send", content: "{{result:sum:value}} {{result:sum:value}} {{state:workflow:remaining}}" },
    ] }] });
    expect(normalizeCandidateReferences({ triggers: [{ steps: [{ id: "send", action: "message.send", content: "{{unknown}}" }] }] })).toEqual({ triggers: [{ steps: [{ id: "send", action: "message.send", content: "{{unknown}}" }] }] });
  });

  it("detects explicit forbidden mutation classes without changing the graph", () => {
    const request = "Increase the score; never delete a channel.";
    const requirementGraph = requirementGraphSchema.parse({ ...graph(request), requirements: [
      ...graph(request).requirements,
      { id: "r02", kind: "prohibition", statement: "Never delete a channel", source: { quote: "never delete a channel", start: null, end: null }, importance: "hard", certainty: "explicit", dependsOn: [], missingInformation: [], successCondition: "No channel is deleted", forbiddenSideEffects: ["channel deletion"], forbiddenSideEffectKinds: ["discord.channel.delete"] },
    ] });
    const modified = candidate();
    const workflow = modified.workflow as { triggers: { steps: unknown[] }[] };
    workflow.triggers[0]!.steps.push({ id: "delete-channel", action: "channel.delete", channelStepId: null, channelId: "{{input:channelId}}", dependsOn: [] });
    modified.coverage.push({ requirementId: "r02", workflowElementIds: ["delete-channel"], adapterCapabilities: [], rationale: "negative" });
    const result = verifyCandidate(requirementGraph, modified);
    expect(result.issues.join("\n")).toContain("Forbidden side effect discord.channel.delete");
  });

  it("derives Action and Trigger coverage from the runtime schemas", () => {
    const schemaActions = [
      ...interactiveWorkflowStepSchema.options.map((option) => option.shape.action.value),
      ...maxWorkflowSchema.shape.operations.element.options.map((option) => option.shape.action.value),
      ...resourceWorkflowSchema.shape.steps.element.options.map((option) => option.shape.action.value),
    ];
    expect(new Set(capabilityRegistry.map((contract) => contract.name))).toEqual(new Set(schemaActions));
    expect(capabilityRegistry.every((contract) => contract.inputSchema && contract.outputSchema && contract.executorCoverage === "exhaustive")).toBe(true);
    expect(JSON.stringify(capabilityRegistry.find((contract) => contract.name === "state.increment")?.outputSchema)).toContain("value");
    expect(new Set(triggerContracts.map((contract) => contract.name))).toEqual(new Set(structuredRequirementCatalog.triggers));
    expect(interactiveWorkflowTriggerSchema.options.length).toBeGreaterThan(0);
  });

  it("treats unsupported-capability analysis as a hypothesis and verifies a composed candidate before rejecting", async () => {
    const plan = candidate();
    const modelCall = async (prompt: string) => {
      if (prompt.startsWith("Compile the user's request")) return { object: graph("Increase the score"), model: "mock/are", inputTokens: 10, outputTokens: 5 };
      if (prompt.startsWith("Select a high-recall")) return { object: { actions: ["state.increment"], triggers: ["button"], unsupportedRequirements: [{ requirementId: "r01", explanation: "The operation was misclassified as unavailable." }], unsafeRequirements: [] }, model: "mock/are", inputTokens: 10, outputTokens: 5 };
      if (prompt.startsWith("Act as an adversarial Workflow critic")) return { object: { proposals: [{ scenarioId: "duplicate-delivery", requirementIds: ["r01"], rationale: "Check interaction deduplication." }] }, model: "mock/are", inputTokens: 10, outputTokens: 5 };
      return { object: { candidates: [plan] }, model: "mock/are", inputTokens: 10, outputTokens: 5 };
    };
    const result = await makeReasonerPlan("Increase the score", "max", { call: modelCall as never });
    expect(result.interactiveWorkflow).toBeDefined();
    expect(result.diagnostics?.reasoner?.unsupportedHypotheses).toEqual([{ requirementId: "r01", explanation: "The operation was misclassified as unavailable." }]);
  });

  it("dry runs never invoke Discord and label nondeterministic properties inconclusive", () => {
    const scenarios = runDryRun(candidate().workflow as Parameters<typeof runDryRun>[0]);
    expect(scenarios.find((scenario) => scenario.id === "concurrent-trigger")?.status).toBe("inconclusive");
    expect(scenarios.find((scenario) => scenario.id === "duplicate-delivery")?.status).toBe("survives");
    expect(scenarios.find((scenario) => scenario.id === "symbolic-state")?.trace?.finalState).toEqual({ "member:synthetic-member-1:score": 1 });
    expect(scenarios.every((scenario) => scenario.evidence.length > 0)).toBe(true);
  });

  it("dry run resolves typed state and math dataflow in its in-memory state model", () => {
    const workflow = candidate().workflow as { triggers: { steps: unknown[] }[] };
    workflow.triggers[0]!.steps = [
      { id: "seed", action: "state.set", scope: "workflow", key: "score", value: 4, dependsOn: [] },
      { id: "sum", action: "math.add", left: "{{state:workflow:score}}", right: 2, dependsOn: ["seed"] },
      { id: "store", action: "state.set", scope: "workflow", key: "result", value: "{{result:sum:value}}", dependsOn: ["sum"] },
    ];
    const trace = runDryRun(workflow as Parameters<typeof runDryRun>[0]).find((scenario) => scenario.id === "symbolic-state")?.trace;
    expect(trace?.finalState).toMatchObject({ "workflow:Score:score": 4, "workflow:Score:result": 6 });
    expect(trace?.unresolvedBranches).toEqual([]);
  });

  it("keeps workflow-scoped symbolic state across separate trigger executions", () => {
    const workflow = {
      version: 1 as const, name: "Shared", title: "Shared", description: "Shared state", color: "blue" as const, components: [],
      triggers: [
        { id: "first", event: "schedule" as const, intervalSeconds: 60, steps: [{ id: "set", action: "state.set" as const, scope: "workflow" as const, key: "runs", value: 1, dependsOn: [] }] },
        { id: "second", event: "schedule" as const, intervalSeconds: 60, steps: [{ id: "increment", action: "state.increment" as const, scope: "workflow" as const, key: "runs", amount: 1, dependsOn: [] }] },
      ],
    };
    const traces = runDryRun(workflow);
    expect(traces.find((scenario) => scenario.id === "symbolic-state")?.trace?.finalState["workflow:Shared:runs"]).toBe(2);
  });

  it("orchestrates intent, capability selection, synthesis, verification and bounded output", async () => {
    const plan = candidate();
    const modelCall = async (prompt: string) => {
      if (prompt.startsWith("Compile the user's request")) return { object: graph("Increase the score"), model: "mock/are", inputTokens: 10, outputTokens: 5 };
      if (prompt.startsWith("Select a high-recall")) return { object: { actions: ["state.increment"], triggers: ["button"], unsupportedRequirements: [], unsafeRequirements: [] }, model: "mock/are", inputTokens: 10, outputTokens: 5 };
      if (prompt.startsWith("Act as an adversarial Workflow critic")) return { object: { proposals: [{ scenarioId: "duplicate-delivery", requirementIds: ["r01"], rationale: "Check that duplicate delivery does not apply one interaction twice." }] }, model: "mock/are", inputTokens: 10, outputTokens: 5 };
      return { object: { candidates: [plan] }, model: "mock/are", inputTokens: 10, outputTokens: 5 };
    };
    const result = await makeReasonerPlan("Increase the score", "max", { call: modelCall as never });
    expect(result.interactiveWorkflow, JSON.stringify({ clarification: result.clarification, diagnostics: result.diagnostics })).toBeDefined();
    expect(result.diagnostics?.reasoner?.engine).toBe("ARE-1.0");
    expect(result.inputTokens).toBe(40);
    expect(result.diagnostics?.reasoner?.criticProposals).toBeDefined();
  });

  it("builds the held-out evaluation split with the specified category balance and paraphrase groups", () => {
    const cases = createEvaluationSet();
    expect(cases).toHaveLength(100);
    expect(Object.fromEntries([...new Set(cases.map((item) => item.category))].map((category) => [category, cases.filter((item) => item.category === category).length]))).toEqual({
      "unknown-composite": 30, paraphrase: 20, "state-time": 20, "ambiguity-conflict": 15, "capability-safety": 15,
    });
    expect(cases.filter((item) => item.split === "holdout")).toHaveLength(20);
    expect(new Set(cases.filter((item) => item.metamorphicGroup).map((item) => item.metamorphicGroup)).size).toBe(2);
  });
});
