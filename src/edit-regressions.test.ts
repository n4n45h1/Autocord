import { Collection, Events, PermissionFlagsBits, PermissionsBitField, type Client, type Guild, type Interaction } from "discord.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentJobs, interactiveWorkflows, managedRoles, panelOptions, panels, giveaways, workflowRuns, workflowStates } from "./db/schema.js";
import { approvalHash } from "./jobs/approval-hash.js";
import { compileInteractiveWorkflow } from "./agent/interactive-workflow.js";
import { panelPlanSchema } from "./agent/plan.js";
import { parseSkillInput } from "./agent/skills/registry.js";

const mocks = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
  writes: [] as { table: unknown; value: Record<string, unknown> }[],
  client: null as unknown,
  makePlan: vi.fn(),
  updateWorkflow: vi.fn(async () => "updated"),
}));

vi.mock("discord.js", async (original) => {
  const discord = await original<typeof import("discord.js")>();
  return { ...discord, Client: class extends discord.Client {
    constructor(options: ConstructorParameters<typeof discord.Client>[0]) { super(options); mocks.client = this; }
    override async login() { return "test-token"; }
  } };
});
vi.mock("node:http", () => ({ createServer: () => ({ listen: vi.fn(), close: vi.fn() }) }));
vi.mock("./agent/planner.js", () => ({ makePlan: mocks.makePlan }));
vi.mock("./agent/core/usage.js", () => ({ reserveUsage: vi.fn(), finishUsage: vi.fn(), failUsageReservation: vi.fn() }));
vi.mock("./jobs/claim.js", () => ({
  claimApproval: async () => "lease",
  withGuildAdvisoryLock: async (_key: string, task: () => Promise<unknown>) => task(),
  recoverExpiredExecutionLeases: vi.fn(),
}));
vi.mock("./features/workflows/engine.js", async (original) => ({
  ...await original<typeof import("./features/workflows/engine.js")>(),
  updateInteractiveWorkflow: mocks.updateWorkflow,
}));
vi.mock("./db/client.js", () => {
  function query(rows: unknown[]) {
    const result = Object.assign(Promise.resolve(rows), {
      where: () => result, limit: () => result, orderBy: () => result,
      onConflictDoNothing: () => result, onConflictDoUpdate: () => result,
      returning: () => result,
    });
    return result;
  }
  const db = {
    select: () => ({ from: (table: unknown) => query(mocks.rows.get(table) ?? []) }),
    update: (table: unknown) => ({ set: (value: Record<string, unknown>) => {
      mocks.writes.push({ table, value });
      return query([{ id: "row" }]);
    } }),
    insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
      mocks.writes.push({ table, value });
      return query([{ id: "row" }]);
    } }),
    delete: () => query([]),
    transaction: async (task: (tx: unknown) => Promise<unknown>): Promise<unknown> => task(db),
  };
  return { db, pool: { end: vi.fn() } };
});

const guard = { op: "and", conditions: [
  { op: "member.has_permission", permission: "ManageGuild" },
  { op: "member.has_permission", permission: "ManageRoles" },
] };
const roleWorkflow = compileInteractiveWorkflow({
  version: 1, name: "Roles", title: "Roles", description: "Choose a role", color: "blue",
  components: [{ key: "setup", kind: "button", label: "Setup", style: "primary", emoji: null, triggerId: "setup" }],
  triggers: [{ id: "setup", event: "button", componentKey: "setup", steps: [
    { id: "create", action: "resource.role.create", name: "Member", when: guard },
    { id: "grant", action: "role.grant", roleName: "Member", dependsOn: ["create"] },
  ] }],
});

describe("Panel edit regressions through Discord interactions", () => {
  let dispatch: (interaction: Interaction) => Promise<void>;
  let guild: Guild;
  let message: { edit: ReturnType<typeof vi.fn> };
  let shutdownListeners: NodeJS.SignalsListener[];

  beforeAll(async () => {
    const previous = new Set(process.listeners("SIGTERM"));
    await import("./index.js");
    shutdownListeners = process.listeners("SIGTERM").filter((listener) => !previous.has(listener));
    const client = mocks.client as Client;
    dispatch = client.listeners(Events.InteractionCreate)[0] as typeof dispatch;
  });
  afterAll(() => {
    for (const listener of shutdownListeners) {
      process.removeListener("SIGTERM", listener);
      process.removeListener("SIGINT", listener);
    }
    (mocks.client as Client).destroy();
  });
  beforeEach(() => {
    mocks.rows.clear();
    mocks.writes.length = 0;
    mocks.makePlan.mockReset();
    mocks.updateWorkflow.mockClear();
    message = { edit: vi.fn(async () => undefined) };
    const role = { id: "role", name: "Member", position: 1, managed: false, permissions: new PermissionsBitField() };
    const actor = { id: "admin", user: { bot: false }, permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]), roles: { highest: { position: 100 }, cache: new Collection() } };
    const channel = { id: "channel", isSendable: () => true, messages: { fetch: async () => message } };
    const channels = new Collection([[channel.id, channel]]);
    guild = {
      id: "guild", ownerId: "admin", members: { me: actor, fetch: async () => actor },
      roles: { cache: new Collection([[role.id, role]]), fetch: async () => null },
      channels: { cache: channels, fetch: async (id?: string) => id ? channels.get(id) : channels },
    } as unknown as Guild;
    (mocks.client as Client).guilds.cache.set(guild.id, guild);
    mocks.rows.set(managedRoles, [{ roleId: "role", ownerJobId: "workflow" }]);
  });

  function interaction(customId: string) {
    return {
      id: "interaction", customId, guild, guildId: guild.id, channelId: "channel", user: { id: "admin" },
      message: { id: "message" }, deferred: true,
      isAutocomplete: () => false, isButton: () => true, isStringSelectMenu: () => false,
      isModalSubmit: () => false, isChatInputCommand: () => false, isRepliable: () => true,
      deferReply: vi.fn(), editReply: vi.fn(), followUp: vi.fn(async () => undefined), reply: vi.fn(),
    };
  }

  function workflowApproval(intent = "edit") {
    const executionContext = { interactiveWorkflow: roleWorkflow, workflowIntent: intent, workflowId: "workflow", expectedWorkflowVersion: 1, publishChannelId: "channel" };
    mocks.rows.set(agentJobs, [{ id: "job", state: "EXECUTING", planHashVersion: 2, plan: null, revision: 1, executionContext,
      planHash: approvalHash({ guildId: guild.id, revision: 1, plan: null, executionContext }),
    }]);
  }

  it("allows editing a workflow after its create-role step has already run", async () => {
    workflowApproval();
    const input = interaction("approve:job");
    await dispatch(input as unknown as Interaction);
    expect(input.followUp).not.toHaveBeenCalled();
    expect(mocks.updateWorkflow).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "workflow", expectedVersion: 1 }));
    expect(input.editReply).toHaveBeenCalledWith("updated");
  });

  it.each(["another-workflow", "panel-job"])("still rejects roles owned by %s on edit", async (ownerJobId) => {
    workflowApproval();
    mocks.rows.set(managedRoles, [{ roleId: "role", ownerJobId }]);
    const input = interaction("approve:job");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await dispatch(input as unknown as Interaction);
      expect(input.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("cannot shadow") }));
      expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it("does not treat a supplied workflow ID as ownership during creation", async () => {
    workflowApproval("create");
    const input = interaction("approve:job");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await dispatch(input as unknown as Interaction);
      expect(input.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("cannot shadow") }));
    } finally { error.mockRestore(); }
  });

  it("still rejects an unmanaged name collision alongside a workflow-owned role", async () => {
    workflowApproval();
    guild.roles.cache.set("foreign", { id: "foreign", name: "Member" } as never);
    const input = interaction("approve:job");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await dispatch(input as unknown as Interaction);
      expect(input.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("cannot shadow") }));
      expect(mocks.updateWorkflow).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it("allows own-role reuse while generating the edit preview too", async () => {
    mocks.rows.set(interactiveWorkflows, [{ id: "workflow", version: 1, channelId: "channel", spec: roleWorkflow }]);
    mocks.makePlan.mockResolvedValue({ interactiveWorkflow: roleWorkflow, interactiveWorkflowId: "workflow", expectedWorkflowVersion: 1, model: "test", inputTokens: 0, outputTokens: 0 });
    const input = { ...interaction(""), commandName: "agent", memberPermissions: {},
      isButton: () => false, isChatInputCommand: () => true,
      options: { getString: (name: string) => ({ workflow_id: "workflow", mode: "max", 指示: "Change the title" })[name as "mode"] },
    };
    await dispatch(input as unknown as Interaction);
    expect(mocks.writes).toContainEqual(expect.objectContaining({ table: agentJobs, value: expect.objectContaining({ state: "AWAITING_APPROVAL" }) }));
    expect(input.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("v1 → Roles v2") }));
  });

  it.each([false, true])("verifies the stored panel payload before adding defaults (tampered=%s)", async (tampered) => {
    const plan = { intent: "edit", panelId: "panel", expectedRevision: 1, title: "Panel", description: "Updated", color: "blue", selectionMode: "single", componentStyle: "select", channelId: "channel", options: [{ key: "member", label: "Member", roleName: "Member" }] };
    const hash = approvalHash({ guildId: guild.id, revision: 1, plan, executionContext: null });
    expect(panelPlanSchema.parse(plan)).not.toEqual(plan);
    mocks.rows.set(agentJobs, [{ id: "job", state: "EXECUTING", planHashVersion: 2, plan: tampered ? { ...plan, title: "Tampered" } : plan, planHash: hash, revision: 1, executionContext: null }]);
    mocks.rows.set(panels, [{ id: "panel", revision: 1, channelId: "channel", messageId: "message", spec: plan }]);
    mocks.rows.set(panelOptions, [{ key: "member", roleId: "role", label: "Member" }]);
    const input = interaction("approve:job");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await dispatch(input as unknown as Interaction);
      expect(message.edit).toHaveBeenCalledTimes(tampered ? 0 : 1);
      if (tampered) expect(input.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("承認後") }));
      else expect(input.editReply).toHaveBeenCalledWith(expect.stringContaining("revision 2"));
    } finally { error.mockRestore(); }
  });

  it.each(["bound", "foreign", null])("preserves legacy giveaway state.set without permitting rebinding (%s)", async (value) => {
    const save = { id: "save", action: "state.set", scope: "workflow", key: "active_giveaway_id", value: "{{result:create:giveawayId}}", dependsOn: ["create"] };
    expect(parseSkillInput("workflow.state.set", save)).toMatchObject(save);
    const workflow = compileInteractiveWorkflow({
      ...roleWorkflow, triggers: [{ id: "setup", event: "button", componentKey: "setup", steps: [
        { id: "create", action: "giveaway.create", prize: "Prize", durationSeconds: 60, winnerCount: 1, when: guard },
        value === "bound" ? save : { ...save, value },
      ] }],
    });
    mocks.rows.set(interactiveWorkflows, [{ id: "workflow", guildId: guild.id, spec: workflow, version: 1, state: "ACTIVE", channelId: "channel", messageId: "message" }]);
    mocks.rows.set(workflowStates, [{ scope: "workflow", key: "active_giveaway_id", value: "bound" }]);
    mocks.rows.set(giveaways, [{ id: "bound", state: "ACTIVE" }]);
    const input = interaction("iw:workflow:setup");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await dispatch(input as unknown as Interaction);
      expect(mocks.writes.filter((write) => write.table === workflowStates)).toEqual([]);
      if (value === "bound") {
        expect(input.followUp).not.toHaveBeenCalled();
        expect(message.edit).toHaveBeenCalledTimes(1);
        expect(mocks.writes).toContainEqual(expect.objectContaining({ table: workflowRuns, value: expect.objectContaining({ state: "COMPLETED" }) }));
      } else {
        expect(message.edit).not.toHaveBeenCalled();
        expect(input.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/not the active|did not resolve/) }));
      }
    } finally { error.mockRestore(); }
  });

  it.each([
    { id: "mutate", action: "state.set", scope: "workflow", key: "panel.description", value: "forged" },
    { id: "mutate", action: "state.delete", scope: "workflow", key: "active_giveaway_id" },
  ])("keeps other reserved-state mutations blocked ($action $key)", async (step) => {
    const workflow = compileInteractiveWorkflow({ ...roleWorkflow, triggers: [{ id: "setup", event: "button", componentKey: "setup", steps: [step] }] });
    mocks.rows.set(interactiveWorkflows, [{ id: "workflow", guildId: guild.id, spec: workflow, version: 1, state: "ACTIVE", channelId: "channel", messageId: "message" }]);
    const input = interaction("iw:workflow:setup");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await dispatch(input as unknown as Interaction);
      expect(input.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("reserved by Autocord") }));
      expect(message.edit).not.toHaveBeenCalled();
      expect(mocks.writes.filter((write) => write.table === workflowStates)).toEqual([]);
    } finally { error.mockRestore(); }
  });
});
