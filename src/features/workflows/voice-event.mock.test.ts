import { randomUUID } from "node:crypto";
import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField, type Guild, type GuildMember, type VoiceState } from "discord.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { interactiveWorkflows, managedChannels, workflowVoiceChannels } from "../../db/schema.js";
import { interactiveWorkflowSchema } from "../../agent/interactive-workflow.js";

const discordVoiceTests = process.env.TEST_DATABASE_URL ? describe : describe.skip;

discordVoiceTests("Interactive Workflow mocked VoiceState path", () => {
  let db: typeof import("../../db/client.js").db;
  let pool: typeof import("../../db/client.js").pool;
  let handleVoiceState: typeof import("./engine.js").handleWorkflowVoiceStateUpdate;
  let handleWorkflowInteraction: typeof import("./engine.js").handleInteractiveWorkflowInteraction;
  let buttonWorkflowId: string | undefined;
  const guildId = `voice-test-${randomUUID()}`;
  const workflowId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const client = await import("../../db/client.js");
    db = client.db;
    pool = client.pool;
    ({ handleWorkflowVoiceStateUpdate: handleVoiceState, handleInteractiveWorkflowInteraction: handleWorkflowInteraction } = await import("./engine.js"));
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(interactiveWorkflows).where(eq(interactiveWorkflows.id, workflowId));
    await db.delete(managedChannels).where(eq(managedChannels.ownerJobId, workflowId));
    if (buttonWorkflowId) {
      await db.delete(interactiveWorkflows).where(eq(interactiveWorkflows.id, buttonWorkflowId));
      await db.delete(managedChannels).where(eq(managedChannels.ownerJobId, buttonWorkflowId));
    }
    await pool.end();
  });

  it("creates one owned VC at the threshold, moves lobby members, then deletes it when empty", async () => {
    const lobbyId = "12345678901234567";
    const botPermissions = new PermissionsBitField([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel]);
    const bot = { id: "bot-user", permissions: botPermissions } as unknown as GuildMember;
    const members = new Collection<string, GuildMember>();
    let temporary: ReturnType<typeof makeVoiceChannel> | undefined;
    let deleted = false;
    const source = makeVoiceChannel(lobbyId, "Voice Lobby", members, botPermissions);
    const panelMessage = { id: "test-panel-message", edit: vi.fn(async () => undefined) };
    const textChannel = { id: "test-text-channel", type: ChannelType.GuildText, isSendable: () => true, messages: { fetch: async () => panelMessage } };

    function createMember(id: string): GuildMember {
      let value: GuildMember;
      const voice = {
        channelId: lobbyId,
        setChannel: async (channel: { id: string }) => {
          members.delete(id);
          temporary!.members.set(id, value);
          (voice as { channelId: string | null }).channelId = channel.id;
          return value;
        },
      };
      value = {
        id,
        user: { id, bot: false },
        voice,
        roles: { cache: new Collection() },
        permissions: new PermissionsBitField(),
      } as unknown as GuildMember;
      return value;
    }

    const memberA = createMember("member-a");
    const memberB = createMember("member-b");
    members.set(memberA.id, memberA);
    members.set(memberB.id, memberB);
    const channels = new Collection<string, unknown>([[lobbyId, source], [textChannel.id, textChannel]]);
    const guild = {
      id: guildId,
      members: { me: bot },
      channels: {
        cache: channels,
        fetch: async (id: string) => channels.get(id) ?? null,
        create: async (data: { name: string }) => {
          temporary = makeVoiceChannel("22345678901234567", data.name, new Collection(), botPermissions, () => { deleted = true; });
          channels.set(temporary.id, temporary);
          return temporary;
        },
      },
    } as unknown as Guild;
    const spec = interactiveWorkflowSchema.parse({
      version: 1, name: "Temporary team VC", title: "VC募集", description: "2人集まったらVCを作ります。", color: "purple",
      components: [{ key: "status", kind: "button", label: "状況", style: "secondary", emoji: null, triggerId: "status-trigger" }],
      triggers: [
        { id: "status-trigger", event: "button", componentKey: "status", steps: [{ id: "refresh", action: "panel.refresh" }] },
        { id: "create-trigger", event: "voice.member_join_event", voiceChannelId: lobbyId, steps: [
          { id: "create", action: "voice.channel.create", name: "party", moveMembers: true, when: { op: "or", conditions: [{ op: "voice.members.gte", value: 2 }, { op: "voice.session.exists" }] } },
          { id: "refresh-create", action: "panel.refresh", dependsOn: ["create"] },
        ] },
        { id: "delete-trigger", event: "voice.member_leave_event", steps: [
          { id: "delete", action: "voice.channel.delete", when: { op: "voice.members.eq", value: 0 } },
          { id: "refresh-delete", action: "panel.refresh", dependsOn: ["delete"] },
        ] },
      ],
    });
    await db.insert(interactiveWorkflows).values({ id: workflowId, guildId, channelId: "test-text-channel", messageId: "test-panel-message", ownerId: "test-admin", name: spec.name, version: 1, state: "ACTIVE", spec });
    const now = new Date();
    const state = (channelId: string | null, member: GuildMember): VoiceState => ({ id: member.id, guildId, guild, channelId, channel: channelId === lobbyId ? source as never : channelId && temporary?.id === channelId ? temporary as never : null, member, sessionId: null, requestToSpeakTimestamp: null, suppress: false, selfDeaf: false, selfMute: false, serverDeaf: false, serverMute: false, streaming: false, selfVideo: false, selfStream: false, selfSuppress: false, discoverable: false, version: 1, createdTimestamp: now.getTime(), editedTimestamp: now.getTime() } as unknown as VoiceState);

    await handleVoiceState(state(null, memberA), state(lobbyId, memberA));
    expect(temporary).toBeDefined();
    expect(temporary?.members.size).toBe(2);
    const [session] = await db.select().from(workflowVoiceChannels).where(and(eq(workflowVoiceChannels.workflowId, workflowId), eq(workflowVoiceChannels.state, "ACTIVE"))).limit(1);
    expect(session?.voiceChannelId).toBe(temporary?.id);

    temporary!.members.clear();
    await handleVoiceState(state(temporary!.id, memberA), state(null, memberA));
    const [closed] = await db.select().from(workflowVoiceChannels).where(eq(workflowVoiceChannels.id, session!.id)).limit(1);
    expect(deleted).toBe(true);
    expect(closed?.state).toBe("CLOSED");
    expect(panelMessage.edit).toHaveBeenCalledTimes(2);
  });

  it("registers two button users, creates one owned room, moves both, and cleans it up when empty", async () => {
    const id = randomUUID();
    buttonWorkflowId = id;
    const cleanupGuildId = `button-voice-${id}`;
    const roomId = "32345678901234567";
    const botPermissions = new PermissionsBitField([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    const ownerPermissions = new PermissionsBitField([PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers]);
    const bot = { id: "bot-user", permissions: botPermissions } as unknown as GuildMember;
    const roomMembers = new Collection<string, GuildMember>();
    let roomDeleted = false;
    let roomCreates = 0;
    const panelMessage = { id: "button-panel-message", edit: vi.fn(async () => undefined) };
    const textChannel = { id: "button-text-channel", type: ChannelType.GuildText, isSendable: () => true, messages: { fetch: async () => panelMessage } };
    const channels = new Collection<string, unknown>([[textChannel.id, textChannel]]);
    const owner = { id: "workflow-owner", user: { id: "workflow-owner", bot: false }, permissions: ownerPermissions, roles: { cache: new Collection() } } as unknown as GuildMember;
    const members = new Collection<string, GuildMember>([[owner.id, owner]]);
    const createMember = (memberId: string): GuildMember => {
      let member: GuildMember;
      const voice = {
        channelId: null as string | null,
        setChannel: async (channel: { id: string }) => {
          if (voice.channelId === roomId) roomMembers.delete(memberId);
          voice.channelId = channel.id;
          if (channel.id === roomId) roomMembers.set(memberId, member);
          return member;
        },
      };
      member = { id: memberId, user: { id: memberId, bot: false }, voice, roles: { cache: new Collection() }, permissions: new PermissionsBitField() } as unknown as GuildMember;
      members.set(memberId, member);
      return member;
    };
    const memberA = createMember("party-member-a");
    const memberB = createMember("party-member-b");
    const room = makeVoiceChannel(roomId, "Party", roomMembers, botPermissions, () => { roomDeleted = true; });
    const guild = {
      id: cleanupGuildId, ownerId: owner.id,
      members: { me: bot, cache: members, fetch: async (memberId: string) => members.get(memberId) ?? null },
      channels: { cache: channels, fetch: async (channelId: string) => channels.get(channelId) ?? null, create: async () => { roomCreates++; channels.set(roomId, room); return room; } },
    } as unknown as Guild;
    const spec = interactiveWorkflowSchema.parse({
      version: 1, name: "Button Party", title: "Party", description: "Two registered members join one temporary room.", color: "green",
      components: [{ key: "join", kind: "button", label: "Join", style: "success", emoji: null, disabledWhen: { op: "entries.gte", collection: "party", value: 2 }, triggerId: "join-trigger" }],
      triggers: [
        { id: "join-trigger", event: "button", componentKey: "join", steps: [
          { id: "register", action: "entry.join", collection: "party", maxEntries: 2 },
          { id: "create-room", action: "channel.create_voice", name: "Party", when: { op: "and", conditions: [{ op: "workflow.owner_has_permission", permission: "ManageGuild" }, { op: "workflow.owner_has_permission", permission: "ManageChannels" }, { op: "result.equals", stepId: "register", field: "joined", value: true }, { op: "result.equals", stepId: "register", field: "count", value: 2 }] }, dependsOn: ["register"] },
          { id: "move-party", action: "channel.move_members", channelStepId: "create-room", collection: "party", maxMembers: 2, when: { op: "and", conditions: [{ op: "workflow.owner_has_permission", permission: "ManageGuild" }, { op: "workflow.owner_has_permission", permission: "MoveMembers" }, { op: "result.equals", stepId: "register", field: "joined", value: true }, { op: "result.equals", stepId: "register", field: "count", value: 2 }] }, dependsOn: ["register", "create-room"] },
          { id: "refresh", action: "panel.refresh", dependsOn: ["create-room", "move-party"] },
        ] },
        { id: "cleanup-trigger", event: "workflow.channel_empty", steps: [{ id: "delete-empty", action: "channel.delete_empty", dependsOn: [] }, { id: "refresh-empty", action: "panel.refresh", dependsOn: ["delete-empty"] }] },
      ],
    });
    await db.insert(interactiveWorkflows).values({ id, guildId: cleanupGuildId, channelId: textChannel.id, messageId: panelMessage.id, ownerId: owner.id, name: spec.name, version: 1, state: "ACTIVE", spec });
    const press = async (member: GuildMember, interactionId: string) => handleWorkflowInteraction({
      id: interactionId, customId: `iw:${id}:join`, guildId: cleanupGuildId, guild,
      user: member.user, member, message: { id: panelMessage.id },
      isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false, isRepliable: () => true,
      deferReply: async () => undefined, editReply: async () => undefined, reply: async () => undefined,
    } as unknown as import("discord.js").Interaction);

    expect(await press(memberA, "button-interaction-a")).toBe(true);
    expect(roomCreates).toBe(0);
    expect(await press(memberB, "button-interaction-b")).toBe(true);
    expect(roomCreates).toBe(1);
    expect(roomMembers.size).toBe(2);

    const now = Date.now();
    const makeState = (member: GuildMember, channelId: string | null): VoiceState => ({
      id: member.id, guildId: cleanupGuildId, guild, channelId,
      channel: channelId === roomId ? room as never : null,
      member, sessionId: null, requestToSpeakTimestamp: null, suppress: false, selfDeaf: false, selfMute: false,
      serverDeaf: false, serverMute: false, streaming: false, selfVideo: false, selfStream: false, selfSuppress: false,
      discoverable: false, version: 1, createdTimestamp: now, editedTimestamp: now,
    } as unknown as VoiceState);
    await (memberA.voice as unknown as { setChannel: (channel: { id: string }) => Promise<unknown> }).setChannel({ id: "some-other-channel" });
    await handleVoiceState(makeState(memberA, roomId), makeState(memberA, null));
    expect(roomDeleted).toBe(false);
    await (memberB.voice as unknown as { setChannel: (channel: { id: string }) => Promise<unknown> }).setChannel({ id: "some-other-channel" });
    await handleVoiceState(makeState(memberB, roomId), makeState(memberB, null));
    expect(roomDeleted).toBe(true);
    const owned = await db.select().from(managedChannels).where(and(eq(managedChannels.guildId, cleanupGuildId), eq(managedChannels.ownerJobId, id)));
    expect(owned).toHaveLength(0);
    await db.delete(interactiveWorkflows).where(eq(interactiveWorkflows.id, id));
  });
});

function makeVoiceChannel(id: string, name: string, members: Collection<string, GuildMember>, permissions: PermissionsBitField, onDelete?: () => void) {
  return {
    id,
    name,
    type: ChannelType.GuildVoice,
    parentId: null,
    members,
    permissionOverwrites: { cache: new Collection() },
    permissionsFor: () => permissions,
    delete: async () => { onDelete?.(); },
  };
}
