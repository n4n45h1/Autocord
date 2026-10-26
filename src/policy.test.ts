import { describe, expect, it } from "vitest";
import { panelPlanSchema } from "./agent/plan.js";
import { assertDistributableRole, containsForbiddenPermissions, isBelowHierarchy, isExpectedRevision } from "./policy.js";
import { canTransition } from "./jobs/state.js";
import { drawWinners } from "./features/giveaways/draw.js";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";

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
});
