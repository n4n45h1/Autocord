import { describe, expect, it } from "vitest";
import { panelPlanSchema } from "./agent/plan.js";
import { assertDistributableRole, containsForbiddenPermissions, isBelowHierarchy, isExpectedRevision } from "./policy.js";
import { canTransition, occupiesGlobalAiSlot } from "./jobs/state.js";
import { drawWinners, giveawayNotificationRetryDelayMs, giveawayResultMessage } from "./features/giveaways/draw.js";
import { extractPlanJson } from "./agent/opencode.js";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { MessageFlags } from "discord.js";
import { renderPanel } from "./features/panels/render.js";

const valid = { intent: "create", panelId: null, expectedRevision: null, title: "ゲームロール", description: "選択してください", color: "blue", selectionMode: "multiple", componentStyle: "select", channelId: null, options: [{ key: "valorant", label: "VALORANT", roleName: "VALORANT" }] };

describe("panel plan schema", () => {
  it("accepts a bounded create plan", () => expect(panelPlanSchema.safeParse(valid).success).toBe(true));
  it("rejects unknown actions and extra fields", () => expect(panelPlanSchema.safeParse({ ...valid, intent: "delete", shell: "echo" }).success).toBe(false));
  it("rejects duplicate option keys", () => expect(panelPlanSchema.safeParse({ ...valid, options: [...valid.options, valid.options[0]] }).success).toBe(false));
  it("limits panels to 25 options", () => expect(panelPlanSchema.safeParse({ ...valid, options: Array.from({ length: 26 }, (_, index) => ({ key: `role-${index}`, label: `Role ${index}`, roleName: `Role ${index}` })) }).success).toBe(false));
  it("requires a panel id and revision for edits", () => expect(panelPlanSchema.safeParse({ ...valid, intent: "edit" }).success).toBe(false));
  it("limits button panels to five buttons", () => expect(panelPlanSchema.safeParse({ ...valid, componentStyle: "buttons", options: Array.from({ length: 6 }, (_, index) => ({ key: `r${index}`, label: `Role ${index}`, roleName: `Role ${index}` })) }).success).toBe(false));
});

describe("policy and job state", () => {
  it("rejects dangerous role permissions", () => {
    expect(containsForbiddenPermissions(PermissionFlagsBits.Administrator)).toBe(true);
    expect(containsForbiddenPermissions(PermissionFlagsBits.ManageRoles)).toBe(true);
    expect(containsForbiddenPermissions(PermissionFlagsBits.ViewChannel)).toBe(false);
  });
  it("requires an exact revision match", () => {
    expect(isExpectedRevision(4, 4)).toBe(true);
    expect(isExpectedRevision(5, 4)).toBe(false);
  });
  it("requires managed roles to stay below the actor and bot roles", () => {
    expect(isBelowHierarchy(2, 3)).toBe(true);
    expect(isBelowHierarchy(3, 3)).toBe(false);
    expect(isBelowHierarchy(4, 3)).toBe(false);
  });
  it("fails closed for foreign, permission-bearing, and managed roles", () => {
    const guild = { id: "guild", ownerId: "owner", members: { me: { roles: { highest: { position: 5 } } } } } as never;
    const actor = { id: "admin", roles: { highest: { position: 4 } } } as never;
    const makeRole = (overrides: object = {}) => ({ id: "role", name: "Member", managed: false, position: 2, permissions: new PermissionsBitField(0n), ...overrides }) as never;
    expect(() => assertDistributableRole(guild, makeRole(), undefined, actor)).toThrow(/所有していない/);
    expect(() => assertDistributableRole(guild, makeRole({ permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles) }), "job", actor)).toThrow(/危険な権限/);
    expect(() => assertDistributableRole(guild, makeRole({ managed: true }), "job", actor)).toThrow(/@everyone/);
    expect(() => assertDistributableRole(guild, makeRole(), "job", actor)).not.toThrow();
  });
  it("does not allow terminal job replay", () => {
    expect(canTransition("COMPLETED", "EXECUTING")).toBe(false);
    expect(canTransition("AWAITING_APPROVAL", "EXECUTING")).toBe(true);
    expect(canTransition("PLANNING", "FAILED")).toBe(true);
  });
  it("keeps approval waiting jobs out of the global AI generation cap", () => {
    expect(occupiesGlobalAiSlot("PLANNING")).toBe(true);
    expect(occupiesGlobalAiSlot("AWAITING_APPROVAL")).toBe(false);
    expect(occupiesGlobalAiSlot("AWAITING_PANEL_SELECTION")).toBe(false);
  });
});

describe("giveaway draw", () => {
  it("draws without replacement and ignores duplicate entries", () => {
    const sequence = [1, 0];
    const winners = drawWinners(["a", "b", "b", "c"], 2, () => sequence.shift()!);
    expect(winners).toEqual(["b", "a"]);
    expect(new Set(winners).size).toBe(winners.length);
  });
  it("caps winners to the number of entrants", () => expect(drawWinners(["a"], 20, () => 0)).toEqual(["a"]));
  it("uses bounded exponential retry delays for durable result delivery", () => {
    expect(giveawayNotificationRetryDelayMs(1)).toBe(5_000);
    expect(giveawayNotificationRetryDelayMs(4)).toBe(40_000);
    expect(giveawayNotificationRetryDelayMs(99)).toBe(3_600_000);
  });
  it("formats winner notifications with only the selected winners", () => {
    expect(giveawayResultMessage("Nitro", ["u1", "u2"], true)).toContain("再抽選の当選者: <@u1>, <@u2>");
    expect(giveawayResultMessage("Nitro", [])).toContain("応募者なし");
  });
});

describe("OpenCode text parsing", () => {
  it("parses plain JSON output", () => expect(extractPlanJson("{\"ok\":true}")).toEqual({ ok: true }));
  it("parses fenced JSON output", () => expect(extractPlanJson("```json\n{\"ok\":true}\n```\n")).toEqual({ ok: true }));
  it("rejects output without a JSON object", () => expect(() => extractPlanJson("not json")).toThrow());
});

describe("role panel renderer", () => {
  it("renders Components V2 without embeds or legacy content", () => {
    const panel = panelPlanSchema.parse(valid);
    const rendered = renderPanel(panel, "panel-id");
    expect(rendered.flags).toBe(MessageFlags.IsComponentsV2);
    expect(rendered.embeds).toBeUndefined();
    expect(rendered.content).toBeUndefined();
    expect(rendered.components).toHaveLength(1);
    const container = JSON.parse(JSON.stringify(rendered.components?.[0])) as { type: number };
    expect(container.type).toBe(17);
  });

  it("retains the Classic Embed renderer for existing panels", () => {
    const panel = panelPlanSchema.parse({ ...valid, renderMode: "classic" });
    const rendered = renderPanel(panel, "panel-id");
    expect(rendered.flags).toBeUndefined();
    expect(rendered.embeds).toHaveLength(1);
  });

  it("renders V2 button panels as sections with button accessories", () => {
    const panel = panelPlanSchema.parse({ ...valid, componentStyle: "buttons" });
    const rendered = renderPanel(panel, "panel-id");
    const container = JSON.parse(JSON.stringify(rendered.components?.[0])) as { type: number; components: { type: number }[] };
    expect(container?.type).toBe(17);
    expect(container.components.some((component) => component.type === 9)).toBe(true);
  });
});
