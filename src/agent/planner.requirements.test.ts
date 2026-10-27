import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makePlan } from "./planner.js";
import { analyzeRequestRequirements, validatePlanTargetAgainstRequest, validateWorkflowAgainstRequest } from "./requirements.js";
import { agentSkills } from "./skills/registry.js";
import { interactiveWorkflowStepSchema, interactiveWorkflowTriggerSchema } from "./interactive-workflow.js";
import { structuredRequirementCatalog, validateStructuredRequirementCapabilities, type StructuredMaxRequirements } from "./structured-requirements.js";

const mocks = vi.hoisted(() => ({ generateOpenCodePlan: vi.fn(), generateObject: vi.fn() }));
vi.mock("./opencode.js", () => ({ generateOpenCodePlan: mocks.generateOpenCodePlan }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));

const originalBackend = process.env.AI_BACKEND;
const originalFallback = process.env.AI_FALLBACK_MODEL;

function inferRequirements(object: unknown): StructuredMaxRequirements {
  const output = object as { target?: string; workflow?: { operations?: { action: string }[]; steps?: { action: string }[]; triggers?: { event: string; steps: { action: string }[] }[] } };
  const target = output.target ?? (output.workflow?.operations ? "panel" : output.workflow?.steps ? "resources" : "interactive");
  const workflow = output.workflow;
  const actions = target === "interactive" ? workflow?.triggers?.flatMap((trigger) => trigger.steps.map((step) => step.action)) ?? []
    : target === "resources" ? workflow?.steps?.map((step) => step.action) ?? []
      : workflow?.operations?.map((operation) => operation.action) ?? [];
  const invariants: StructuredMaxRequirements["invariants"] = [];
  if (actions.includes("entry.join")) invariants.push("unique_per_member");
  if (actions.includes("state.debit")) { invariants.push("atomic_debit"); if (actions.includes("message.dm")) invariants.push("no_duplicate_redemption"); }
  if (actions.includes("collection.add") && workflow?.triggers?.some((trigger) => trigger.event === "reaction.added")) invariants.push("one_vote_per_member");
  if (actions.includes("workflow.wait") || workflow?.triggers?.some((trigger) => ["schedule", "schedule.at", "deadline"].includes(trigger.event))) invariants.push("restart_resilient");
  if (workflow?.triggers?.some((trigger) => trigger.event === "voice.member_leave_event")) invariants.push("empty_voice_cleanup");
  return { target: target as StructuredMaxRequirements["target"], requiredActions: [...new Set(actions)], requiredTriggers: [...new Set(workflow?.triggers?.map((trigger) => trigger.event) ?? [])], invariants };
}

function response(object: unknown, requirements?: StructuredMaxRequirements, repairs: unknown[] = []) {
  const contract = requirements ?? inferRequirements(object);
  mocks.generateOpenCodePlan
    .mockResolvedValueOnce({ object: contract, model: "mock/requirements", inputTokens: 5, outputTokens: 5 })
    .mockResolvedValueOnce({ object, model: "mock/max", inputTokens: 10, outputTokens: 10 });
  for (const repair of repairs) mocks.generateOpenCodePlan.mockResolvedValueOnce({ object: repair, model: "mock/repair", inputTokens: 7, outputTokens: 8 });
  mocks.generateOpenCodePlan.mockResolvedValue({ object, model: "mock/max", inputTokens: 10, outputTokens: 10 });
}

function stateWorkflow() {
  return {
    target: "interactive", workflow: {
      version: 1, name: "Preferences", title: "Preferences", description: "Store a preference", color: "blue",
      components: [{ key: "save", kind: "button", label: "Save", style: "primary", emoji: null, triggerId: "save" }],
      triggers: [{ id: "save", event: "button", componentKey: "save", steps: [
        { id: "save", action: "state.set", scope: "member", key: "preference", value: "yes" },
      ] }],
    },
  };
}

afterEach(() => {
  mocks.generateOpenCodePlan.mockReset();
  mocks.generateObject.mockReset();
  if (originalBackend === undefined) delete process.env.AI_BACKEND;
  else process.env.AI_BACKEND = originalBackend;
  if (originalFallback === undefined) delete process.env.AI_FALLBACK_MODEL;
  else process.env.AI_FALLBACK_MODEL = originalFallback;
});

describe("Agentcord Max requirement routing and plan verification", () => {
  it("fails closed on invalid structured requirement output", async () => {
    process.env.AI_BACKEND = "opencode-server";
    mocks.generateOpenCodePlan
      .mockResolvedValueOnce({ object: { target: "interactive" }, model: "mock/requirements", inputTokens: 3, outputTokens: 2 })
      .mockResolvedValue({ object: { target: "interactive" }, model: "mock/requirements", inputTokens: 3, outputTokens: 2 });
    const plan = await makePlan("Build a custom workflow", undefined, "max");
    expect(plan.interactiveWorkflow).toBeUndefined();
    expect(plan.clarification?.missingSkills).toContain("agentcord.max.structured_requirements");
    expect(mocks.generateOpenCodePlan).toHaveBeenCalledTimes(3);
  });

  it("rejects a valid plan that omits a structured required action", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const workflow = JSON.parse(readFileSync(new URL("../../examples/workflows/valorant-recruitment.json", import.meta.url), "utf8"));
    mocks.generateOpenCodePlan
      .mockResolvedValueOnce({ object: { target: "interactive", requiredActions: ["giveaway.create"], requiredTriggers: [], invariants: [] }, model: "mock/requirements", inputTokens: 4, outputTokens: 4 })
      .mockResolvedValueOnce({ object: { target: "interactive", workflow }, model: "mock/max", inputTokens: 10, outputTokens: 10 })
      .mockResolvedValueOnce({ object: { target: "interactive", workflow }, model: "mock/max", inputTokens: 2, outputTokens: 2 })
      .mockResolvedValueOnce({ object: { target: "interactive", workflow }, model: "mock/max", inputTokens: 2, outputTokens: 2 });
    const result = await makePlan("Make a signup workflow", undefined, "max");
    expect(result.interactiveWorkflow).toBeUndefined();
    expect(result.clarification?.questions.join(" ")).toContain("giveaway.create");
    expect(mocks.generateOpenCodePlan).toHaveBeenCalledTimes(4);
  });

  it("normalizes common actor-id aliases to the supported actor template", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const workflow = { target: "interactive", workflow: {
      version: 1, name: "Actor reply", title: "Actor", description: "", color: "blue",
      components: [{ key: "send", kind: "button", label: "Send", style: "primary", emoji: null, triggerId: "send" }],
      triggers: [{ id: "send", event: "button", componentKey: "send", steps: [{ id: "message", action: "message.send", delivery: "workflow_channel", content: "Hello <@{{member:id}}>" }] }],
    } };
    response(workflow);
    const result = await makePlan("Post a greeting that mentions the clicking user", undefined, "max");
    const message = result.interactiveWorkflow?.triggers[0]?.steps.find((step) => step.action === "message.send");
    expect(message?.action === "message.send" && message.content).toBe("Hello <@{{actor}}>");
  });

  it("repairs unrelated side effects instead of accepting a schema-valid extra join action", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const overbuilt = {
      target: "interactive", workflow: {
        version: 1, name: "Status", title: "Status", description: "", color: "blue",
        components: [{ key: "send", kind: "button", label: "Send", style: "primary", emoji: null, disabledWhen: { op: "entries.gte", collection: "attendees", value: 3 }, triggerId: "send" }],
        triggers: [{ id: "send", event: "button", componentKey: "send", steps: [
          { id: "join", action: "entry.join", collection: "attendees", maxEntries: 3 },
          { id: "notice", action: "message.send", delivery: "workflow_channel", content: "Test sent" },
        ] }],
      },
    };
    const minimal = {
      target: "interactive", workflow: {
        version: 1, name: "Status", title: "Status", description: "", color: "blue",
        components: [{ key: "send", kind: "button", label: "Send", style: "primary", emoji: null, triggerId: "send" }],
        triggers: [{ id: "send", event: "button", componentKey: "send", steps: [{ id: "notice", action: "message.send", delivery: "workflow_channel", content: "Test sent" }] }],
      },
    };
    mocks.generateOpenCodePlan
      .mockResolvedValueOnce({ object: { target: "interactive", requiredActions: ["message.send"], requiredTriggers: ["button"], invariants: [] }, model: "mock/requirements", inputTokens: 5, outputTokens: 5 })
      .mockResolvedValueOnce({ object: overbuilt, model: "mock/max", inputTokens: 10, outputTokens: 10 })
      .mockResolvedValueOnce({ object: minimal, model: "mock/max", inputTokens: 10, outputTokens: 10 });
    const result = await makePlan("ボタンを押したらテスト成功を投稿", undefined, "max");
    expect(result.interactiveWorkflow?.triggers.flatMap((trigger) => trigger.steps.map((step) => step.action))).not.toContain("entry.join");
    expect(result.diagnostics?.repairAttempts).toBe(1);
    expect(mocks.generateOpenCodePlan).toHaveBeenCalledTimes(3);
  });

  it("requires a Modal workflow with member persistence and owner-only notification for contact requests", async () => {
    process.env.AI_BACKEND = "opencode-server";
    response({ target: "interactive", workflow: {
      version: 1, name: "Contact", title: "お問い合わせ", description: "内容を送信してください。", color: "blue",
      components: [{ key: "contact", kind: "modal", label: "入力する", title: "お問い合わせ", triggerId: "submit", inputs: [{ key: "message", label: "内容", placeholder: null, style: "paragraph", required: true, maxLength: 1000 }] }],
      triggers: [{ id: "submit", event: "modal_submit", componentKey: "contact", steps: [
        { id: "save", action: "state.set", scope: "member", key: "contact_message", value: "{{input:message}}" },
        { id: "notify", action: "message.send", delivery: "workflow_owner_dm", content: "問い合わせ: {{input:message}}" },
      ] }],
    } });
    const plan = await makePlan("お問い合わせフォームを作成して", undefined, "max");
    expect(plan.interactiveWorkflow?.components[0]?.kind).toBe("modal");
    expect(validateWorkflowAgainstRequest("お問い合わせフォームを作成して", plan.interactiveWorkflow!)).toEqual([]);
    expect(plan.interactiveWorkflow?.triggers[0]?.steps.some((step) => step.action === "role.grant")).toBe(false);
  });

  it("plans VoiceState-driven VC creation and empty-session deletion instead of a panel downgrade", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const request = "2人集まったら専用VCを作成し、全員退出したら削除する通話募集";
    const voiceWorkflow = {
      version: 1, name: "Temporary party VC", title: "VC募集", description: "Voice Lobbyの2人参加で専用VCを作ります。", color: "purple",
      components: [],
      triggers: [
        { id: "join", event: "voice.member_join_event", voiceChannelId: "12345678901234567", steps: [{ id: "create", action: "voice.channel.create", name: "party-voice", moveMembers: true, when: { op: "or", conditions: [{ op: "voice.members.gte", value: 2 }, { op: "voice.session.exists" }] } }] },
        { id: "leave", event: "voice.member_leave_event", steps: [{ id: "delete", action: "voice.channel.delete", when: { op: "voice.members.eq", value: 0 } }] },
      ],
    };
    response({ target: "interactive", workflow: voiceWorkflow });
    const plan = await makePlan(request, undefined, "max", undefined, [], [{ id: "12345678901234567", name: "Voice Lobby", category: null }]);
    expect(plan.interactiveWorkflow?.triggers.some((trigger) => trigger.event === "voice.member_join_event")).toBe(true);
    expect(validateWorkflowAgainstRequest(request, plan.interactiveWorkflow!)).toEqual([]);
    expect(analyzeRequestRequirements(request).unsupportedSkills).toEqual([]);
  });

  it("keeps the requested recruitment cap and rejects unrelated targets", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const workflow = JSON.parse(readFileSync(new URL("../../examples/workflows/valorant-recruitment.json", import.meta.url), "utf8"));
    response({ target: "interactive", workflow });
    const plan = await makePlan("5人まで参加できるVALORANT募集。参加と取消、人数表示", undefined, "max");
    expect(validateWorkflowAgainstRequest("5人まで参加できるVALORANT募集。参加と取消、人数表示", plan.interactiveWorkflow!)).toEqual([]);
    expect(validatePlanTargetAgainstRequest("お問い合わせフォームを作成して", "panel")).not.toHaveLength(0);
  });

  it("keeps Role, Channel and Giveaway actions in one Interactive target and normalizes permission labels", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const workflow = JSON.parse(readFileSync(new URL("../../examples/workflows/resources-and-giveaway.json", import.meta.url), "utf8"));
    const category = workflow.triggers[0].steps.find((step: { action: string }) => step.action === "resource.channel.create_category");
    category.when.conditions[1].permission = "Manage Channels";
    response({ target: "interactive", workflow });
    const request = "Create a permissionless role, category, text channel and Giveaway in the same workflow.";
    const plan = await makePlan(request, undefined, "max");
    const actions = plan.interactiveWorkflow?.triggers.flatMap((trigger) => trigger.steps.map((step) => step.action)) ?? [];
    expect(plan.interactiveWorkflow, JSON.stringify({ clarification: plan.clarification, diagnostics: plan.diagnostics })).toBeDefined();
    expect(actions).toContain("resource.role.create");
    expect(actions).toContain("resource.channel.create_text");
    expect(actions).toContain("giveaway.create");
    expect(validateWorkflowAgainstRequest(request, plan.interactiveWorkflow!)).toEqual([]);
  });

  it("sends the full current schema and skill catalog to extraction and planning, with resolvable recursive references", async () => {
    process.env.AI_BACKEND = "opencode-server";
    response(stateWorkflow());
    await makePlan("Store a preference", undefined, "max");
    const contracts = mocks.generateOpenCodePlan.mock.calls.map(([prompt]) => JSON.parse(prompt.split("\n").find((line: string) => line.startsWith('{"catalog":'))!));
    expect(contracts).toHaveLength(2);
    expect(contracts[0]).toEqual(contracts[1]);
    const contract = contracts[0];
    expect(Object.keys(contract.skills)).toEqual(Object.keys(agentSkills));
    expect(contract.catalog).toEqual(structuredRequirementCatalog);
    expect(contract.catalog.actions.interactive).toEqual(interactiveWorkflowStepSchema.options.map((option) => option.shape.action.value));
    expect(contract.catalog.triggers).toEqual(interactiveWorkflowTriggerSchema.options.flatMap((option) => "options" in option.shape.event ? option.shape.event.options : [option.shape.event.value]));
    expect(contract.schema.properties).toHaveProperty("plan");
    expect(contract.schema.properties).toHaveProperty("compiledInteractiveWorkflow");
    expect(Object.keys(contract.schema.properties.skillInputs.properties)).toEqual(Object.keys(agentSkills));
    const schemaText = JSON.stringify(contract.schema);
    expect(schemaText).toContain('"additionalProperties":false');
    expect(schemaText).toContain('"categoryStepId"');
    expect(schemaText).toContain('"minimumBalance"');
    expect(schemaText).toContain('"maxItems":8');
    const refs = [...schemaText.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/"), ref).toBe(true);
      const resolved = ref.slice(2).split("/").reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], contract.schema);
      expect(resolved, ref).toBeDefined();
    }
    expect(mocks.generateOpenCodePlan.mock.calls[0]![0]).toContain("atomic_debit and no_duplicate_redemption are supported invariants");
  });

  it.each(["object state value", "extra source", "missing categoryStepId"])("repairs %s without silently normalizing away the error", async (defect) => {
    process.env.AI_BACKEND = "opencode-server";
    const valid = defect === "missing categoryStepId"
      ? { target: "interactive", workflow: JSON.parse(readFileSync(new URL("../../examples/workflows/resources-and-giveaway.json", import.meta.url), "utf8")) }
      : stateWorkflow();
    const invalid = structuredClone(valid);
    if (defect === "object state value") invalid.workflow.triggers[0].steps[0].value = { preference: "yes" };
    if (defect === "extra source") invalid.workflow.triggers[0].steps[0].source = "user";
    if (defect === "missing categoryStepId") delete invalid.workflow.triggers[0].steps.find((step: { action: string }) => step.action === "resource.channel.create_text").categoryStepId;
    const requiredActions = defect === "missing categoryStepId" ? inferRequirements(valid).requiredActions : ["state.set"];
    response(invalid, { target: "interactive", requiredActions, requiredTriggers: ["button"], invariants: [] }, [valid]);
    const result = await makePlan("Configure this workflow", undefined, "max");
    expect(result.interactiveWorkflow).toBeDefined();
    expect(result.clarification).toBeUndefined();
    expect(result).toMatchObject({ model: "mock/repair", inputTokens: 22, outputTokens: 23 });
    const repairPrompt = mocks.generateOpenCodePlan.mock.calls[2]![0];
    expect(repairPrompt).toContain(JSON.stringify(invalid));
    expect(repairPrompt).toContain(defect === "object state value" ? "value" : defect === "extra source" ? "source" : "categoryStepId");
    for (const action of requiredActions) expect(repairPrompt).toContain(action);
  });

  it.each(["opencode-server", "openai-compatible"])("repairs compiler errors after a schema repair within one shared budget on %s", async (backend) => {
    process.env.AI_BACKEND = backend;
    const valid = stateWorkflow();
    const invalidSchema = structuredClone(valid);
    Object.assign(invalidSchema.workflow.triggers[0]!.steps[0]!, { value: { preference: "yes" } });
    const invalidGraph = structuredClone(valid);
    Object.assign(invalidGraph.workflow.triggers[0]!.steps[0]!, { dependsOn: ["missing"] });
    const requirements = { target: "interactive", requiredActions: ["state.set"], requiredTriggers: ["button"], invariants: [] };
    const objects = [requirements, invalidSchema, invalidGraph, valid];
    const generate = backend === "opencode-server" ? mocks.generateOpenCodePlan : mocks.generateObject;
    for (const object of objects) generate.mockResolvedValueOnce({ object, model: "mock/max", inputTokens: 2, outputTokens: 3, response: { modelId: "mock/max" }, usage: { inputTokens: 2, outputTokens: 3 } });
    const result = await makePlan("Store a preference", undefined, "max");
    expect(result.interactiveWorkflow).toBeDefined();
    expect(result).toMatchObject({ inputTokens: 8, outputTokens: 12 });
    expect(generate).toHaveBeenCalledTimes(4);
    const repairPrompt = backend === "opencode-server" ? generate.mock.calls[3]![0] : generate.mock.calls[3]![0].prompt;
    expect(repairPrompt).toContain("depends on missing step missing");
  });

  it("fails closed when repairs keep violating the compiler contract", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const invalid = stateWorkflow();
    Object.assign(invalid.workflow.triggers[0]!.steps[0]!, { dependsOn: ["save"] });
    response(invalid);
    mocks.generateOpenCodePlan.mockResolvedValue({ object: invalid, model: "mock/max", inputTokens: 2, outputTokens: 3 });
    const result = await makePlan("Store a preference", undefined, "max");
    expect(result.interactiveWorkflow).toBeUndefined();
    expect(result.clarification?.questions.join(" ")).toContain("cannot depend on itself");
    expect(result.clarification?.missingSkills).toEqual([]);
    expect(mocks.generateOpenCodePlan).toHaveBeenCalledTimes(4);
  });

  it("repairs panel compilation errors as well as interactive graph errors", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const invalid = { target: "panel", workflow: { version: 1, operations: [{ id: "label", action: "option.set_label", key: "missing", label: "Updated", dependsOn: [] }] } };
    response(invalid, { target: "panel", requiredActions: ["option.set_label"], requiredTriggers: [], invariants: [] }, [{ target: "panel", workflow: { version: 1, operations: [
      { id: "add", action: "option.add", key: "missing", label: "New", roleName: "Member", emoji: null, dependsOn: [] },
      { id: "label", action: "option.set_label", key: "missing", label: "Updated", dependsOn: ["add"] },
    ] } }]);
    const result = await makePlan("Build a role selector", undefined, "max");
    expect(result.plan?.options[0]?.label).toBe("Updated");
    expect(mocks.generateOpenCodePlan.mock.calls[2]![0]).toContain("Max cannot relabel a missing option key");
  });

  it("shares the repair budget between malformed JSON and compiler failures", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const invalid = stateWorkflow();
    Object.assign(invalid.workflow.triggers[0]!.steps[0]!, { dependsOn: ["missing"] });
    mocks.generateOpenCodePlan
      .mockResolvedValueOnce({ object: { target: "interactive", requiredActions: ["state.set"], requiredTriggers: ["button"], invariants: [] }, model: "mock/extraction", inputTokens: 3, outputTokens: 4 })
      .mockRejectedValueOnce(Object.assign(new Error("Malformed JSON"), { code: "INVALID_MODEL_JSON" }))
      .mockResolvedValueOnce({ object: invalid, model: "mock/max", inputTokens: 3, outputTokens: 4 })
      .mockResolvedValueOnce({ object: stateWorkflow(), model: "mock/repair", inputTokens: 3, outputTokens: 4 });
    const result = await makePlan("Store a preference", undefined, "max");
    expect(result.interactiveWorkflow).toBeDefined();
    expect(result).toMatchObject({ inputTokens: 9, outputTokens: 12 });
    expect(mocks.generateOpenCodePlan).toHaveBeenCalledTimes(4);
  });

  it("recognizes an implemented atomic debit despite a false unimplemented target", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const requirements: StructuredMaxRequirements = { target: "interactive", requiredActions: ["state.debit", "message.dm"], requiredTriggers: ["button"], invariants: ["atomic_debit", "no_duplicate_redemption"] };
    expect(validateStructuredRequirementCapabilities(requirements)).toEqual([]);
    const base = stateWorkflow();
    const workflow = { ...base, workflow: { ...base.workflow, triggers: [{ ...base.workflow.triggers[0], steps: [
      { id: "debit", action: "state.debit", scope: "member", key: "credits", amount: 500, minimumBalance: 500, idempotencyKey: "credits-redemption" },
      { id: "reward", action: "message.dm", recipient: "trigger_member", content: "Redeemed", dependsOn: ["debit"], when: { op: "result.equals", stepId: "debit", field: "debited", value: true } },
    ] }] } };
    mocks.generateOpenCodePlan
      .mockResolvedValueOnce({ object: { ...requirements, target: "unimplemented" }, model: "mock/requirements", inputTokens: 3, outputTokens: 4 })
      .mockResolvedValueOnce({ object: workflow, model: "mock/max", inputTokens: 10, outputTokens: 10 })
      .mockResolvedValue({ object: workflow, model: "mock/max", inputTokens: 2, outputTokens: 2 });
    const result = await makePlan("Debit 500 credits atomically before sending a private redemption confirmation", undefined, "max");
    expect(result.interactiveWorkflow?.triggers[0]?.steps.map((step) => step.action)).toContain("state.debit");
    expect(result.clarification).toBeUndefined();
    expect(mocks.generateOpenCodePlan).toHaveBeenCalledTimes(2);
    expect(result.inputTokens).toBe(13);
  });

  it("repairs clarification that falsely lists a registered capability as missing", async () => {
    process.env.AI_BACKEND = "opencode-server";
    response({ target: "clarification", questions: ["State writes are unavailable"], missingSkills: ["workflow.state.set"] }, { target: "interactive", requiredActions: ["state.set"], requiredTriggers: ["button"], invariants: [] }, [stateWorkflow()]);
    const result = await makePlan("Store a preference", undefined, "max");
    expect(result.interactiveWorkflow).toBeDefined();
    expect(result.clarification).toBeUndefined();
    expect(mocks.generateOpenCodePlan.mock.calls[2]![0]).toContain("incorrectly marks implemented capabilities as missing: workflow.state.set");
  });

  it("accepts weekly calendar triggers as restart-resilient scheduling", async () => {
    process.env.AI_BACKEND = "opencode-server";
    response({ target: "interactive", workflow: {
      version: 1, name: "Weekly", title: "Weekly", description: "Weekly notification", color: "blue", components: [],
      triggers: [{ id: "weekly", event: "schedule.at", dayOfWeek: 6, hour: 18, minute: 0, timeZone: "Asia/Tokyo", steps: [{ id: "notify", action: "message.send", content: "Weekly reminder" }] }],
    } }, { target: "interactive", requiredActions: ["message.send"], requiredTriggers: ["schedule.at"], invariants: ["restart_resilient", "weekly_timezone"] });
    const result = await makePlan("Send a weekly reminder", undefined, "max");
    expect(result.interactiveWorkflow).toBeDefined();
    expect(result.clarification).toBeUndefined();
  });
});
