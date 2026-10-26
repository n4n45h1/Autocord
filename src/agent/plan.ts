import { z } from "zod";

const optionSchema = z.object({ key: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().min(1).max(80), roleName: z.string().min(1).max(100) }).strict();
export const panelPlanSchema = z.object({
  intent: z.enum(["create", "edit"]),
  panelId: z.string().max(80).nullable(),
  title: z.string().min(1).max(80),
  description: z.string().max(1000),
  color: z.enum(["blue", "purple", "green", "red", "gray"]),
  channelId: z.string().max(30).nullable(),
  options: z.array(optionSchema).min(1).max(25),
}).strict().superRefine((plan, ctx) => {
  const keys = new Set<string>();
  for (const option of plan.options) {
    if (keys.has(option.key)) ctx.addIssue({ code: "custom", message: `重複した選択肢キー: ${option.key}` });
    keys.add(option.key);
  }
});

export type PanelPlan = z.infer<typeof panelPlanSchema>;
