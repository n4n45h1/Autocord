import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { panelPlanSchema, type PanelPlan } from "./plan.js";
import { generateOpenCodePlan } from "./opencode.js";
import { compileMaxWorkflow, maxAgentWorkflowSchema, type MaxWorkflowOperation, type ResourceWorkflowStep } from "./workflow.js";
import { compileInteractiveWorkflow, type InteractiveWorkflow } from "./interactive-workflow.js";
import { parseResourceWorkflowInput, parseWorkflowSkillInput } from "./skills/registry.js";
import { analyzeRequestRequirements, validatePlanTargetAgainstRequest, validateWorkflowAgainstRequest } from "./requirements.js";
import { structuredMaxRequirementsSchema, validateStructuredRequirementCapabilities, validateStructuredWorkflow, type StructuredMaxRequirements } from "./structured-requirements.js";

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
};

const provider = createOpenAI({
  baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.opencode.ai/v1",
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
});

async function extractStructuredRequirements(instruction: string, model: string, backend: string, fallback?: string): Promise<{ requirements: StructuredMaxRequirements | null; model: string; inputTokens: number; outputTokens: number }> {
  const prompt = `Extract a deterministic requirement contract for this Discord automation request. Do not design a solution. Return exactly {"target":"panel|resources|interactive|unimplemented","requiredActions":["registered action names"],"requiredTriggers":["registered trigger names"],"invariants":["unique_per_member|atomic_debit|no_duplicate_redemption|one_vote_per_member|private_staff_channel|empty_voice_cleanup|restart_resilient|weekly_timezone|game_loop"]}. Include every requested operation, trigger, threshold, uniqueness rule, privacy rule and timing constraint. If any essential behavior has no exact registered action/trigger, mark it as an invariant that requires the missing capability or target=unimplemented. Never omit requirements to make them appear feasible.
Registered action names: entry.join, entry.leave, state.set, state.get, state.increment, state.decrement, state.multiply, state.debit, state.delete, state.reset, state.append, state.remove, math.add, math.subtract, math.multiply, math.divide, math.min, math.max, math.clamp, random.integer, random.choice, random.weighted_choice, collection.add, collection.remove, collection.count, collection.contains, collection.list, collection.rank, collection.clear, workflow.wait, message.send, message.edit, message.reply, message.dm, message.delete, message.pin, message.unpin, resource.channel.create_text, resource.channel.create_category, channel.create_text, channel.create_voice, channel.rename, channel.delete, channel.set_permission, channel.move_member, channel.get_members, role.create, role.grant, role.revoke, role.rename, role.member_count, voice.channel.create, voice.channel.delete, giveaway.create, giveaway.join, giveaway.leave, giveaway.end, giveaway.pause, giveaway.resume, giveaway.reroll, panel.refresh.
Registered triggers: button, select, modal_submit, schedule, schedule.at, deadline, voice.member_join_event, voice.member_leave_event, member.join, member.leave, member.role_added, member.role_removed, message.created, message.deleted, reaction.added, reaction.removed.
Request: ${instruction}`;
  const generate = async (modelName: string) => {
    if (backend === "opencode-server") return generateOpenCodePlan(prompt, modelName, 120_000);
    if (backend !== "openai-compatible") throw new Error(`未対応のAI_BACKENDです: ${backend}`);
    const result = await generateObject({ model: provider(modelName), schema: structuredMaxRequirementsSchema, prompt, temperature: 0, maxOutputTokens: 1200, maxRetries: 1, abortSignal: AbortSignal.timeout(120_000) });
    return { object: result.object, model: result.response.modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
  };
  try {
    const result = await generate(model);
    const parsed = structuredMaxRequirementsSchema.safeParse(result.object);
    return { requirements: parsed.success ? parsed.data : null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  } catch (error) {
    if (!fallback || fallback === model || (error as { status?: number }).status === 429) throw error;
    const result = await generate(fallback);
    const parsed = structuredMaxRequirementsSchema.safeParse(result.object);
    return { requirements: parsed.success ? parsed.data : null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }
}

function normalizeMaxWorkflowOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  const wrapped = !Object.hasOwn(object, "target") && Object.hasOwn(object, "components") && Object.hasOwn(object, "triggers")
    ? { target: "interactive", workflow: object }
    : object;
  if (wrapped.target !== "interactive" || !wrapped.workflow || typeof wrapped.workflow !== "object" || Array.isArray(wrapped.workflow)) return wrapped;
  const workflow = structuredClone(wrapped.workflow) as Record<string, unknown>;
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

export type ExistingInteractiveWorkflow = { id: string; version: number; spec: InteractiveWorkflow };

export async function makePlan(instruction: string, existing?: PanelPlan, mode: AgentMode = "mini", existingWorkflow?: ExistingInteractiveWorkflow, availableManagedRoles: string[] = [], availableVoiceChannels: { id: string; name: string; category: string | null }[] = []): Promise<PlanResult> {
  const model = mode === "max"
    ? process.env.AGENTCORD_MAX_MODEL ?? process.env.OPENCODE_MODEL_MAX ?? "river/deepseek-v4.1-flash"
    : process.env.AGENTCORD_MINI_MODEL ?? process.env.OPENCODE_MODEL_MINI ?? "river/deepseek-v4.1-flash";
  const fallback = process.env.AI_FALLBACK_MODEL;
  const backend = process.env.AI_BACKEND ?? "opencode-server";

  if (mode === "max") {
    const requirements = analyzeRequestRequirements(instruction);
    if (requirements.missingInformation.length) return {
      plan: null, model: "requirements-validator", inputTokens: 0, outputTokens: 0,
      clarification: { questions: requirements.missingInformation, missingSkills: [] },
    };
    if (requirements.unsupportedSkills.length) return {
      plan: null, model: "requirements-validator", inputTokens: 0, outputTokens: 0,
      clarification: { questions: [`要求全体を満たすには未実装機能が必要です: ${requirements.unsupportedSkills.join("、")}。別機能で代用せず、Workflow Planの生成を止めました。`], missingSkills: requirements.unsupportedSkills },
    };
    const structuredExtraction = await extractStructuredRequirements(instruction, model, backend, fallback);
    if (!structuredExtraction.requirements) return {
      plan: null, model: structuredExtraction.model, inputTokens: structuredExtraction.inputTokens, outputTokens: structuredExtraction.outputTokens,
      clarification: { questions: ["構造化要件をローカルSchemaで検証できませんでした。Workflowを生成せず停止しました。"], missingSkills: ["agentcord.max.structured_requirements"] },
    };
    const missingStructuredCapabilities = validateStructuredRequirementCapabilities(structuredExtraction.requirements);
    if (missingStructuredCapabilities.length) return {
      plan: null, model: structuredExtraction.model, inputTokens: structuredExtraction.inputTokens, outputTokens: structuredExtraction.outputTokens,
      clarification: { questions: [`構造化要件に未実装の操作が含まれます: ${missingStructuredCapabilities.join("、")}`], missingSkills: missingStructuredCapabilities },
    };
    const structuredRequirements = structuredExtraction.requirements;
    const extraInputTokens = structuredExtraction.inputTokens;
    const extraOutputTokens = structuredExtraction.outputTokens;
    const prompt = `あなたはAgentcord Maxです。依頼に合わせ、target=panel、target=resources、target=interactive、またはtarget=clarificationから1つ選択してください。target間の混在は禁止です。登録されていない操作を出力してはいけません。任意コード、HTTP、シェル、権限overwrite、Role/Channelの削除は使用不可です。

target=interactiveのラッパーは必ず {"target":"interactive","workflow":{"version":1,"name":"...","title":"...","description":"...","color":"blue|purple|green|red|gray","components":[...],"triggers":[...]}} です。workflowオブジェクトだけの出力は禁止します。component discriminatorはkind、trigger discriminatorはeventです。kindはbutton/select/modal、component trigger eventはbutton/select/modal_submitです。各componentには対応するtriggerIdとtriggerが必要です。Persistent timer triggerはcomponentKeyを持たず、schedule(intervalSeconds 60..604800)またはdeadline(afterSeconds 60..2592000)を使います。

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
既存のGuild Voice Channels (VoiceState triggerのsource候補): ${JSON.stringify(availableVoiceChannels)}。モデルがVoice Channel IDを創作しません。要求されたLobbyを候補から特定できなければclarificationで質問します。
必要な入力が欠けていて実装が決められない場合は、勝手に補完せずtarget=clarification、questionsに必要最小限の質問、missingSkillsに未実装Skillだけを返します。許可Schemaにない要求は実装済みと偽らず、missingSkillsに提案します。形: {"target":"clarification","questions":["..."],"missingSkills":[]}。
依頼: ${instruction}`;
    const requestSpecificRules = [
      requirements.contactForm ? requirements.privateTicketRequested ? "This is a private ticket request. Require a Modal, member-scoped form-state, channel.create_text visibility=staff_only with a preconfigured staffRoleId, message.send delivery=workflow_channel_step to that exact channel step, and a staff-role-guarded channel.delete for the ticket_id submitted through a close Modal. Never send submitted fields to a public channel or Workflow owner DM as a substitute." : "This is an inquiry form. Require a kind=modal component, modal_submit trigger, member-scoped state.set for submitted fields, and message.send delivery=workflow_owner_dm. Never route submitted fields to a public channel." : "",
      requirements.recruitmentCap !== null ? `The requested recruitment cap is exactly ${requirements.recruitmentCap}; use it in entry.join.maxEntries, disabledWhen.entries.gte, and the displayed count.` : "",
      requirements.giveawayRequested ? "This request needs a composed Giveaway workflow: one guarded giveaway.create action, state reference active_giveaway_id, and giveaway.join/leave triggers. The Giveaway Skills already persist/draw unique entries; do not substitute a role panel." : "",
      requirements.unifiedResourceInteraction ? "The request explicitly combines resource provisioning with an interactive feature. Return exactly one target=interactive workflow containing the requested resource.role.create/resource.channel.create_* actions and the interactive actions; do not split it into target=resources." : "",
      requirements.resourceRoleCreate ? "Include resource.role.create for the explicitly requested new Role." : "",
      requirements.resourceCategoryCreate ? "Include resource.channel.create_category for the explicitly requested Category." : "",
      requirements.resourceTextChannelCreate ? "Include resource.channel.create_text for the explicitly requested Text Channel." : "",
      requirements.voiceRequested ? `This is a Voice Lobby lifecycle workflow. The create step when must be {"op":"or","conditions":[{"op":"voice.members.gte","value":${requirements.voiceThreshold ?? 2}},{"op":"voice.session.exists"}]}; delete when must be {"op":"voice.members.eq","value":0}. Use a supplied voice.member_join_event voiceChannelId and a voice.member_leave_event. Never invent a Lobby ID.` : "",
      requirements.unifiedResourceInteraction ? "This request combines resource creation with interactive behavior; select target=interactive and place every requested resource-create action and its UI/trigger in the same Workflow. Do not split it into a resource-only Plan." : "",
      requirements.resourceRoleCreate ? "Include resource.role.create when a Role is explicitly requested." : "",
      requirements.resourceCategoryCreate ? "Include resource.channel.create_category when a Category is explicitly requested." : "",
      requirements.resourceTextChannelCreate ? "Include resource.channel.create_text when a Text Channel is explicitly requested." : "",
    ].filter(Boolean).join("\n");
    const promptWithStateScopes = `${prompt}${requestSpecificRules}\nApplication requirement decomposition: ${JSON.stringify(requirements)}. Max structured extraction: ${JSON.stringify(structuredRequirements)}. Include every required action and trigger; do not silently drop any. The application will verify the generated graph and invariants. Per-step condition field name is exactly when (not condition). Resource-create actions are allowed only on component/modal triggers and their when must be op=and with member.has_permission ManageGuild plus ManageRoles (role.create) or ManageChannels (channel create). Resource actions have no arbitrary permission-overwrite parameters. A successful giveaway.create stores its ID in workflow state active_giveaway_id; giveaway.join/leave/end/pause/resume/reroll must reference {{state:workflow:active_giveaway_id}} and admin actions also require an AND permission guard. A giveaway.join button/select must use disabledWhen state.not_exists(workflow,active_giveaway_id), and the setup trigger must refresh the panel after creating the Giveaway. state.set/state.equals scopes are workflow, guild and member. Use member for individual consent/preferences, guild for shared server-wide state, and workflow for internal flow state. Each step has a stable id and optional dependsOn array referencing steps in the same trigger; the compiler validates the DAG and rejects cycles. Later inputs may safely reference prior results with {{result:stepId:field}}, and conditions may use result.equals(stepId,field,value). Contact data may only be routed to the Workflow owner's DM or a specifically bound staff_only ticket channel, never a public channel.`;
    const timeout = 120_000;
    const run = async (modelName: string, promptText = promptWithStateScopes) => {
      if (backend === "opencode-server") return generateOpenCodePlan(promptText, modelName, timeout);
      if (backend !== "openai-compatible") throw new Error(`未対応のAI_BACKENDです: ${backend}`);
      const result = await generateObject({ model: provider(modelName), schema: maxAgentWorkflowSchema, prompt: promptText, temperature: 0, maxOutputTokens: 3000, maxRetries: 2, abortSignal: AbortSignal.timeout(timeout) });
      return { object: result.object, model: result.response.modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
    };
    let result;
    try {
      result = await run(model);
    } catch (error) {
      if (backend === "opencode-server" && (error as { code?: string }).code === "INVALID_MODEL_JSON") {
        result = await run(model, `${promptWithStateScopes}\nYour previous answer was not valid JSON. Regenerate from scratch. Return exactly one JSON object beginning with { and ending with }; no Markdown, prose or reasoning.`);
      } else {
        if (!fallback || fallback === model || (error as { status?: number }).status === 429) throw error;
        result = await run(fallback);
      }
    }
    let parsedWorkflow = maxAgentWorkflowSchema.safeParse(normalizeMaxWorkflowOutput(result.object));
    if (!parsedWorkflow.success && backend === "opencode-server") {
      const issues = parsedWorkflow.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
      const previousOutput = JSON.stringify(result.object).slice(0, 12_000);
      result = await run(model, `${promptWithStateScopes}\nYour previous output failed local schema validation. Correct the exact fields/actions in the previous JSON; do not invent new operations or drop requested requirements. Validation errors:\n${issues}\nPrevious JSON:\n${previousOutput}\nReturn only the corrected schema-valid wrapper.`);
      parsedWorkflow = maxAgentWorkflowSchema.safeParse(normalizeMaxWorkflowOutput(result.object));
    }
    if (!parsedWorkflow.success) throw parsedWorkflow.error;
    const selected = parsedWorkflow.data;
    if (selected.target === "clarification") return { plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens, clarification: selected };
    if (selected.target !== structuredRequirements.target) return {
      plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens,
      clarification: { questions: [`Structured target (${structuredRequirements.target}) と生成target (${selected.target}) が一致しません。`], missingSkills: [] },
    };
    const targetIssues = validatePlanTargetAgainstRequest(instruction, selected.target);
    if (targetIssues.length) return { plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens, clarification: { questions: targetIssues, missingSkills: requirements.unsupportedSkills } };
    if (selected.target === "resources") {
      if (existing || existingWorkflow) throw new Error("既存Workflow編集と新規リソース作成は別ジョブにしてください。");
      const workflow = parseResourceWorkflowInput(selected.workflow);
      const missingActions = structuredRequirements.requiredActions.filter((action) => !workflow.steps.some((step) => step.action === action));
      if (missingActions.length || structuredRequirements.requiredTriggers.length) return { plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens, clarification: { questions: [`Resource plan omits required actions/triggers: ${[...missingActions, ...structuredRequirements.requiredTriggers].join(", ")}`], missingSkills: [] } };
      return { plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens, resourceSteps: workflow.steps };
    }
    if (selected.target === "interactive") {
      if (existing) throw new Error("既存パネル編集とInteractive Workflow公開/編集は別ジョブにしてください。");
      let compiledWorkflow = compileInteractiveWorkflow(selected.workflow);
      let workflowIssues = [...validateStructuredWorkflow(structuredRequirements, compiledWorkflow), ...validateWorkflowAgainstRequest(instruction, compiledWorkflow)];
      if (workflowIssues.length && backend === "opencode-server") {
        const previousOutput = JSON.stringify(result.object).slice(0, 12_000);
        result = await run(model, `${promptWithStateScopes}\nThe schema-valid Workflow does not satisfy the request-specific application checks. Correct it before returning a new full plan. Issues:\n${workflowIssues.join("\n")}\nPrevious JSON:\n${previousOutput}\nDo not replace the requested feature with a different target.`);
        const repaired = maxAgentWorkflowSchema.safeParse(normalizeMaxWorkflowOutput(result.object));
        if (repaired.success && repaired.data.target === "interactive") {
          compiledWorkflow = compileInteractiveWorkflow(repaired.data.workflow);
          workflowIssues = [...validateStructuredWorkflow(structuredRequirements, compiledWorkflow), ...validateWorkflowAgainstRequest(instruction, compiledWorkflow)];
        } else if (repaired.success) workflowIssues = ["要求を満たすinteractive targetのPlanがありません。"];
        else workflowIssues = repaired.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      }
      if (workflowIssues.length) return { plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens, clarification: { questions: workflowIssues.slice(0, 5), missingSkills: [] } };
      return {
        plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens,
        interactiveWorkflow: compiledWorkflow,
        ...(existingWorkflow ? { interactiveWorkflowId: existingWorkflow.id, expectedWorkflowVersion: existingWorkflow.version } : {}),
      };
    }
    if (existingWorkflow) throw new Error("Existing Interactive Workflow edit must use target=interactive.");
    const workflow = parseWorkflowSkillInput(selected.workflow);
    const workflowActions = new Set(workflow.operations.map((operation) => operation.action));
    const missingActions = structuredRequirements.requiredActions.filter((action) => !workflowActions.has(action as never));
    if (missingActions.length || structuredRequirements.requiredTriggers.length) return { plan: null, model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens, clarification: { questions: [`Panel workflow omits required actions/triggers: ${[...missingActions, ...structuredRequirements.requiredTriggers].join(", ")}`], missingSkills: [] } };
    return { plan: compileMaxWorkflow(existing, workflow), model: result.model, inputTokens: result.inputTokens + extraInputTokens, outputTokens: result.outputTokens + extraOutputTokens, workflowSteps: workflow.operations };
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
