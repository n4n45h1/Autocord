import { describe, expect, it } from "vitest";
import { panelPlanSchema } from "./agent/plan.js";

const valid = { intent: "create", panelId: null, title: "ゲームロール", description: "選択してください", color: "blue", channelId: null, options: [{ key: "valorant", label: "VALORANT", roleName: "VALORANT" }] };

describe("panel plan schema", () => {
  it("accepts a bounded create plan", () => expect(panelPlanSchema.safeParse(valid).success).toBe(true));
  it("rejects unknown actions and extra fields", () => expect(panelPlanSchema.safeParse({ ...valid, intent: "delete", shell: "echo" }).success).toBe(false));
  it("rejects duplicate option keys", () => expect(panelPlanSchema.safeParse({ ...valid, options: [...valid.options, valid.options[0]] }).success).toBe(false));
  it("limits panels to 25 options", () => expect(panelPlanSchema.safeParse({ ...valid, options: Array.from({ length: 26 }, (_, index) => ({ key: `role-${index}`, label: `Role ${index}`, roleName: `Role ${index}` })) }).success).toBe(false));
});
