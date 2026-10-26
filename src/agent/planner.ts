import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { panelPlanSchema, type PanelPlan } from "./plan.js";

export type AgentMode = "mini" | "max";
export type PlanResult = { plan: PanelPlan; model: string; inputTokens: number; outputTokens: number };

const provider = createOpenAI({
  baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.opencode.ai/v1",
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
});

export async function makePlan(instruction: string, existing?: PanelPlan, mode: AgentMode = "mini"): Promise<PlanResult> {
  const model = mode === "max"
    ? process.env.AGENTCORD_MAX_MODEL ?? process.env.AI_MODEL_MAX ?? "deepseek-v4.1-flash-free"
    : process.env.AGENTCORD_MINI_MODEL ?? process.env.AI_MODEL_MINI ?? process.env.AI_MODEL ?? "deepseek-v4.1-flash-free";
  const fallback = process.env.AI_FALLBACK_MODEL;
  const prompt = `あなたはAgentcord ${mode === "mini" ? "Mini" : "Max"}です。日本語Discordロールパネル操作の型付き計画のみを作成します。権限付与・削除・任意API・シェル操作は禁止です。既存パネルを渡された場合、選択肢・roleNameは既存を保持し、明示依頼された変更だけを反映します。選択肢から外れたロールは削除せず、その後のパネルで参照しないだけにします。\n既存状態: ${JSON.stringify(existing ?? null)}\n依頼: ${instruction}`;
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
    result = await run(model);
  } catch (error) {
    if (!fallback || fallback === model) throw error;
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
