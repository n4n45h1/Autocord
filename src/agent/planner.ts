import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { panelPlanSchema, type PanelPlan } from "./plan.js";
import { generateOpenCodePlan } from "./opencode.js";
import { compileMaxWorkflow, maxAgentWorkflowSchema, type MaxWorkflowOperation, type ResourceWorkflowStep } from "./workflow.js";
import { compileInteractiveWorkflow, interactiveWorkflowSchema, type InteractiveWorkflow } from "./interactive-workflow.js";
import { agentSkills, parseResourceWorkflowInput, parseWorkflowSkillInput } from "./skills/registry.js";
import { analyzeRequestRequirements, validatePlanTargetAgainstRequest, validateWorkflowAgainstRequest } from "./requirements.js";
import { structuredMaxRequirementsSchema, structuredRequirementCatalog, validateStructuredRequirementCapabilities, validateStructuredWorkflow, type StructuredMaxRequirements } from "./structured-requirements.js";

export type AgentMode = "mini" | "max";
export type PlanResult = {
  plan: PanelPlan | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  workflowSteps?: MaxWorkflowOperation[];
  resourceSteps?: ResourceWorkflowStep[];
  interactiveWorkflow?: InteractiveWorkflow;
  interactiveWorkflowId?: string;
  expectedWorkflowVersion?: number;
  clarification?: { questions: string[]; missingSkills: string[] };
  diagnostics?: {
    preflight?: { unsupportedSkills: string[]; missingInformation: string[] };
    structuredRequirements?: StructuredMaxRequirements;
    plannerAttempts?: number;
    structuredExtractionAttempts?: number;
    repairAttempts?: number;
    validationIssues?: string[];
    attempts?: { attempt: number; target?: string; outputShape?: { keys: string[]; target?: unknown; hasWorkflow: boolean }; actions?: string[]; triggers?: string[]; components?: unknown; candidateGraph?: unknown; issues: string[] }[];
  };
};

const provider = createOpenAI({
  baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.opencode.ai/v1",
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
});

// Preserve recursive conditions and shared skill schemas using local JSON Schema references.
const maxPlannerContract = JSON.stringify({
  catalog: structuredRequirementCatalog,
  skills: Object.fromEntries(Object.entries(agentSkills).map(([id, { inputSchema, ...definition }]) => [id, definition])),
  schema: z.toJSONSchema(z.object({
    plan: maxAgentWorkflowSchema,
    compiledInteractiveWorkflow: interactiveWorkflowSchema,
    requirements: structuredMaxRequirementsSchema,
    skillInputs: z.object(Object.fromEntries(Object.entries(agentSkills).map(([id, definition]) => [id, definition.inputSchema]))),
  }), { io: "input", cycles: "ref", reused: "ref" }),
});

const maxPlannerRules = `The following is the complete current schema and registered skill catalog, not an output wrapper. Resolve local $ref references. Planning output must match schema.properties.plan; extraction output must match schema.properties.requirements. Compiled interactive workflows must also satisfy compiledInteractiveWorkflow and local compiler checks; JSON Schema does not encode every refinement.
${maxPlannerContract}
Use only fields declared for the selected action/event; additionalProperties=false is strict. Never add source metadata to steps, triggers or the output. state.set/reset/append/remove values are scalar (string, number, boolean, null), never objects or arrays. Store separate fields in separate state keys; use {{input:field}} and {{result:stepId:field}} strings, not reference objects. resource.channel.create_text and resource target channel.create_text require topic and categoryStepId, each nullable; use a category step ID plus dependsOn when requested, otherwise null. For point awards, use exactly one entry.join(maxEntries=1000) and a matching disabledWhen entries.gte guard; increment member points by 100 only when that action returns joined=true. Use state.debit(scope=member,key=points,amount=500,minimumBalance=500,idempotencyKey=game-key) for exchange; this DB transaction atomically checks balance and claims the stable redemption key, preventing double debit across clicks. Send the requested confirmation only on result.equals(debitStep,debited,true). Do not add collection.add, state.set/get, unrelated actions or waits unless expressly requested; number.gte conditions can inspect member State directly. For one-vote reaction thresholds, partition Collections by the exact message, add item={{input:authorId}}, count that partition, and owner-DM only under an AND when {result.equals(addStep,added,true), result.equals(countStep,count,threshold)}; both result steps must be in dependsOn. atomic_debit and no_duplicate_redemption are supported invariants, not missing capabilities. Do not downgrade or silently drop any requested requirement. All earlier required actions, triggers and invariants remain binding during repairs.`;

async function extractStructuredRequirements(instruction: string, applicationRequirements: ReturnType<typeof analyzeRequestRequirements>, model: string, backend: string, fallback?: string): Promise<{ requirements: StructuredMaxRequirements | null; model: string; inputTokens: number; outputTokens: number; attempts: number }> {
  const prompt = `Extract a deterministic requirement contract for this Discord automation request. Do not design a solution. Return exactly {"target":"panel|resources|interactive|unimplemented","requiredActions":["registered action names"],"requiredTriggers":["registered trigger names"],"invariants":["unique_per_member|atomic_debit|no_duplicate_redemption|one_vote_per_member|private_staff_channel|empty_voice_cleanup|restart_resilient|weekly_timezone|game_loop"]}. Include every requested operation, trigger, threshold, uniqueness rule, privacy rule and timing constraint. If any essential behavior has no exact registered action/trigger, mark it as an invariant that requires the missing capability or target=unimplemented. Never omit requirements to make them appear feasible.
Choose requiredActions from catalog.actions for the selected target, and requiredTriggers from catalog.triggers (interactive only). Invariants are semantic requirements, not action names. Use target=unimplemented only for an essential capability genuinely absent from the current contract, not for supported atomic state debit.
${maxPlannerRules}
Request: ${instruction}`;
  const generate = async (modelName: string, promptText = prompt) => {
    if (backend === "opencode-server") return generateOpenCodePlan(promptText, modelName, 120_000);
    if (backend !== "openai-compatible") throw new Error(`未対応のAI_BACKENDです: ${backend}`);
    const result = await generateObject({ model: provider(modelName), schema: structuredMaxRequirementsSchema, prompt: promptText, temperature: 0, maxOutputTokens: 1200, maxRetries: 1, abortSignal: AbortSignal.timeout(120_000) });
    return { object: result.object, model: result.response.modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
  };
  let activeModel = model;
  let promptText = prompt;
  let latestModel = model;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 0; attempt <= 2; attempt++) {
    let result;
    try {
      result = await generate(activeModel, promptText);
    } catch (error) {
      if ((error as { code?: string }).code === "INVALID_MODEL_JSON") {
        if (attempt === 2) return { requirements: null, model: latestModel, inputTokens, outputTokens, attempts: attempt + 1 };
        promptText = `${prompt}\nYour previous response was not valid JSON. Return exactly one complete JSON object matching the requirements schema. No prose or Markdown.`;
        continue;
      }
      if (attempt === 2 || !fallback || fallback === activeModel || (error as { status?: number }).status === 429) throw error;
      activeModel = fallback;
      promptText = prompt;
      continue;
    }
    if (!result || typeof result !== "object") {
      if (attempt === 2) return { requirements: null, model: latestModel, inputTokens, outputTokens, attempts: attempt + 1 };
      promptText = `${prompt}\nYour previous response was empty or not an object. Return exactly one complete JSON object matching the requirements schema.`;
      continue;
    }
    latestModel = result.model;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    const parsed = structuredMaxRequirementsSchema.safeParse(result.object);
    if (parsed.success) return { requirements: normalizeStructuredRequirements(parsed.data, applicationRequirements, instruction), model: result.model, inputTokens, outputTokens, attempts: attempt + 1 };
    if (attempt === 2) return { requirements: null, model: result.model, inputTokens, outputTokens, attempts: attempt + 1 };
    const issues = parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    promptText = `${prompt}\nYour previous structured extraction failed local Schema validation. Preserve all intent but correct the schema fields exactly. Errors:\n${issues}\nPrevious JSON:\n${JSON.stringify(result.object)}\nReturn only valid JSON.`;
  }
  return { requirements: null, model: latestModel, inputTokens, outputTokens, attempts: 3 };
}

function normalizeMaxWorkflowOutput(value: unknown, targetHint?: StructuredMaxRequirements["target"]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  let wrapped = !Object.hasOwn(object, "target") && Object.hasOwn(object, "components") && Object.hasOwn(object, "triggers")
    ? { target: "interactive", workflow: object }
    : object;
  const validTargets = new Set(["panel", "resources", "interactive", "clarification"]);
  if (targetHint && !validTargets.has(String(wrapped.target)) && wrapped.workflow && typeof wrapped.workflow === "object" && !Array.isArray(wrapped.workflow)) wrapped = { ...wrapped, target: targetHint };
  if (wrapped.target !== "interactive" || !wrapped.workflow || typeof wrapped.workflow !== "object" || Array.isArray(wrapped.workflow)) return wrapped;
  const normalizeTemplateAliases = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/\{\{(?:member|user|interaction:member):(?:id|mention)\}\}/g, "{{actor}}");
    if (Array.isArray(value)) return value.map(normalizeTemplateAliases);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeTemplateAliases(child)]));
    return value;
  };
  const workflow = normalizeTemplateAliases(structuredClone(wrapped.workflow)) as Record<string, unknown>;
  const normalizeCondition = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const condition = value as Record<string, unknown>;
    if (typeof condition.permission === "string") {
      const permissionKey = condition.permission.toLocaleLowerCase().replace(/[ _-]/g, "");
      const permissions: Record<string, string> = { manageguild: "ManageGuild", manageserver: "ManageGuild", manageroles: "ManageRoles", managechannels: "ManageChannels", managevoicechannels: "ManageChannels", administrator: "Administrator" };
      if (permissions[permissionKey]) condition.permission = permissions[permissionKey];
    }
    if (Array.isArray(condition.conditions)) for (const nested of condition.conditions) normalizeCondition(nested);
    if (condition.condition) normalizeCondition(condition.condition);
  };
  if (Array.isArray(workflow.components)) for (const component of workflow.components) {
    if (component && typeof component === "object") normalizeCondition((component as Record<string, unknown>).disabledWhen);
  }
  if (Array.isArray(workflow.triggers)) for (const trigger of workflow.triggers) {
    if (!trigger || typeof trigger !== "object" || !Array.isArray((trigger as Record<string, unknown>).steps)) continue;
    const triggerFields = trigger as Record<string, unknown>;
    if (triggerFields.event === "voice.member_join_event" && triggerFields.voiceChannelId && typeof triggerFields.voiceChannelId === "object" && !Array.isArray(triggerFields.voiceChannelId)) {
      const voiceChannel = triggerFields.voiceChannelId as Record<string, unknown>;
      if (typeof voiceChannel.id === "string") triggerFields.voiceChannelId = voiceChannel.id;
    }
    if (triggerFields.event === "voice.member_leave_event") delete triggerFields.voiceChannelId;
    for (const step of (trigger as { steps: unknown[] }).steps) {
      if (!step || typeof step !== "object") continue;
      const fields = step as Record<string, unknown>;
      if (fields.when === undefined && fields.condition !== undefined) fields.when = fields.condition;
      delete fields.condition;
      normalizeCondition(fields.when);
    }
  }
  return { ...wrapped, workflow };
}

function normalizeStructuredRequirements(extracted: StructuredMaxRequirements, request: ReturnType<typeof analyzeRequestRequirements>, instruction: string): StructuredMaxRequirements {
  const availableActions = new Set<string>(Object.values(structuredRequirementCatalog.actions).flat());
  const availableTriggers = new Set<string>(structuredRequirementCatalog.triggers);
  const normalizeAction = (action: string) => availableActions.has(action) ? action : action.startsWith("workflow.") && availableActions.has(action.slice("workflow.".length)) ? action.slice("workflow.".length) : action;
  const normalizeTrigger = (trigger: string) => availableTriggers.has(trigger) ? trigger : trigger.startsWith("workflow.") && availableTriggers.has(trigger.slice("workflow.".length)) ? trigger.slice("workflow.".length) : trigger;
  let target = extracted.target;
  if (request.contactForm || request.giveawayRequested || request.pointsRequested || request.privateTicketRequested || request.voteRequested || request.voiceRequested || request.recruitmentCap !== null || request.unifiedResourceInteraction || extracted.requiredActions.some((action) => ["state.debit", "workflow.wait", "channel.create_text", "channel.create_voice"].includes(action)) || extracted.requiredTriggers.some((trigger) => !["button", "select", "modal_submit"].includes(trigger))) target = "interactive";
  else if (request.resourceCreate) target = "resources";
  const conditionOperators = new Set(["number.eq", "number.gt", "number.gte", "number.lt", "number.lte", "math.eq", "math.gte", "string.equals", "string.contains", "string.starts_with", "list.contains", "state.exists", "state.not_exists", "member.has_role", "member.has_permission", "time.within", "random.chance", "result.equals", "voice.members.gte", "voice.members.eq", "voice.session.exists", "and", "or", "not"]);
  const triggerNames = new Set<string>(structuredRequirementCatalog.triggers);
  const actions = new Set<string>(extracted.requiredActions.map(normalizeAction).filter((action) => !triggerNames.has(action)).filter((action) => target !== "interactive" || !action.startsWith("panel.") && !action.startsWith("option.")).filter((action) => !conditionOperators.has(action)));
  if (target === "interactive") {
    if (actions.delete("role.create")) actions.add("resource.role.create");
    if (actions.delete("channel.create_category")) actions.add("resource.channel.create_category");
    if (actions.has("channel.create_text") && !request.privateTicketRequested) {
      actions.delete("channel.create_text");
      actions.add("resource.channel.create_text");
    }
    if (request.pointsRequested) {
      if (!/残高.*(?:表示|見せ)|(?:show|display).*balance/i.test(instruction)) actions.delete("state.get");
      if (!/取消|取り消し|cancel|leave/i.test(instruction)) actions.delete("entry.leave");
      if (!/告知|全体に|チャンネルに通知|announcement/i.test(instruction)) actions.delete("message.send");
      if (!/在庫|item|inventory/i.test(instruction)) actions.delete("collection.add");
      if (!/reply|返信/i.test(instruction)) actions.delete("message.reply");
      if (!/schedule|定期|期限|待機|wait/i.test(instruction)) actions.delete("workflow.wait");
      if (!/state\.decrement|別途.*減|decrement separately/i.test(instruction)) actions.delete("state.decrement");
      for (const action of ["state.set", "role.grant", "role.revoke", "resource.role.create", "collection.add", "collection.contains"]) actions.delete(action);
      actions.add("entry.join");
    }
    if (request.privateTicketRequested) {
      for (const action of [...actions]) if (!["channel.create_text", "state.set", "message.send", "channel.delete", "panel.refresh"].includes(action)) actions.delete(action);
      for (const action of ["channel.create_text", "state.set", "message.send", "channel.delete"]) actions.add(action);
    }
    if (request.voiceRequested) {
      const allowed = new Set(["voice.channel.create", "voice.channel.delete", "panel.refresh", ...(/通知|announce|notify/i.test(instruction) ? ["message.send"] : [])]);
      for (const action of [...actions]) if (!allowed.has(action)) actions.delete(action);
    }
    if (request.voteRequested) {
      actions.delete("message.dm");
      actions.delete("message.reply");
      if (!/票数.*(?:表示|更新)|(?:display|update).*vote count/i.test(instruction)) actions.delete("message.edit");
      if (!/schedule|定期|期限|待機|wait/i.test(instruction)) actions.delete("workflow.wait");
      for (const action of ["entry.join", "entry.leave", "state.set", "state.get", "state.increment", "state.decrement", "state.multiply", "state.debit", "state.append", "state.remove", "state.delete", "state.reset", "collection.remove", "collection.clear", "role.grant", "role.revoke", "channel.create_text", "channel.delete"]) actions.delete(action);
    }
    if (request.pointsRequested) {
      for (const action of ["entry.join", "state.increment", "state.debit", "message.dm"]) actions.add(action);
    }
    if (request.privateTicketRequested) for (const action of ["channel.create_text", "state.set", "message.send", "channel.delete"]) actions.add(action);
    if (request.voteRequested) for (const action of ["message.send", "collection.add", "collection.count"]) actions.add(action);
    if (request.voiceRequested) for (const action of ["voice.channel.create", "voice.channel.delete"]) actions.add(action);
    if (request.recruitmentCap !== null) for (const action of ["entry.join", "entry.leave", "panel.refresh"]) actions.add(action);
    if (request.giveawayRequested) for (const action of ["giveaway.create", "giveaway.join", "giveaway.leave"]) actions.add(action);
    if (request.resourceRoleCreate) actions.add("resource.role.create");
    if (request.resourceCategoryCreate) actions.add("resource.channel.create_category");
    if (request.resourceTextChannelCreate) actions.add("resource.channel.create_text");
    if (request.weeklyScheduleRequested) {
      actions.add("workflow.wait");
      if (request.weeklyResetAfterEvent) actions.add("collection.clear");
    }
  }
  const triggers = new Set<string>(extracted.requiredTriggers.map(normalizeTrigger));
  if (target === "interactive") {
    if (request.contactForm || request.privateTicketRequested) triggers.add("modal_submit");
    if (request.pointsRequested) triggers.add("button");
    if (request.pointsRequested) {
      triggers.delete("select");
      if (!request.contactForm && !request.privateTicketRequested) triggers.delete("modal_submit");
    }
    if (request.voteRequested) {
      triggers.add("reaction.added");
      triggers.delete("reaction.removed");
      triggers.delete("select");
      if (/modal|フォーム/i.test(instruction)) { triggers.add("modal_submit"); triggers.delete("button"); }
      else { triggers.add("button"); triggers.delete("modal_submit"); }
    }
    if (request.voiceRequested) for (const event of ["voice.member_join_event", "voice.member_leave_event"]) triggers.add(event);
    if (request.recruitmentCap !== null) triggers.add("button");
    if (request.weeklyScheduleRequested) triggers.add("schedule.at");
    if (request.privateTicketRequested && !request.pointsRequested && !request.voteRequested && request.recruitmentCap === null && !request.giveawayRequested) { triggers.delete("button"); triggers.delete("select"); }
    if (request.privateTicketRequested && !request.pointsRequested && !request.voteRequested && request.recruitmentCap === null && !request.giveawayRequested && !request.voiceRequested) {
      triggers.clear();
      triggers.add("modal_submit");
    }
    if (request.voiceRequested && !request.pointsRequested && !request.privateTicketRequested && !request.voteRequested && request.recruitmentCap === null && !request.giveawayRequested) {
      for (const event of ["button", "select", "modal_submit", "schedule", "schedule.at", "deadline", "member.join", "member.leave", "member.role_added", "member.role_removed", "message.created", "message.deleted", "reaction.added", "reaction.removed"]) triggers.delete(event);
    }
    if (request.pointsRequested && !request.privateTicketRequested && !request.contactForm && !request.voteRequested) for (const event of ["select", "modal_submit"]) triggers.delete(event);
    if (request.privateTicketRequested && !request.pointsRequested && !request.voteRequested && !request.recruitmentCap) for (const event of ["button", "select"]) triggers.delete(event);
    if (request.voteRequested) for (const event of ["select", "modal_submit", "reaction.removed"]) triggers.delete(event);
  }
  const recognizedFeature = request.pointsRequested || request.privateTicketRequested || request.contactForm || request.voteRequested || request.voiceRequested || request.weeklyScheduleRequested || request.giveawayRequested || request.recruitmentCap !== null || request.unifiedResourceInteraction;
  if (recognizedFeature && target === "interactive") {
    const allowed = new Set<string>(["panel.refresh"]);
    if (request.pointsRequested) for (const action of ["entry.join", "state.increment", "state.debit", "message.dm"]) allowed.add(action);
    if (request.privateTicketRequested) for (const action of ["channel.create_text", "state.set", "state.get", "message.send", "channel.delete"]) allowed.add(action);
    else if (request.contactForm) for (const action of ["state.set", "message.send"]) allowed.add(action);
    if (request.voteRequested) for (const action of ["message.send", "collection.add", "collection.count"]) allowed.add(action);
    if (request.voiceRequested) for (const action of ["voice.channel.create", "voice.channel.delete", ...(/通知|announce|notify/i.test(instruction) ? ["message.send"] : [])]) allowed.add(action);
    if (request.weeklyScheduleRequested) for (const action of ["workflow.wait", "collection.clear", "state.reset", "message.send"]) allowed.add(action);
    if (request.giveawayRequested) for (const action of ["giveaway.create", "giveaway.join", "giveaway.leave"]) allowed.add(action);
    if (request.recruitmentCap !== null) for (const action of ["entry.join", "entry.leave"]) allowed.add(action);
    if (request.resourceRoleCreate) allowed.add("resource.role.create");
    if (request.resourceCategoryCreate) allowed.add("resource.channel.create_category");
    if (request.resourceTextChannelCreate) allowed.add("resource.channel.create_text");
    for (const action of [...actions]) if (!allowed.has(action)) actions.delete(action);
    for (const action of allowed) if (action !== "panel.refresh" && action !== "entry.leave" && action !== "collection.clear" && action !== "state.reset" && action !== "state.get") actions.add(action);
  }
  const invariants = new Set(extracted.invariants);
  if (request.pointsRequested) { invariants.add("unique_per_member"); invariants.add("atomic_debit"); invariants.add("no_duplicate_redemption"); }
  if (request.privateTicketRequested) { invariants.add("private_staff_channel"); invariants.add("unique_per_member"); }
  if (!request.voteRequested) invariants.delete("one_vote_per_member");
  if (!request.privateTicketRequested) invariants.delete("private_staff_channel");
  if (!request.voiceRequested) invariants.delete("empty_voice_cleanup");
  if (!request.weeklyScheduleRequested) invariants.delete("weekly_timezone");
  if (!request.pointsRequested && request.recruitmentCap === null && !request.privateTicketRequested && !request.voteRequested && !request.giveawayRequested) invariants.delete("unique_per_member");
  if (!request.pointsRequested && !actions.has("state.debit")) { invariants.delete("atomic_debit"); invariants.delete("no_duplicate_redemption"); }
  if (!/\brpg\b|戦士|魔法使い|僧侶/i.test(instruction)) invariants.delete("game_loop");
  if (!/再起動|restart|復旧|persist|永続|schedule|定期|期限|遅延|wait/i.test(instruction)) invariants.delete("restart_resilient");
  return { ...extracted, target, requiredActions: [...actions], requiredTriggers: [...triggers], invariants: [...invariants] };
}

export type ExistingInteractiveWorkflow = { id: string; version: number; spec: InteractiveWorkflow };

export async function makePlan(instruction: string, existing?: PanelPlan, mode: AgentMode = "mini", existingWorkflow?: ExistingInteractiveWorkflow, availableManagedRoles: string[] = [], availableVoiceChannels: { id: string; name: string; category: string | null }[] = [], availableStaffRoles: { id: string; name: string }[] = []): Promise<PlanResult> {
  const model = mode === "max"
    ? process.env.AGENTCORD_MAX_MODEL ?? process.env.OPENCODE_MODEL_MAX ?? "river/deepseek-v4.1-flash"
    : process.env.AGENTCORD_MINI_MODEL ?? process.env.OPENCODE_MODEL_MINI ?? "river/deepseek-v4.1-flash";
  const fallback = process.env.AI_FALLBACK_MODEL;
  const backend = process.env.AI_BACKEND ?? "opencode-server";

  if (mode === "max") {
    const requirements = analyzeRequestRequirements(instruction);
    const diagnostics: NonNullable<PlanResult["diagnostics"]> = { preflight: { unsupportedSkills: requirements.unsupportedSkills, missingInformation: requirements.missingInformation }, plannerAttempts: 0, repairAttempts: 0, validationIssues: [], attempts: [] };
    if (requirements.missingInformation.length) return {
      plan: null, model: "requirements-validator", inputTokens: 0, outputTokens: 0,
      clarification: { questions: requirements.missingInformation, missingSkills: [] },
      diagnostics,
    };
    if (requirements.unsupportedSkills.length) return {
      plan: null, model: "requirements-validator", inputTokens: 0, outputTokens: 0,
      clarification: { questions: [`要求全体を満たすには未実装機能が必要です: ${requirements.unsupportedSkills.join("、")}。別機能で代用せず、Workflow Planの生成を止めました。`], missingSkills: requirements.unsupportedSkills },
      diagnostics,
    };
    if (requirements.privateTicketRequested && !availableStaffRoles.length && !/\b\d{17,20}\b/.test(instruction)) return {
      plan: null, model: "requirements-validator", inputTokens: 0, outputTokens: 0,
      clarification: { questions: ["Staff-only ticketには閲覧許可する既存Staff Roleが必要です。Support等のGuild Role IDを指定してください。"], missingSkills: [] },
      diagnostics,
    };
    const structuredExtraction = await extractStructuredRequirements(instruction, requirements, model, backend, fallback);
    diagnostics.structuredExtractionAttempts = structuredExtraction.attempts;
    diagnostics.repairAttempts = Math.max(0, structuredExtraction.attempts - 1);
    if (!structuredExtraction.requirements) return {
      plan: null, model: structuredExtraction.model, inputTokens: structuredExtraction.inputTokens, outputTokens: structuredExtraction.outputTokens,
      clarification: { questions: ["構造化要件をローカルSchemaで検証できませんでした。Workflowを生成せず停止しました。"], missingSkills: ["agentcord.max.structured_requirements"] },
      diagnostics,
    };
    const structuredRequirements = normalizeStructuredRequirements(structuredExtraction.requirements, requirements, instruction);
    diagnostics.structuredRequirements = structuredRequirements;
    const missingStructuredCapabilities = validateStructuredRequirementCapabilities(structuredRequirements);
    if (missingStructuredCapabilities.length) return {
      plan: null, model: structuredExtraction.model, inputTokens: structuredExtraction.inputTokens, outputTokens: structuredExtraction.outputTokens,
      clarification: { questions: [`構造化要件に未実装の操作が含まれます: ${missingStructuredCapabilities.join("、")}`], missingSkills: missingStructuredCapabilities },
      diagnostics,
    };
    const extraInputTokens = structuredExtraction.inputTokens;
    const extraOutputTokens = structuredExtraction.outputTokens;
    const prompt = `あなたはAgentcord Maxです。依頼に合わせ、target=panel、target=resources、target=interactive、またはtarget=clarificationから1つ選択してください。target間の混在は禁止です。登録されていない操作を出力してはいけません。任意コード、HTTP、シェル、任意の権限overwrite、Role削除は禁止です。Workflow所有Channelの削除と宣言済みpermission presetのみ、対応Schemaと実行時権限チェックに従って使用できます。

target=interactiveのラッパーは必ず {"target":"interactive","workflow":{"version":1,"name":"...","title":"...","description":"...","color":"blue|purple|green|red|gray","components":[...],"triggers":[...]}} です。workflowオブジェクトだけの出力は禁止します。component discriminatorはkind、trigger discriminatorはeventです。kindはbutton/select/modal、component trigger eventはbutton/select/modal_submitです。各componentには対応するtriggerIdとtriggerが必要です。kind=modal component自体がModal opener buttonとして公開されるので、既存panel IDや別のopen buttonは不要です。Workflowは/agent実行中の現在チャンネルへpublishされます。Persistent timer triggerはcomponentKeyを持たず、schedule(intervalSeconds 60..604800)、schedule.at(dayOfWeek,hour,minute,timeZone)、またはdeadline(afterSeconds 60..2592000)を使います。

componentの例: {"key":"join","kind":"button","label":"参加","style":"success","emoji":null,"disabledWhen":{"op":"entries.gte","collection":"participants","value":5},"triggerId":"join-trigger"}。
button styleはprimary/secondary/success/danger。Select Menuは最大25 options。Modal inputはkey/label/placeholder/style(short|paragraph)/required/maxLengthです。
triggerの例: {"id":"join-trigger","event":"button","componentKey":"join","steps":[{"id":"register","action":"entry.join","collection":"participants","maxEntries":5},{"id":"refresh","action":"panel.refresh"}]}。interval scheduleの例: {"id":"daily","event":"schedule","intervalSeconds":86400,"steps":[{"id":"wait","action":"workflow.wait","seconds":60},{"id":"refresh","action":"panel.refresh","dependsOn":["wait"]}]}。Weekly calendar triggerは{"id":"saturday","event":"schedule.at","dayOfWeek":6,"hour":18,"minute":0,"timeZone":"Asia/Tokyo","steps":[...]}。TimezoneはIANA名、dayOfWeekは0=Sunday..6=Saturdayで、DSTを考慮して次回occurrenceをDBに保存します。Gateway events: member.join/leave/role_added/role_removed(roleId)、message.created/deleted(channelId)、reaction.added/removed(channelId,messageStepId,emoji)。message/reaction eventはBot自身の投稿とBot userのreactionを無視します。Member eventはENABLE_GUILD_MEMBERS_INTENT=trueとDiscord Developer Portalのprivileged intent設定が必要で、default off。message.createdのcontent読取もENABLE_MESSAGE_CONTENT_INTENT=trueとPortal設定が必要でdefault off。Trigger stepは最大12、全体24以下です。

許可action: entry.join/leave。State: state.set/get/increment/decrement/multiply/debit/delete/reset/append/remove(scope,key)。数値更新と条件付き引落しはDB transaction lock内で原子的に行います。ポイント配布はentry.joinのjoined=trueに依存させ、state.debitのdebited=true後だけ景品通知してください。State list最大1000。Math: add/subtract/multiply/divide/min/max/clamp、Random: integer/choice/weighted_choice。Collections: add/remove/count/contains/list/rank/clear(scope,collection)、既定1000・最大10000件/collection、20,000 rows・約10MiB/Workflow。Conditions: number.eq/gt/gte/lt/lte、string.equals/contains/starts_with、list.contains、state.exists/not_exists、member.has_role/has_permission、time.within、random.chance、result.equalsとbounded nested and/or/not(depth 8,nodes 64)。各step whenで条件分岐、Workflow.wait(seconds 1..2592000)はPostgreSQLへ保存し再起動後も再開します。任意JS/loopは不可。前step resultは{{result:stepId:value}}で参照しdependsOn必須。
Discord actions: role.grant/revoke/rename/member_count。message.send/edit/reply/dm/delete/pin/unpin、channel.create_text/create_voice/rename/delete/set_permission/move_member/get_members、既存resource.channel.create_category/create_textとvoice.channel.create/delete。channel.create_textのvisibility presetはguild_default/private_member/staff_only。Private ticket channelはmemberごとに冪等作成し、staff_onlyでは指定RoleとBot以外を閲覧許可しません。message.send delivery=workflow_channel_stepは同じtriggerのWorkflow-owned text-channel step resultを必須とし、依頼入力をstaff ticketに送れます。channel.deleteはWorkflow-owned channelのみで、ticketは作成memberかstaffRoleのみ、それ以外はManageGuild+ManageChannelsを再確認します。message.edit/delete/pin/unpinはWorkflowが作ったmessage step resultだけを対象にします。message.replyはmessage.created contextだけ、message.dmはexplicit interactionでtrigger memberかowner、scheduled triggerではownerだけで最大5 sends/runです。Channel permission presetはViewChannel/SendMessages/ReadMessageHistoryだけを設定し、role overwriteや権限昇格はありません。Role renameは同Workflow所有Roleだけ、dangerous permissions自動付与なし。Manager resource actionsにはANDでmember.has_permission ManageGuildとManageRoles/ManageChannelsが必要で、実行直前もBot/user権限と所有権を再検証します。
Gateway events: member eventsはprivileged GuildMembers intent default off、message contentはprivileged MessageContent intent default off。Bot自身のmessage/reactionはskipし、Bot role update eventも抑制します。state.changed、loop、長時間実行中のin-flight checkpoint cancellationは未実装。Workflowは/Autocord workflow-pause、workflow-resume、workflow-disable、workflow-deleteで制御します。deleteは定義/UI/タイマー/待機を無効化しますが、所有Role/Channelは誤削除防止のためDB追跡を残し、Discord資源は削除しません。

VALORANT募集の依頼では最小構成を作ります: join/leave用buttonを各1つ、participants collectionを5人上限、Workflow descriptionに{{entries:participants:count}}を含め、join時にentry.join→panel.refresh、leave時にentry.leave→panel.refresh。Voice募集ではavailable voice channelsの中から明示されたLobby IDを選び、join triggerのvoice.members.gteとleave triggerのvoice.members.eq=0を必須にします。別途要求されないゲームモード、段位、追加Modal/通知は勝手に増やしません。Onboardingでは同意button/Modalからmember stateを記録してから、Autocord所有の権限なしroleだけをgrantします。

target=panelは既存パネル1つの編集Plan、target=resourcesはrole.create/channel.create_category/channel.create_textの最大8段階です。Roleは権限なし、ChannelはDiscord既定権限です。既存パネル状態: ${JSON.stringify(existing ?? null)}
既存Interactive Workflow状態（指定されている場合）: ${JSON.stringify(existingWorkflow?.spec ?? null)}。既存Workflowを編集する依頼ではtarget=interactiveを選び、Workflow名/UI/actionのうち明示変更分だけを更新します。workflowId/guildId/channelId/versionを出力せず、アプリケーションがDB値から保持します。
既存のAutocord管理ロール（grant/revoke対象に指定可能）: ${JSON.stringify(availableManagedRoles)}。この一覧以外のRoleをWorkflowから配布しません。必要なRoleが存在しない場合は先にtarget=resourcesでpermissionless roleを作成する計画にします。
Staff-only ticket presetで参照できる既存Guild roles (ID/name、Roleの権限は変更不可): ${JSON.stringify(availableStaffRoles)}。staffRoleIdにはこの一覧のIDだけを使い、Role IDを創作しません。
既存のGuild Voice Channels (VoiceState triggerのsource候補): ${JSON.stringify(availableVoiceChannels)}。モデルがVoice Channel IDを創作しません。要求されたLobbyを候補から特定できなければclarificationで質問します。
必要な入力が欠けていて実装が決められない場合は、勝手に補完せずtarget=clarification、questionsに必要最小限の質問、missingSkillsに未実装Skillだけを返します。許可Schemaにない要求は実装済みと偽らず、missingSkillsに提案します。形: {"target":"clarification","questions":["..."],"missingSkills":[]}。
依頼: ${instruction}`;
    const requestSpecificRules = [
      requirements.pointsRequested ? "For redemption, use action=message.dm recipient=trigger_member. Do not substitute message.reply, message.send, or delivery=workflow_owner_dm because those do not DM the requester. Do not add entry.leave unless cancellation was explicitly requested." : "",
      requirements.pointsRequested ? "For this point system, register participation with one entry.join(maxEntries=1000) and a matching disabledWhen entries.gte guard. Increment member points by 100 only when entry.join returns joined=true. Use state.debit with key=points, amount=500, minimumBalance=500 and idempotencyKey=game-key; this blocks duplicate redemption across separate clicks. Send one trigger_member DM only when result.equals(debitStep,debited,true). Use message.dm, not message.send or message.reply. Do not add a duplicate Collection registration or unrelated state.set/role actions." : "",
      requirements.voteRequested ? `This is a unique reaction vote. Create one proposal message from a button trigger unless the user explicitly requested a Modal, and bind reaction.added to that messageStepId. Use collection.add(scope=workflow,partitionByMessage=true,item={{input:authorId}}), then collection.count on the same partition. Notify workflow_owner only with message.send delivery=workflow_owner_dm under AND conditions result.equals(addStep,added,true) and result.equals(countStep,count,${requirements.voteThreshold ?? 20}); depend on both result steps. Do not add state.set notification flags, collection.remove triggers, extra DMs, message.edit live-count updates, workflow.wait, or other actions unless explicitly requested; the added=true condition is the one-time threshold guard.` : "",
      requirements.contactForm ? requirements.privateTicketRequested ? "This is a private ticket request. Require a Modal, channel.create_text visibility=staff_only with the supplied staffRoleId, and exactly one member-scoped state.set that stores the created channelId for idempotent reopen/owner close. Send every form field directly with {{input:key}} to message.send delivery=workflow_channel_step targeting that exact channel creation step; state.set returns only key/scope, so do not reference state.set result values. For staff close, add a separate close Modal with a ticket_id field and channel.delete {channelStepId:null,channelId:'{{input:ticket_id}}'} guarded by member.has_role for the configured staff Role; do not reference a creation step across triggers. message.reply is only valid in a message.created trigger and must not be used here. The runtime permits the ticket creator to close only their own ticket and clears ticket_channel_id; do not add state.get/state.delete. Do not add role/category creation, a second permission action, or DM acknowledgements. Never send submitted fields to a public channel or owner-DM as a substitute." : "This is an inquiry form. Require a kind=modal component, modal_submit trigger, member-scoped state.set for submitted fields, and message.send delivery=workflow_owner_dm. Never route submitted fields to a public channel." : "",
      requirements.recruitmentCap !== null ? `The requested recruitment cap is exactly ${requirements.recruitmentCap}; use it in entry.join.maxEntries, disabledWhen.entries.gte, and the displayed count.` : "",
      requirements.giveawayRequested ? "This request needs a composed Giveaway workflow: one guarded giveaway.create action, state reference active_giveaway_id, and giveaway.join/leave triggers. The Giveaway Skills already persist/draw unique entries; do not substitute a role panel." : "",
      requirements.unifiedResourceInteraction ? "The request explicitly combines resource provisioning with an interactive feature. Return exactly one target=interactive workflow containing the requested resource.role.create/resource.channel.create_* actions and the interactive actions; do not split it into target=resources." : "",
      requirements.resourceRoleCreate ? "Include resource.role.create for the explicitly requested new Role." : "",
      requirements.resourceCategoryCreate ? "Include resource.channel.create_category for the explicitly requested Category." : "",
      requirements.resourceTextChannelCreate ? "Include resource.channel.create_text for the explicitly requested Text Channel." : "",
      requirements.voiceRequested ? `This is a Voice Lobby lifecycle workflow, not button signup. The create step when must be {"op":"or","conditions":[{"op":"voice.members.gte","value":${requirements.voiceThreshold ?? 2}},{"op":"voice.session.exists"}]}; set voice.channel.create.moveMembers=true; delete when must be {"op":"voice.members.eq","value":0}. Use a supplied voice.member_join_event voiceChannelId and a voice.member_leave_event. Components may be empty; no status button, join button, entry collection, state flags or wait is needed. Use the configured Lobby name as the VC base name, or a short default such as team. Do not add a second channel.create_voice/channel.move_member path. Never invent a Lobby ID.` : "",
      requirements.unifiedResourceInteraction ? "This request combines resource creation with interactive behavior; select target=interactive and place every requested resource-create action and its UI/trigger in the same Workflow. Do not split it into a resource-only Plan." : "",
      requirements.resourceRoleCreate ? "Include resource.role.create when a Role is explicitly requested." : "",
      requirements.resourceCategoryCreate ? "Include resource.channel.create_category when a Category is explicitly requested." : "",
      requirements.resourceTextChannelCreate ? "Include resource.channel.create_text when a Text Channel is explicitly requested." : "",
    ].filter(Boolean).join("\n");
    const promptWithStateScopes = `${prompt}\n${requestSpecificRules}\n${maxPlannerRules}\nApplication requirement decomposition: ${JSON.stringify(requirements)}. Max structured extraction: ${JSON.stringify(structuredRequirements)}. Include every required action and trigger; do not silently drop any. The application will verify the generated graph and invariants. Per-step condition field name is exactly when (not condition). Resource-create actions are allowed only on component/modal triggers and their when must be op=and with member.has_permission ManageGuild plus ManageRoles (role.create) or ManageChannels (channel create). Resource actions have no arbitrary permission-overwrite parameters. A successful giveaway.create stores its ID in workflow state active_giveaway_id; giveaway.join/leave/end/pause/resume/reroll must reference {{state:workflow:active_giveaway_id}} and admin actions also require an AND permission guard. A giveaway.join button/select must use disabledWhen state.not_exists(workflow,active_giveaway_id), and the setup trigger must refresh the panel after creating the Giveaway. state.set/state.equals scopes are workflow, guild and member. Use member for individual consent/preferences, guild for shared server-wide state, and workflow for internal flow state. Each step has a stable id and optional dependsOn array referencing steps in the same trigger; the compiler validates the DAG and rejects cycles. Later inputs may safely reference prior results with {{result:stepId:field}}, and conditions may use result.equals(stepId,field,value). Contact data may only be routed to the Workflow owner's DM or a specifically bound staff_only ticket channel, never a public channel.`;
    const timeout = 120_000;
    const run = async (modelName: string, promptText = promptWithStateScopes) => {
      if (backend === "opencode-server") return generateOpenCodePlan(promptText, modelName, timeout);
      if (backend !== "openai-compatible") throw new Error(`未対応のAI_BACKENDです: ${backend}`);
      const result = await generateObject({ model: provider(modelName), schema: maxAgentWorkflowSchema, prompt: promptText, temperature: 0, maxOutputTokens: 3000, maxRetries: 2, abortSignal: AbortSignal.timeout(timeout) });
      return { object: result.object, model: result.response.modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
    };
    let promptText = promptWithStateScopes;
    let activeModel = model;
    let inputTokens = extraInputTokens;
    let outputTokens = extraOutputTokens;
    let resultModel = model;
    // One shared budget covers invalid JSON, schema, compilation and semantic repairs.
    for (let attempt = 0; attempt <= 2; attempt++) {
      diagnostics.plannerAttempts = attempt + 1;
      const attemptTrace: NonNullable<NonNullable<PlanResult["diagnostics"]>["attempts"]>[number] = { attempt: attempt + 1, issues: [] };
      diagnostics.attempts!.push(attemptTrace);
      let result;
      try {
        result = await run(activeModel, promptText);
      } catch (error) {
        if ((error as { code?: string }).code === "INVALID_MODEL_JSON") {
          if (attempt === 2) return { plan: null, model: resultModel, inputTokens, outputTokens, clarification: { questions: ["Planner output was not valid JSON after bounded repair."], missingSkills: [] }, diagnostics };
          diagnostics.repairAttempts = (diagnostics.repairAttempts ?? 0) + 1;
          promptText = `${promptWithStateScopes}\nYour previous answer was not valid JSON. Return exactly one full schema-valid JSON object; no Markdown, prose or reasoning.`;
          continue;
        }
        if (attempt === 2 || !fallback || fallback === activeModel || (error as { status?: number }).status === 429) throw error;
        activeModel = fallback;
        continue;
      }
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      resultModel = result.model;
      const metadata = { model: resultModel, inputTokens, outputTokens, diagnostics: structuredClone(diagnostics) };
      if (result.object && typeof result.object === "object" && !Array.isArray(result.object)) {
        const raw = result.object as Record<string, unknown>;
        attemptTrace.outputShape = { keys: Object.keys(raw), target: raw.target, hasWorkflow: Boolean(raw.workflow && typeof raw.workflow === "object") };
      }
      let issues: string[];
      try {
        const selected = maxAgentWorkflowSchema.parse(normalizeMaxWorkflowOutput(result.object, structuredRequirements.target));
        attemptTrace.target = selected.target;
        if (selected.target === "interactive") {
          attemptTrace.actions = [...new Set(selected.workflow.triggers.flatMap((trigger) => trigger.steps.map((step) => step.action)))];
          attemptTrace.triggers = selected.workflow.triggers.map((trigger) => trigger.event);
          attemptTrace.components = selected.workflow.components;
          attemptTrace.candidateGraph = selected.workflow.triggers.map((trigger) => ({ event: trigger.event, steps: trigger.steps }));
        }
        if (selected.target === "clarification") {
          attemptTrace.issues = [...selected.questions, ...selected.missingSkills.map((skill) => `missingSkill:${skill}`)];
          const supportedSkills = selected.missingSkills.filter((skill) => Object.hasOwn(agentSkills, skill)
            || Object.values(structuredRequirementCatalog.actions).some((actions) => actions.some((action) => action === skill))
            || structuredRequirementCatalog.triggers.some((trigger) => trigger === skill)
            || skill === "atomic_debit" || skill === "no_duplicate_redemption");
          if (supportedSkills.length) throw new Error(`Clarification incorrectly marks implemented capabilities as missing: ${supportedSkills.join(", ")}`);
          const requestedRoleId = instruction.match(/\b\d{17,20}\b/)?.[0];
          const likelyStaffRoles = availableStaffRoles.filter((role) => /support|staff|mod|サポート|スタッフ/i.test(role.name));
          const staffRoleIsDeterministic = !selected.questions.some((question) => /role|ロール|staff|support|スタッフ|サポート/i.test(question))
            || Boolean(requestedRoleId && (!availableStaffRoles.length || availableStaffRoles.some((role) => role.id === requestedRoleId)))
            || likelyStaffRoles.length === 1;
          if (requirements.privateTicketRequested && staffRoleIsDeterministic && selected.questions.length && selected.questions.every((question) => /field|項目|modal|フォーム|category|カテゴリ|close|閉じ|ticket.?id|チケットID|panel|channel|チャンネル|role|ロール|staff|support|staffRoleId|スタッフ|サポート/i.test(question))) {
            throw new Error("Application defaults resolve ticket setup details: use Modal fields subject and detail, member state key ticket_channel_id, no Category, reuse one active ticket per member, and provide separate creator and staff close controls. Use only the supplied/existing staffRoleId; create no staff Role.");
          }
          if (requirements.pointsRequested && selected.questions.length && selected.questions.every((question) => /scope|スコープ|button|ボタン|exchange|交換.*(?:button|ボタン)|dm|DM|文言|本文|景品名|idempotencyKey|固定キー/i.test(question)
            || !/delete|削除|remove|消去/i.test(instruction) && /削除予定|削除するリソース|既存.*(?:panel|workflow)|role deletion|Role削除/i.test(question))) {
            throw new Error("Application defaults resolve the point-system details: member scope, separate join and redemption buttons, fixed idempotencyKey=game-key, generic exchange-confirmation DM, no inventory payload, and no resource deletion unless requested. Re-plan without asking these clarifications.");
          }
          if (requirements.voiceRequested && requirements.voiceThreshold !== null && availableVoiceChannels.length === 1 && selected.questions.length && selected.questions.every((question) => /Lobby|ボイスチャンネル|Voice Channel|一時VC|ベース名|名前|category|カテゴリ|作成先|移動/i.test(question))) {
            throw new Error(`Only one Voice Channel candidate exists (${availableVoiceChannels[0]!.id}); use it as the Lobby, use the default team channel name, move the Lobby occupants, and inherit the Lobby category. Do not ask for these defaults.`);
          }
          return { plan: null, ...metadata, diagnostics: structuredClone(diagnostics), clarification: selected };
        }
        if (selected.target !== structuredRequirements.target) throw new Error(`Structured target (${structuredRequirements.target}) does not match generated target (${selected.target}).`);
        const targetIssues = validatePlanTargetAgainstRequest(instruction, selected.target);
        if (targetIssues.length) throw new Error(targetIssues.join("\n"));
        if (selected.target === "interactive") {
          if (existing) throw new Error("既存パネル編集とInteractive Workflow公開/編集は別ジョブにしてください。");
          const compiledWorkflow = compileInteractiveWorkflow(selected.workflow);
          const workflowIssues = [...validateStructuredWorkflow(structuredRequirements, compiledWorkflow), ...validateWorkflowAgainstRequest(instruction, compiledWorkflow)];
          if (workflowIssues.length) throw new Error(workflowIssues.join("\n"));
          return {
            plan: null, ...metadata, diagnostics: structuredClone(diagnostics), interactiveWorkflow: compiledWorkflow,
            ...(existingWorkflow ? { interactiveWorkflowId: existingWorkflow.id, expectedWorkflowVersion: existingWorkflow.version } : {}),
          };
        }
        if (selected.target === "resources") {
          if (existing || existingWorkflow) throw new Error("既存Workflow編集と新規リソース作成は別ジョブにしてください。");
          const workflow = parseResourceWorkflowInput(selected.workflow);
          const missingActions = structuredRequirements.requiredActions.filter((action) => !workflow.steps.some((step) => step.action === action));
          if (missingActions.length || structuredRequirements.requiredTriggers.length || structuredRequirements.invariants.length) throw new Error(`Resource plan omits required actions/triggers/invariants: ${[...missingActions, ...structuredRequirements.requiredTriggers, ...structuredRequirements.invariants].join(", ")}`);
          return { plan: null, ...metadata, diagnostics: structuredClone(diagnostics), resourceSteps: workflow.steps };
        }
        if (existingWorkflow) throw new Error("Existing Interactive Workflow edit must use target=interactive.");
        const workflow = parseWorkflowSkillInput(selected.workflow);
        const missingActions = structuredRequirements.requiredActions.filter((action) => !workflow.operations.some((operation) => operation.action === action));
        if (missingActions.length || structuredRequirements.requiredTriggers.length || structuredRequirements.invariants.length) throw new Error(`Panel workflow omits required actions/triggers/invariants: ${[...missingActions, ...structuredRequirements.requiredTriggers, ...structuredRequirements.invariants].join(", ")}`);
        return { plan: compileMaxWorkflow(existing, workflow), ...metadata, diagnostics: structuredClone(diagnostics), workflowSteps: workflow.operations };
      } catch (error) {
        issues = error instanceof z.ZodError
          ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          : [error instanceof Error ? error.message : String(error)];
      }
      diagnostics.validationIssues = issues;
      attemptTrace.issues = issues;
      if (attempt === 2) return { plan: null, ...metadata, diagnostics: structuredClone(diagnostics), clarification: { questions: issues.slice(0, 5), missingSkills: [] } };
      diagnostics.repairAttempts = (diagnostics.repairAttempts ?? 0) + 1;
      promptText = `${promptWithStateScopes}\nYour previous output failed local schema, compilation or requirement validation. Correct the exact fields/actions in the full previous JSON. Do not drop required actions, triggers or invariants, invent operations, or replace the requested target. Validation errors:\n${issues.join("\n")}\nPrevious JSON:\n${JSON.stringify(result.object)}\nReturn only the corrected schema-valid wrapper.`;
    }
    throw new Error("Planner repair budget exhausted.");
  }

  const prompt = `あなたはAgentcord Miniです。ロールパネル作成/編集だけを計画してください。権限付与、削除、任意API、シェル操作は禁止です。既存パネルの選択肢とroleNameは維持し、明示依頼の変更だけを反映します。選択肢から外れたRole自体は削除しません。

次のShapeに一致するJSONオブジェクト1つだけを返します。説明やMarkdownは禁止です。
{"intent":"create|edit","panelId":null,"expectedRevision":null,"title":"string","description":"string","color":"blue|purple|green|red|gray","renderMode":"classic|components_v2","selectionMode":"single|multiple","componentStyle":"select|buttons","channelId":null,"options":[{"key":"lowercase_key","label":"string","roleName":"string","emoji":null}]}

新規時panelId/expectedRevisionはnull、編集時は既存ID/revisionを維持します。optionsは1〜25件、button式は5件までです。既存状態: ${JSON.stringify(existing ?? null)}
依頼: ${instruction}`;
  const compatibleModel = process.env.AGENTCORD_MINI_MODEL ?? process.env.AI_MODEL_MINI ?? process.env.AI_MODEL ?? "deepseek-v4.1-flash-free";
  const timeout = 45_000;
  if (backend === "opencode-server") {
    let result;
    try {
      result = await generateOpenCodePlan(prompt, model, timeout);
    } catch (error) {
      if (!fallback || fallback === model || (error as { status?: number }).status === 429) throw error;
      result = await generateOpenCodePlan(prompt, fallback, timeout);
    }
    const plan = panelPlanSchema.parse(result.object);
    if (existing && (plan.intent !== "edit" || plan.panelId !== existing.panelId || plan.expectedRevision !== existing.expectedRevision)) throw new Error("Agentcordが選択中パネルに紐づく編集計画を返しませんでした。");
    return { plan, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }
  if (backend !== "openai-compatible") throw new Error(`未対応のAI_BACKENDです: ${backend}`);
  const run = async (modelName: string) => generateObject({ model: provider(modelName), schema: panelPlanSchema, prompt, temperature: 0, maxOutputTokens: 1200, maxRetries: 2, abortSignal: AbortSignal.timeout(timeout) });
  let result;
  try {
    result = await run(compatibleModel);
  } catch (error) {
    if (!fallback || fallback === compatibleModel || (error as { status?: number }).status === 429) throw error;
    result = await run(fallback);
  }
  const plan = panelPlanSchema.parse(result.object);
  if (existing && (plan.intent !== "edit" || plan.panelId !== existing.panelId || plan.expectedRevision !== existing.expectedRevision)) throw new Error("Agentcordが選択中パネルに紐づく編集計画を返しませんでした。");
  return { plan, model: result.response.modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
}
