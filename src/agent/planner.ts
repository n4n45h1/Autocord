import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { panelPlanSchema, type PanelPlan } from "./plan.js";
import { generateOpenCodePlan } from "./opencode.js";
import { compileMaxWorkflow, maxAgentWorkflowSchema, type MaxWorkflowOperation, type ResourceWorkflowStep } from "./workflow.js";
import { compileInteractiveWorkflow, type InteractiveWorkflow } from "./interactive-workflow.js";
import { parseResourceWorkflowInput, parseWorkflowSkillInput } from "./skills/registry.js";
import { analyzeRequestRequirements, validateWorkflowAgainstRequest } from "./requirements.js";

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
    if (requirements.unsupportedSkills.length) return {
      plan: null, model: "requirements-validator", inputTokens: 0, outputTokens: 0,
      clarification: { questions: [`要求全体を満たすには未実装機能が必要です: ${requirements.unsupportedSkills.join("、")}。別機能で代用せず、Workflow Planの生成を止めました。`], missingSkills: requirements.unsupportedSkills },
    };
    const prompt = `あなたはAgentcord Maxです。依頼に合わせ、target=panel、target=resources、target=interactive、またはtarget=clarificationから1つ選択してください。target間の混在は禁止です。登録されていない操作を出力してはいけません。任意コード、HTTP、シェル、権限overwrite、Role/Channelの削除は使用不可です。

target=interactiveのラッパーは必ず {"target":"interactive","workflow":{"version":1,"name":"...","title":"...","description":"...","color":"blue|purple|green|red|gray","components":[...],"triggers":[...]}} です。workflowオブジェクトだけの出力は禁止します。component discriminatorはkind、trigger discriminatorはeventです。kindはbutton/select/modal、component trigger eventはbutton/select/modal_submitです。各componentには対応するtriggerIdとtriggerが必要です。Persistent timer triggerはcomponentKeyを持たず、schedule(intervalSeconds 60..604800)またはdeadline(afterSeconds 60..2592000)を使います。

componentの例: {"key":"join","kind":"button","label":"参加","style":"success","emoji":null,"disabledWhen":{"op":"entries.gte","collection":"participants","value":5},"triggerId":"join-trigger"}。
button styleはprimary/secondary/success/danger。Select Menuは最大25 options。Modal inputはkey/label/placeholder/style(short|paragraph)/required/maxLengthです。
triggerの例: {"id":"join-trigger","event":"button","componentKey":"join","steps":[{"id":"register","action":"entry.join","collection":"participants","maxEntries":5},{"id":"refresh","action":"panel.refresh"}]}。schedule triggerの例: {"id":"daily","event":"schedule","intervalSeconds":86400,"steps":[{"id":"refresh","action":"panel.refresh"}]}。trigger stepは最大12、全体24以下です。Timer triggerではmember action/conditionやentry join/leaveを使わず、workflow state update、notify、panel refreshに限定します。

許可action: entry.join(collection,maxEntries)、entry.leave(collection)。State: state.set/get/increment/decrement/multiply/delete/reset/append/remove(scope,key)。数値更新はDB transaction lockで直列化し、append先State listは最大1000件です。Math: math.add/subtract/multiply/divide/min/max/clamp、random.integer/choice/weighted_choice。数値入力には{{state:scope:key}}または依存stepの{{result:stepId:value}}を使えます。Collections: collection.add/remove/count/contains/list/rank/clear(scope,collection)、スコープはworkflow/guild/member、追加上限は既定1000件/collection、最大10000件/collection、20,000 items/Workflow、約10MiB/Workflowです。rankは数値itemのみです。Conditionsはnumber.eq/gt/gte/lt/lte、string.equals/contains/starts_with、list.contains(keyまたはcollection)、state.exists/not_exists、member.has_role/has_permission、time.within、random.chance、result.equalsとネストand/or/not(depth 8, nodes 64)です。state.changed trigger、branch/loop/delayは未実装です。その他: role.grant/revoke(roleName)、message.send(content,delivery)、message.edit(content)、panel.refresh、voice.channel.create(name,moveMembers)、voice.channel.delete、resource.role.create(name)、resource.channel.create_category(name)、resource.channel.create_text(name,topic,categoryStepId)、giveaway.create(prize,durationSeconds,winnerCount)、giveaway.join/leave(giveawayId)、giveaway.end/pause/resume/reroll(giveawayId)。Resource/Giveaway管理Actionはwhen={op:and,conditions:[member.has_permission ManageGuild, member.has_permission ManageRoles|ManageChannels]}を必須にし、実行時にも権限を再検証します。Create Roleは権限なし、Channel overwritesは設定禁止でGuild defaultsを継承します。Text ChannelのcategoryStepIdは同じtriggerのcategory step IDを参照しdependsOnにも含めます。作成したRole/ChannelはAutocord所有として記録します。Giveaway作成はworkflow-owned active_giveaway_id stateを記録します。Voice eventはvoice.member_join_event(voiceChannelId)とvoice.member_leave_eventで、条件voice.members.gte/eq/voice.session.existsを使います。募集VCでは指定Lobbyの入室人数がthreshold以上ならcreateが現在のLobby参加者を新VCへ移動し、leave triggerはvoice.members.eq=0のときだけWorkflow所有VCを削除します。voice.channel.createのsource IDは後述の既存Guild Voice Channelsから選びます。本文templateは{{entries:collection:count}}, {{state:scope:key}}, {{input:key}}, {{selected:index}}, {{actor}}だけ解決します。Workflowのステップ数は各trigger最大12、全体24です。entry変更後はpanel.refreshを追加し、join button/selectにはentry.joinと一致するdisabledWhen entries.gteを指定します。

VALORANT募集の依頼では最小構成を作ります: join/leave用buttonを各1つ、participants collectionを5人上限、Workflow descriptionに{{entries:participants:count}}を含め、join時にentry.join→panel.refresh、leave時にentry.leave→panel.refresh。Voice募集ではavailable voice channelsの中から明示されたLobby IDを選び、join triggerのvoice.members.gteとleave triggerのvoice.members.eq=0を必須にします。別途要求されないゲームモード、段位、追加Modal/通知は勝手に増やしません。Onboardingでは同意button/Modalからmember stateを記録してから、Autocord所有の権限なしroleだけをgrantします。

target=panelは既存パネル1つの編集Plan、target=resourcesはrole.create/channel.create_category/channel.create_textの最大8段階です。Roleは権限なし、ChannelはDiscord既定権限です。既存パネル状態: ${JSON.stringify(existing ?? null)}
既存Interactive Workflow状態（指定されている場合）: ${JSON.stringify(existingWorkflow?.spec ?? null)}。既存Workflowを編集する依頼ではtarget=interactiveを選び、Workflow名/UI/actionのうち明示変更分だけを更新します。workflowId/guildId/channelId/versionを出力せず、アプリケーションがDB値から保持します。
既存のAutocord管理ロール（grant/revoke対象に指定可能）: ${JSON.stringify(availableManagedRoles)}。この一覧以外のRoleをWorkflowから配布しません。必要なRoleが存在しない場合は先にtarget=resourcesでpermissionless roleを作成する計画にします。
既存のGuild Voice Channels (VoiceState triggerのsource候補): ${JSON.stringify(availableVoiceChannels)}。モデルがVoice Channel IDを創作しません。要求されたLobbyを候補から特定できなければclarificationで質問します。
必要な入力が欠けていて実装が決められない場合は、勝手に補完せずtarget=clarification、questionsに必要最小限の質問、missingSkillsに未実装Skillだけを返します。許可Schemaにない要求は実装済みと偽らず、missingSkillsに提案します。形: {"target":"clarification","questions":["..."],"missingSkills":[]}。
依頼: ${instruction}`;
    const requestSpecificRules = [
      requirements.contactForm ? "This is an inquiry form. Require a kind=modal component, modal_submit trigger, member-scoped state.set for submitted fields, and message.send delivery=workflow_owner_dm. Never route submitted fields to a public channel." : "",
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
    const promptWithStateScopes = `${prompt}${requestSpecificRules}\nApplication requirement decomposition: ${JSON.stringify(requirements)}. Match the target, components, triggers, registered Skills and side effects to these requirements. Per-step condition field name is exactly when (not condition). Resource-create actions are allowed only on component/modal triggers and their when must be op=and with member.has_permission ManageGuild plus ManageRoles (role.create) or ManageChannels (channel create). Resource actions have no permission-overwrite parameters. A successful giveaway.create stores its ID in workflow state active_giveaway_id; giveaway.join/leave/end/pause/resume/reroll must reference {{state:workflow:active_giveaway_id}} and admin actions also require an AND permission guard. A giveaway.join button/select must use disabledWhen state.not_exists(workflow,active_giveaway_id), and the setup trigger must refresh the panel after creating the Giveaway. state.set/state.equals scopes are workflow, guild and member. Use member for individual consent/preferences, guild for shared server-wide state, and workflow for internal flow state. Each step has a stable id and optional dependsOn array referencing steps in the same trigger; the compiler validates the DAG and rejects cycles. Later inputs may safely reference prior results with {{result:stepId:field}}, and conditions may use result.equals(stepId,field,value). Contact data may only be routed to the Workflow owner's DM, never a public workflow channel.`;
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
    if (selected.target === "clarification") return { plan: null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, clarification: selected };
    if (selected.target === "resources") {
      if (existing || existingWorkflow) throw new Error("既存Workflow編集と新規リソース作成は別ジョブにしてください。");
      const workflow = parseResourceWorkflowInput(selected.workflow);
      return { plan: null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, resourceSteps: workflow.steps };
    }
    if (selected.target === "interactive") {
      if (existing) throw new Error("既存パネル編集とInteractive Workflow公開/編集は別ジョブにしてください。");
      let compiledWorkflow = compileInteractiveWorkflow(selected.workflow);
      let workflowIssues = validateWorkflowAgainstRequest(instruction, compiledWorkflow);
      if (workflowIssues.length && backend === "opencode-server") {
        const previousOutput = JSON.stringify(result.object).slice(0, 12_000);
        result = await run(model, `${promptWithStateScopes}\nThe schema-valid Workflow does not satisfy the request-specific application checks. Correct it before returning a new full plan. Issues:\n${workflowIssues.join("\n")}\nPrevious JSON:\n${previousOutput}\nDo not replace the requested feature with a different target.`);
        const repaired = maxAgentWorkflowSchema.safeParse(normalizeMaxWorkflowOutput(result.object));
        if (repaired.success && repaired.data.target === "interactive") {
          compiledWorkflow = compileInteractiveWorkflow(repaired.data.workflow);
          workflowIssues = validateWorkflowAgainstRequest(instruction, compiledWorkflow);
        } else if (repaired.success) workflowIssues = ["要求を満たすinteractive targetのPlanがありません。"];
        else workflowIssues = repaired.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      }
      if (workflowIssues.length) return { plan: null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, clarification: { questions: workflowIssues.slice(0, 5), missingSkills: [] } };
      return {
        plan: null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        interactiveWorkflow: compiledWorkflow,
        ...(existingWorkflow ? { interactiveWorkflowId: existingWorkflow.id, expectedWorkflowVersion: existingWorkflow.version } : {}),
      };
    }
    if (existingWorkflow) throw new Error("Existing Interactive Workflow edit must use target=interactive.");
    const workflow = parseWorkflowSkillInput(selected.workflow);
    return { plan: compileMaxWorkflow(existing, workflow), model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, workflowSteps: workflow.operations };
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
