import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { panelPlanSchema, type PanelPlan } from "./plan.js";
import { generateOpenCodePlan } from "./opencode.js";
import { compileMaxWorkflow, maxAgentWorkflowSchema, maxWorkflowSchema, type MaxWorkflowOperation, type ResourceWorkflowStep } from "./workflow.js";
import { parseResourceWorkflowInput, parseWorkflowSkillInput } from "./skills/registry.js";

export type AgentMode = "mini" | "max";
export type PlanResult = { plan: PanelPlan | null; model: string; inputTokens: number; outputTokens: number; workflowSteps?: MaxWorkflowOperation[]; resourceSteps?: ResourceWorkflowStep[] };

const provider = createOpenAI({
  baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.opencode.ai/v1",
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
});

export async function makePlan(instruction: string, existing?: PanelPlan, mode: AgentMode = "mini"): Promise<PlanResult> {
  const model = mode === "max"
    ? process.env.AGENTCORD_MAX_MODEL ?? process.env.OPENCODE_MODEL_MAX ?? "river/deepseek-v4.1-flash"
    : process.env.AGENTCORD_MINI_MODEL ?? process.env.OPENCODE_MODEL_MINI ?? "river/deepseek-v4.1-flash";
  const fallback = process.env.AI_FALLBACK_MODEL;
  const backend = process.env.AI_BACKEND ?? "opencode-server";
  if (mode === "max") {
    const prompt = `あなたはAgentcord Maxです。利用可能なSkillsはパネル編集、および権限なしRole/Text Channel/Categoryの作成だけです。依頼に合うtargetを1つ選び、依存関係のある最大8ステップのJSON Workflowを作ってください。未知Skill、権限付与、削除、任意API、シェル操作は使えません。Markdownや説明文を付けずschema一致のJSONだけ返してください。\n既存パネルが渡された場合はtarget=panelのみを選び、そのパネルだけ編集します。target=panelの形は {"target":"panel","workflow":{"version":1,"operations":[{"id":"step-1","dependsOn":[],"action":"panel.set_title","value":"..."}]}}。パネル操作はpanel.set_title(value)、panel.set_description(value)、panel.set_color(value:blue|purple|green|red|gray)、panel.set_render_mode(value:classic|components_v2)、panel.set_selection_mode(value:single|multiple)、panel.set_component_style(value:select|buttons)、option.add(key,label,roleName,emoji)、option.remove(key)、option.rename_role(key,roleName)、option.set_label(key,label)、option.set_emoji(key,emoji)。option.add/option.set_emojiのemojiは文字列かnullです。既存ロールはパネルから除外しても削除しません。\ntarget=resourcesはrole.create(name)、channel.create_category(name)、channel.create_text(name,topic,categoryStepId)の依存付きstepを作ります。新規チャンネルには権限overwritesを指定できず、サーバー既定の権限を継承します。categoryStepIdを指定するchannel.create_textはそのCategory stepをdependsOnに含めます。形は {"target":"resources","workflow":{"version":1,"steps":[{"id":"step-1","dependsOn":[],"action":"role.create","name":"Member"}]}}。\n既存パネル状態: ${JSON.stringify(existing ?? null)}\n依頼: ${instruction}`;
    const timeout = 120_000;
    const run = async (modelName: string) => {
      if (backend === "opencode-server") return generateOpenCodePlan(prompt, modelName, timeout);
      if (backend !== "openai-compatible") throw new Error(`未対応のAI_BACKENDです: ${backend}`);
      const result = await generateObject({ model: provider(modelName), schema: maxAgentWorkflowSchema, prompt, temperature: 0, maxOutputTokens: 3000, maxRetries: 2, abortSignal: AbortSignal.timeout(timeout) });
      return { object: result.object, model: result.response.modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
    };
    let result;
    try {
      result = await run(model);
    } catch (error) {
      if (!fallback || fallback === model || (error as { status?: number }).status === 429) throw error;
      result = await run(fallback);
    }
    const workflow = maxAgentWorkflowSchema.parse(result.object);
    if (workflow.target === "resources") {
      if (existing) throw new Error("既存パネルの編集依頼にリソース作成Workflowは使えません。");
      const resourceWorkflow = parseResourceWorkflowInput(workflow.workflow);
      return { plan: null, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, resourceSteps: resourceWorkflow.steps };
    }
    const panelWorkflow = parseWorkflowSkillInput(workflow.workflow);
    const plan = compileMaxWorkflow(existing, panelWorkflow);
    return { plan, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, workflowSteps: panelWorkflow.operations };
  }
  const prompt = `あなたはAgentcord ${mode === "mini" ? "Mini" : "Max"}です。日本語Discordロールパネル操作の型付き計画だけを作成してください。権限付与・削除・任意API・シェル操作は禁止です。既存パネルを渡された場合、選択肢・roleNameは既存を保持し、明示依頼された変更だけを反映します。選択肢から外れたロールは削除せず、その後のパネルで参照しないだけにします。\n必ず次のキーと型に一致するJSONオブジェクト1個だけを返してください。Markdown、コードフェンス、説明文は付けません。\n{"intent":"create|edit","panelId":null,"expectedRevision":null,"title":"string","description":"string","color":"blue|purple|green|red|gray","renderMode":"classic|components_v2","selectionMode":"single|multiple","componentStyle":"select|buttons","channelId":null,"options":[{"key":"lowercase_key","label":"string","roleName":"string","emoji":null}]}\n新規パネルのrenderModeはcomponents_v2を基本とし、既存状態を編集する際は明示指示がなければrenderModeを維持します。createではpanelIdとexpectedRevisionをnullにし、editでは既存状態にあるIDとrevisionをそのまま使います。optionsは1〜25件、buttonsでは最大5件です。\n既存状態: ${JSON.stringify(existing ?? null)}\n依頼: ${instruction}`;
  if (backend === "opencode-server") {
    const timeout = mode === "mini" ? 45_000 : 120_000;
    let result;
    try {
      result = await generateOpenCodePlan(prompt, model, timeout);
    } catch (error) {
      if (!fallback || fallback === model || (error as { status?: number }).status === 429) throw error;
      result = await generateOpenCodePlan(prompt, fallback, timeout);
    }
    const plan = panelPlanSchema.parse(result.object);
    if (existing && (plan.intent !== "edit" || plan.panelId !== existing.panelId || plan.expectedRevision !== existing.expectedRevision)) {
      throw new Error("Agentcordが選択中パネルに紐づく編集計画を返しませんでした。");
    }
    return { plan, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }
  if (backend !== "openai-compatible") throw new Error(`未対応のAI_BACKENDです: ${backend}`);
  const compatibleModel = process.env.AGENTCORD_MINI_MODEL ?? process.env.AI_MODEL_MINI ?? process.env.AI_MODEL ?? "deepseek-v4.1-flash-free";
  const run = async (modelName: string) => generateObject({
    model: provider(modelName),
    schema: panelPlanSchema,
    prompt,
    temperature: 0,
    maxOutputTokens: mode === "mini" ? 1200 : 3000,
    maxRetries: 2,
    abortSignal: AbortSignal.timeout(mode === "mini" ? 45_000 : 120_000),
  });
  let result;
  try {
    result = await run(compatibleModel);
  } catch (error) {
    if (!fallback || fallback === compatibleModel || (error as { status?: number }).status === 429) throw error;
    result = await run(fallback);
  }
  const plan = panelPlanSchema.parse(result.object);
  if (existing && (plan.intent !== "edit" || plan.panelId !== existing.panelId || plan.expectedRevision !== existing.expectedRevision)) {
    throw new Error("Agentcordが選択中パネルに紐づく編集計画を返しませんでした。");
  }
  return {
    plan,
    model: result.response.modelId,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  };
}
