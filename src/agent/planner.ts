import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { panelPlanSchema, type PanelPlan } from "./plan.js";
import { generateOpenCodePlan } from "./opencode.js";
import { compileMaxWorkflow, maxAgentWorkflowSchema, type MaxWorkflowOperation, type ResourceWorkflowStep } from "./workflow.js";
import { compileInteractiveWorkflow, type InteractiveWorkflow } from "./interactive-workflow.js";
import { parseResourceWorkflowInput, parseWorkflowSkillInput } from "./skills/registry.js";

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
  return !Object.hasOwn(object, "target") && Object.hasOwn(object, "components") && Object.hasOwn(object, "triggers")
    ? { target: "interactive", workflow: object }
    : object;
}

export type ExistingInteractiveWorkflow = { id: string; version: number; spec: InteractiveWorkflow };

export async function makePlan(instruction: string, existing?: PanelPlan, mode: AgentMode = "mini", existingWorkflow?: ExistingInteractiveWorkflow, availableManagedRoles: string[] = []): Promise<PlanResult> {
  const model = mode === "max"
    ? process.env.AGENTCORD_MAX_MODEL ?? process.env.OPENCODE_MODEL_MAX ?? "river/deepseek-v4.1-flash"
    : process.env.AGENTCORD_MINI_MODEL ?? process.env.OPENCODE_MODEL_MINI ?? "river/deepseek-v4.1-flash";
  const fallback = process.env.AI_FALLBACK_MODEL;
  const backend = process.env.AI_BACKEND ?? "opencode-server";

  if (mode === "max") {
    const prompt = `あなたはAgentcord Maxです。依頼に合わせ、target=panel、target=resources、target=interactive、またはtarget=clarificationから1つ選択してください。target間の混在は禁止です。登録されていない操作を出力してはいけません。任意コード、HTTP、シェル、権限overwrite、Role/Channelの削除は使用不可です。

target=interactiveのラッパーは必ず {"target":"interactive","workflow":{"version":1,"name":"...","title":"...","description":"...","color":"blue|purple|green|red|gray","components":[...],"triggers":[...]}} です。workflowオブジェクトだけの出力は禁止します。component discriminatorはkind、trigger discriminatorはeventです。kindはbutton/select/modal、component trigger eventはbutton/select/modal_submitです。各componentには対応するtriggerIdとtriggerが必要です。Persistent timer triggerはcomponentKeyを持たず、schedule(intervalSeconds 60..604800)またはdeadline(afterSeconds 60..2592000)を使います。

componentの例: {"key":"join","kind":"button","label":"参加","style":"success","emoji":null,"disabledWhen":{"op":"entries.gte","collection":"participants","value":5},"triggerId":"join-trigger"}。
button styleはprimary/secondary/success/danger。Select Menuは最大25 options。Modal inputはkey/label/placeholder/style(short|paragraph)/required/maxLengthです。
triggerの例: {"id":"join-trigger","event":"button","componentKey":"join","steps":[{"id":"register","action":"entry.join","collection":"participants","maxEntries":5},{"id":"refresh","action":"panel.refresh"}]}。schedule triggerの例: {"id":"daily","event":"schedule","intervalSeconds":86400,"steps":[{"id":"refresh","action":"panel.refresh"}]}。trigger stepは最大12、全体24以下です。Timer triggerではmember action/conditionやentry join/leaveを使わず、workflow state update、notify、panel refreshに限定します。

許可action: entry.join(collection,maxEntries)、entry.leave(collection)、state.set(scope,key,value)、role.grant/revoke(roleName)、message.send(content)、message.edit(content)、panel.refresh。Workflow条件はentries.lt/gte、state.equals、member.has_role、member.has_permission、time.within(startAt,endAt)、and/orです。本文templateは{{entries:collection:count}}, {{state:scope:key}}, {{input:key}}, {{selected:index}}, {{actor}}だけ解決します。loop、任意ID、未登録actionは不可です。entry変更後はpanel.refreshを追加し、join button/selectにはentry.joinと一致するdisabledWhen entries.gteを指定します。

VALORANT募集の依頼では最小構成を作ります: join/leave用buttonを各1つ、participants collectionを5人上限、Workflow descriptionに{{entries:participants:count}}を含め、join時にentry.join→panel.refresh、leave時にentry.leave→panel.refresh。別途要求されないゲームモード、段位、追加Modal/通知は勝手に増やしません。Onboardingでは同意button/Modalからmember stateを記録してから、Autocord所有の権限なしroleだけをgrantします。

target=panelは既存パネル1つの編集Plan、target=resourcesはrole.create/channel.create_category/channel.create_textの最大8段階です。Roleは権限なし、ChannelはDiscord既定権限です。既存パネル状態: ${JSON.stringify(existing ?? null)}
既存Interactive Workflow状態（指定されている場合）: ${JSON.stringify(existingWorkflow?.spec ?? null)}。既存Workflowを編集する依頼ではtarget=interactiveを選び、Workflow名/UI/actionのうち明示変更分だけを更新します。workflowId/guildId/channelId/versionを出力せず、アプリケーションがDB値から保持します。
既存のAutocord管理ロール（grant/revoke対象に指定可能）: ${JSON.stringify(availableManagedRoles)}。この一覧以外のRoleをWorkflowから配布しません。必要なRoleが存在しない場合は先にtarget=resourcesでpermissionless roleを作成する計画にします。
必要な入力が欠けていて実装が決められない場合は、勝手に補完せずtarget=clarification、questionsに必要最小限の質問、missingSkillsに未実装Skillだけを返します。許可Schemaにない要求は実装済みと偽らず、missingSkillsに提案します。形: {"target":"clarification","questions":["..."],"missingSkills":[]}。
依頼: ${instruction}`;
    const promptWithStateScopes = `${prompt}\nstate.set/state.equals scopes are workflow, guild and member. Use member for individual consent/preferences, guild for shared server-wide state, and workflow for internal flow state. Each step has a stable id and optional dependsOn array referencing steps in the same trigger; the compiler validates the DAG and rejects cycles. Later inputs may safely reference prior results with {{result:stepId:field}}, and conditions may use result.equals(stepId,field,value).`;
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
      result = await run(model, `${promptWithStateScopes}\nYour previous output failed local schema validation. Remove every unsupported action/field and regenerate the complete JSON. Validation errors:\n${issues}\nReturn only one schema-valid target wrapper.`);
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
      return {
        plan: null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        interactiveWorkflow: compileInteractiveWorkflow(selected.workflow),
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
