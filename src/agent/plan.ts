import { z } from "zod";

const optionSchema = z.object({ key: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().min(1).max(80), roleName: z.string().min(1).max(100), emoji: z.string().max(64).nullable().default(null) }).strict();
export const panelPlanSchema = z.object({
  intent: z.enum(["create", "edit"]),
  panelId: z.string().max(80).nullable(),
  expectedRevision: z.number().int().positive().nullable(),
  title: z.string().min(1).max(80),
  description: z.string().max(1000),
  color: z.enum(["blue", "purple", "green", "red", "gray"]),
  renderMode: z.enum(["classic", "components_v2"]).default("components_v2"),
  selectionMode: z.enum(["single", "multiple"]),
  componentStyle: z.enum(["select", "buttons"]),
  channelId: z.string().max(30).nullable(),
  options: z.array(optionSchema).min(1).max(25),
}).strict().superRefine((plan, ctx) => {
  if (plan.intent === "create" && (plan.panelId !== null || plan.expectedRevision !== null)) ctx.addIssue({ code: "custom", message: "新規パネルは対象ID/revisionを持てません" });
  if (plan.intent === "edit" && (!plan.panelId || !plan.expectedRevision)) ctx.addIssue({ code: "custom", message: "編集には対象パネルとrevisionが必要です" });
  if (plan.componentStyle === "buttons" && plan.options.length > 5) ctx.addIssue({ code: "custom", message: "ボタン式パネルは5項目までです" });
  const keys = new Set<string>();
  for (const option of plan.options) {
    if (keys.has(option.key)) ctx.addIssue({ code: "custom", message: `重複した選択肢キー: ${option.key}` });
    keys.add(option.key);
  }
});

export type PanelPlan = z.infer<typeof panelPlanSchema>;
