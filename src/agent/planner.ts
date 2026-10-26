import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { panelPlanSchema, type PanelPlan } from "./plan.js";

const provider = createOpenAI({
  baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "https://api.opencode.ai/v1",
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? "",
});

export async function makePlan(instruction: string, existing?: PanelPlan): Promise<PanelPlan> {
  const result = await generateObject({
    model: provider(process.env.AI_MODEL ?? "deepseek-v4.1-flash-free"),
    schema: panelPlanSchema,
    prompt: `日本語Discordロールパネルの操作計画を作成してください。許可されるのはパネルの作成・編集だけです。ロール名は選択肢に必要なものに限り、権限変更、削除、任意API操作を含めないでください。曖昧な場合は安全な最小計画を出してください。\n既存パネル: ${JSON.stringify(existing ?? null)}\n依頼: ${instruction}`,
    temperature: 0,
  });
  return panelPlanSchema.parse(result.object);
}
