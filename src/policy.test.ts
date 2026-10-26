import { describe, expect, it } from "vitest";
import { panelPlanSchema } from "./agent/plan.js";
import { assertDistributableRole, assertResourceWorkflowPermissions, assertSkillPermissions, containsForbiddenPermissions, isBelowHierarchy, isExpectedRevision } from "./policy.js";
import { canTransition, occupiesGlobalAiSlot } from "./jobs/state.js";
import { drawWinners, giveawayNotificationRetryDelayMs, giveawayResultMessage } from "./features/giveaways/draw.js";
import { extractPlanJson } from "./agent/opencode.js";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { MessageFlags } from "discord.js";
import { renderPanel } from "./features/panels/render.js";
import { agentSkills, listAgentSkills, parseResourceWorkflowInput, parseSkillInput, resolvePanelSkill, resolveResourceSkill } from "./agent/skills/registry.js";
import { approvalHash } from "./jobs/approval-hash.js";
import { compileMaxWorkflow, maxAgentWorkflowSchema, maxWorkflowSchema, orderResourceSteps, orderWorkflowOperations, resourceWorkflowSchema } from "./agent/workflow.js";

const valid = { intent: "create", panelId: null, expectedRevision: null, title: "ゲームロール", description: "選択してください", color: "blue", selectionMode: "multiple", componentStyle: "select", channelId: null, options: [{ key: "valorant", label: "VALORANT", roleName: "VALORANT" }] };

describe("panel plan schema", () => {
  it("accepts a bounded create plan", () => expect(panelPlanSchema.safeParse(valid).success).toBe(true));
  it("rejects unknown actions and extra fields", () => expect(panelPlanSchema.safeParse({ ...valid, intent: "delete", shell: "echo" }).success).toBe(false));
  it("rejects duplicate option keys", () => expect(panelPlanSchema.safeParse({ ...valid, options: [...valid.options, valid.options[0]] }).success).toBe(false));
  it("limits panels to 25 options", () => expect(panelPlanSchema.safeParse({ ...valid, options: Array.from({ length: 26 }, (_, index) => ({ key: `role-${index}`, label: `Role ${index}`, roleName: `Role ${index}` })) }).success).toBe(false));
  it("requires a panel id and revision for edits", () => expect(panelPlanSchema.safeParse({ ...valid, intent: "edit" }).success).toBe(false));
  it("limits button panels to five buttons", () => expect(panelPlanSchema.safeParse({ ...valid, componentStyle: "buttons", options: Array.from({ length: 6 }, (_, index) => ({ key: `r${index}`, label: `Role ${index}`, roleName: `Role ${index}` })) }).success).toBe(false));
});

describe("Agentcord skill registry", () => {
  it("maps panel intents to allowlisted skills with mandatory approval", () => {
    const createPlan = panelPlanSchema.parse(valid);
    const editPlan = panelPlanSchema.parse({ ...valid, intent: "edit", panelId: "panel-id", expectedRevision: 2 });
    expect(resolvePanelSkill(createPlan).id).toBe("panel.create");
    expect(resolvePanelSkill(editPlan).id).toBe("panel.edit");
    expect(listAgentSkills().length).toBeGreaterThanOrEqual(26);
    for (const id of ["panel.create", "panel.edit", "panel.workflow", "resource.workflow", "role.create", "channel.create_category", "channel.create_text"] as const) {
      expect(agentSkills[id].approval.required).toBe(true);
    }
  });
  it("enforces intent-specific skill schemas", () => {
    expect(parseSkillInput("panel.create", valid).intent).toBe("create");
    expect(() => parseSkillInput("panel.edit", valid)).toThrow();
    expect(agentSkills["panel.edit"].targetScope).toContain("revision");
    expect(agentSkills["panel.workflow"].approval.required).toBe(true);
  });
});

describe("Agentcord Max workflow compiler", () => {
  it("topologically orders dependencies and compiles bounded panel operations", () => {
    const workflow = maxWorkflowSchema.parse({ version: 1, operations: [
      { id: "rename", dependsOn: ["add"], action: "option.rename_role", key: "apex", roleName: "APEX" },
      { id: "add", dependsOn: [], action: "option.add", key: "apex", label: "APEX", roleName: "Apex Legends", emoji: null },
      { id: "title", dependsOn: ["rename"], action: "panel.set_title", value: "Game roles" },
    ] });
    expect(orderWorkflowOperations(workflow.operations).map((step) => step.id)).toEqual(["add", "rename", "title"]);
    const plan = compileMaxWorkflow(undefined, workflow);
    expect(plan.intent).toBe("create");
    expect(plan.title).toBe("Game roles");
    expect(plan.options[0]?.roleName).toBe("APEX");
  });
  it("rejects cycles, unresolved option references and invalid final plans", () => {
    expect(() => orderWorkflowOperations([
      { id: "a", dependsOn: ["b"], action: "panel.set_title", value: "A" },
      { id: "b", dependsOn: ["a"], action: "panel.set_title", value: "B" },
    ])).toThrow(/cycle/);
    expect(() => compileMaxWorkflow(undefined, { version: 1, operations: [{ id: "rm", dependsOn: [], action: "option.remove", key: "missing" }] })).toThrow(/missing option/);
  });
});

describe("role/channel resource Skills", () => {
  it("validates category-to-text dependencies and orders resources", () => {
    const workflow = parseResourceWorkflowInput({ version: 1, steps: [
      { id: "role", dependsOn: [], action: "role.create", name: "Member" },
      { id: "games", dependsOn: [], action: "channel.create_category", name: "Games" },
      { id: "games-chat", dependsOn: ["games"], action: "channel.create_text", name: "game-chat", topic: "Choose a game", categoryStepId: "games" },
    ] });
    expect(resolveResourceSkill(workflow.steps[0]!)).toBe("role.create");
    expect(orderResourceSteps(workflow.steps).map((step) => step.id)).toEqual(["role", "games", "games-chat"]);
  });
  it("rejects text channels whose parent is absent or not a dependency", () => {
    expect(resourceWorkflowSchema.safeParse({ version: 1, steps: [
      { id: "text", dependsOn: [], action: "channel.create_text", name: "chat", topic: null, categoryStepId: "missing" },
    ] }).success).toBe(false);
    expect(resourceWorkflowSchema.safeParse({ version: 1, steps: [
      { id: "category", dependsOn: [], action: "channel.create_category", name: "Group" },
      { id: "text", dependsOn: [], action: "channel.create_text", name: "chat", topic: null, categoryStepId: "category" },
    ] }).success).toBe(false);
  });
});

describe("approval hash canonicalization", () => {
  it("is independent of PostgreSQL JSON object key order", () => {
    const left = { guildId: "g", revision: 3, plan: { title: "T", nested: { b: 2, a: 1 } }, executionContext: null };
    const right = { guildId: "g", revision: 3, plan: { nested: { a: 1, b: 2 }, title: "T" }, executionContext: null };
    expect(approvalHash(left)).toBe(approvalHash(right));
  });
  it("binds the approved workflow context and target revision", () => {
    const base = { guildId: "g", revision: 3, plan: { title: "T" }, executionContext: { workflowSteps: [{ id: "s1", action: "panel.set_title" }] } };
    expect(approvalHash(base)).not.toBe(approvalHash({ ...base, revision: 4 }));
    expect(approvalHash(base)).not.toBe(approvalHash({ ...base, executionContext: { workflowSteps: [] } }));
  });
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
  it("enforces Skill Registry permissions instead of trusting a routing prompt", () => {
    const actor = { permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.ManageGuild } } as never;
    expect(() => assertSkillPermissions("panel.workflow", actor)).toThrow(/ロール管理/);
    expect(() => assertSkillPermissions("channel.create_text", actor)).toThrow(/チャンネル管理/);
  });
  it("rechecks bot permissions for resource-creation Skill execution", () => {
    const guild = { members: { me: { permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.ManageRoles } } } } as never;
    const actor = { permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.ManageGuild || permission === PermissionFlagsBits.ManageRoles || permission === PermissionFlagsBits.ManageChannels } } as never;
    const roleWorkflow = parseResourceWorkflowInput({ version: 1, steps: [{ id: "role", dependsOn: [], action: "role.create", name: "Member" }] });
    const channelWorkflow = parseResourceWorkflowInput({ version: 1, steps: [{ id: "channel", dependsOn: [], action: "channel.create_text", name: "chat", topic: null, categoryStepId: null }] });
    expect(() => assertResourceWorkflowPermissions(guild, roleWorkflow, actor)).not.toThrow();
    expect(() => assertResourceWorkflowPermissions(guild, channelWorkflow, actor)).toThrow(/Botにチャンネル管理/);
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
