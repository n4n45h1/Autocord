import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { compileInteractiveWorkflow, interactiveWorkflowSchema, interactiveWorkflowStepSchema, workflowConditionSchema, orderInteractiveWorkflowSteps, type WorkflowCondition } from "../../agent/interactive-workflow.js";
import { agentSkills } from "../../agent/skills/registry.js";
import { analyzeRequestRequirements, validatePlanTargetAgainstRequest, validateWorkflowAgainstRequest } from "../../agent/requirements.js";
import { evaluateWorkflowCondition, renderWorkflowTemplate } from "./conditions.js";
import { renderInteractiveWorkflow } from "./render.js";
import { calculateAggregateMath, calculateBinaryMath, calculateClamp, selectWeighted } from "./math.js";
import { nextWeeklyOccurrence } from "./schedule.js";
import { buildWorkflowPrivateOverwrites, mayCloseWorkflowChannel } from "./permissions.js";

const signup = compileInteractiveWorkflow(JSON.parse(readFileSync(new URL("../../../examples/workflows/valorant-recruitment.json", import.meta.url), "utf8")));
const onboarding = compileInteractiveWorkflow(JSON.parse(readFileSync(new URL("../../../examples/workflows/onboarding-consent.json", import.meta.url), "utf8")));
const voiceSession = compileInteractiveWorkflow(JSON.parse(readFileSync(new URL("../../../examples/workflows/voice-session.json", import.meta.url), "utf8")));
const resourcesAndGiveaway = compileInteractiveWorkflow(JSON.parse(readFileSync(new URL("../../../examples/workflows/resources-and-giveaway.json", import.meta.url), "utf8")));

describe("generic interactive Workflow definitions", () => {
  it("registers typed state, math, random, and collection actions and evaluates nested conditions", () => {
    const actions = [
      { id: "inc", action: "state.increment", scope: "member", key: "points", amount: 100 },
      { id: "math", action: "math.add", left: "{{state:member:points}}", right: 50 },
      { id: "roll", action: "random.weighted_choice", options: [{ value: "warrior", weight: 3 }, { value: "mage", weight: 1 }] },
      { id: "add", action: "collection.add", scope: "member", collection: "inventory", item: "potion", maxItems: 100 },
    ];
    for (const action of actions) expect(interactiveWorkflowStepSchema.safeParse({ ...action, dependsOn: [] }).success).toBe(true);
    for (const id of ["workflow.state.increment", "workflow.math.add", "workflow.random.weighted_choice", "workflow.collection.add"]) {
      expect(Object.hasOwn(agentSkills, id)).toBe(true);
    }
    const context = { entries: {}, states: { "member:points": 550 }, collections: { "member:inventory": ["potion"] }, roleNames: new Set<string>(), permissions: new Set<string>() };
    const nested: WorkflowCondition = { op: "and", conditions: [
      { op: "number.gte", scope: "member", key: "points", value: 500 },
      { op: "not", condition: { op: "string.equals", scope: "member", key: "class", value: "none" } },
      { op: "list.contains", scope: "member", collection: "inventory", value: "potion" },
    ] };
    expect(workflowConditionSchema.safeParse(nested).success).toBe(true);
    expect(evaluateWorkflowCondition(nested, context)).toBe(true);
    expect(evaluateWorkflowCondition({ op: "random.chance", percent: 100 }, context)).toBe(true);
    expect(evaluateWorkflowCondition({ op: "random.chance", percent: 0 }, context)).toBe(false);
    const tooDeep = Array.from({ length: 9 }, () => ({ op: "not", condition: null })).reduceRight((child, parent) => ({ ...parent, condition: child }), { op: "state.exists", scope: "workflow", key: "x" } as unknown);
    expect(workflowConditionSchema.safeParse(tooDeep).success).toBe(false);
  });

  it("evaluates bounded arithmetic and weighted random selection without an LLM", () => {
    expect(calculateBinaryMath("math.add", 12, 3)).toBe(15);
    expect(calculateBinaryMath("math.subtract", 12, 3)).toBe(9);
    expect(calculateBinaryMath("math.multiply", 12, 3)).toBe(36);
    expect(calculateBinaryMath("math.divide", 12, 3)).toBe(4);
    expect(() => calculateBinaryMath("math.divide", 1, 0)).toThrow(/zero/);
    expect(calculateAggregateMath("math.min", [7, 2, 5])).toBe(2);
    expect(calculateAggregateMath("math.max", [7, 2, 5])).toBe(7);
    expect(calculateClamp(15, 0, 10)).toBe(10);
    expect(selectWeighted([{ value: "warrior", weight: 3 }, { value: "mage", weight: 1 }], 3)).toBe("mage");
  });

  it("keeps requested scenarios A-F distinct from currently executable primitives", () => {
    const scenarios = [
      ["B", "戦士・魔法使い・僧侶が選べるRPG。HP、攻撃力、経験値、レベル、ゴールド、戦闘とショップ", "workflow.turn_based_game_loop_and_transactional_shop"],
    ] as const;
    for (const [name, request, missingSkill] of scenarios) {
      expect(analyzeRequestRequirements(request).unsupportedSkills, `scenario ${name}`).toContain(missingSkill);
    }
    const voiceLobby = analyzeRequestRequirements("VALORANT募集で5人集まったら専用VCを作成し、メンバーが退出したら自動削除して");
    expect(voiceLobby.voiceRequested).toBe(true);
    expect(voiceLobby.voiceThreshold).toBe(5);
    expect(voiceLobby.unsupportedSkills).not.toContain("workflow.button_signup_to_voice_session_membership");
    const buttonSignup = analyzeRequestRequirements("参加ボタンで5人集まったら専用VCを作成して");
    expect(buttonSignup.unsupportedSkills).toContain("workflow.button_signup_to_voice_session_membership");
    const underspecifiedWeekly = analyzeRequestRequirements("毎週土曜日にイベントを開催し、終了後にランキングをリセット");
    expect(underspecifiedWeekly.missingInformation).toContain("毎週イベントを実行する時刻 (例: 18:00)");
    expect(underspecifiedWeekly.missingInformation).toContain("毎週イベントのIANAタイムゾーン (例: Asia/Tokyo)");
    expect(underspecifiedWeekly.missingInformation).toContain("イベントの開催時間/終了時刻 (ランキングをリセットする遅延時間)");
    expect(analyzeRequestRequirements("毎週土曜日18:00 Asia/Tokyoにイベントを開催").missingInformation).toEqual([]);
  });

  it("calculates persistent weekly calendar occurrences in the requested IANA zone", () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    expect(nextWeeklyOccurrence(now, 6, 18, 0, "Asia/Tokyo").toISOString()).toBe("2026-10-31T09:00:00.000Z");
    expect(() => nextWeeklyOccurrence(now, 6, 18, 0, "Not/AZone")).toThrow();
    const recurring = compileInteractiveWorkflow({
      version: 1, name: "Saturday event", title: "Weekly", description: "", color: "blue", components: [],
      triggers: [{ id: "saturday", event: "schedule.at", dayOfWeek: 6, hour: 18, minute: 0, timeZone: "Asia/Tokyo", steps: [
        { id: "wait", action: "workflow.wait", seconds: 3600 },
        { id: "reset", action: "state.reset", scope: "guild", key: null, dependsOn: ["wait"] },
      ] }],
    });
    expect(recurring.triggers[0]?.event).toBe("schedule.at");
    expect(recurring.triggers[0]?.steps.some((step) => step.action === "panel.refresh")).toBe(true);
  });

  it("limits private ticket overwrites to visibility and basic message permissions", () => {
    const staff = buildWorkflowPrivateOverwrites({ guildId: "guild", botId: "bot", preset: "staff_only", staffRoleId: "staff" });
    expect(staff[0]).toEqual({ id: "guild", deny: [PermissionFlagsBits.ViewChannel] });
    expect(staff.map((overwrite) => overwrite.id)).toEqual(["guild", "bot", "staff"]);
    const allowed = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory;
    for (const overwrite of staff.slice(1)) {
      const permission = overwrite.allow?.reduce((bits, flag) => bits | flag, 0n) ?? 0n;
      expect(permission & ~allowed).toBe(0n);
    }
    expect(() => buildWorkflowPrivateOverwrites({ guildId: "guild", botId: "bot", preset: "staff_only", staffRoleId: "guild" })).toThrow();
    expect(mayCloseWorkflowChannel({ createdForMemberId: "owner", staffRoleId: "staff", memberId: "owner", memberRoleIds: new Set(), isGuildManager: false })).toBe(true);
    expect(mayCloseWorkflowChannel({ createdForMemberId: "owner", staffRoleId: "staff", memberId: "staff-user", memberRoleIds: new Set(["staff"]), isGuildManager: false })).toBe(true);
    expect(mayCloseWorkflowChannel({ createdForMemberId: "owner", staffRoleId: "staff", memberId: "stranger", memberRoleIds: new Set(), isGuildManager: false })).toBe(false);
  });

  it("plans unique join awards and thresholded point redemption with an atomic debit", () => {
    const request = "ユーザーがイベントに参加すると100ポイント付与。500ポイントで景品交換できるようにして";
    const pointsWorkflow = compileInteractiveWorkflow({
      version: 1, name: "Points and redemption", title: "Event points", description: "Join once; redeem for a prize.", color: "green",
      components: [
        { key: "join", kind: "button", label: "参加", style: "success", emoji: null, disabledWhen: { op: "entries.gte", collection: "participants", value: 100 }, triggerId: "join-trigger" },
        { key: "redeem", kind: "button", label: "500ptで交換", style: "primary", emoji: null, triggerId: "redeem-trigger" },
      ],
      triggers: [
        { id: "join-trigger", event: "button", componentKey: "join", steps: [
          { id: "join", action: "entry.join", collection: "participants", maxEntries: 100 },
          { id: "award", action: "state.increment", scope: "member", key: "points", amount: 100, dependsOn: ["join"], when: { op: "result.equals", stepId: "join", field: "joined", value: true } },
        ] },
        { id: "redeem-trigger", event: "button", componentKey: "redeem", steps: [
          { id: "debit", action: "state.debit", scope: "member", key: "points", amount: 500, minimumBalance: 500 },
          { id: "reward", action: "message.dm", recipient: "trigger_member", content: "景品交換が完了しました。", dependsOn: ["debit"], when: { op: "result.equals", stepId: "debit", field: "debited", value: true } },
        ] },
      ],
    });
    expect(analyzeRequestRequirements(request).pointsRequested).toBe(true);
    expect(analyzeRequestRequirements(request).unsupportedSkills).toEqual([]);
    expect(validateWorkflowAgainstRequest(request, pointsWorkflow)).toEqual([]);
    expect(pointsWorkflow.triggers[1]?.steps.map((step) => step.action)).toContain("state.debit");
  });

  it("keeps inquiry input in a staff-only ticket channel and permits owner/staff closure", () => {
    const request = "問い合わせボタンからフォームを開き、回答するとスタッフだけが確認できる専用チャンネルを作って。解決したら閉じられるようにして";
    const ticketWorkflow = compileInteractiveWorkflow({
      version: 1, name: "Private support ticket", title: "Support", description: "Submit an inquiry privately.", color: "blue",
      components: [
        { key: "form", kind: "modal", label: "問い合わせ", title: "お問い合わせ", triggerId: "submit-ticket", inputs: [{ key: "issue", label: "内容", placeholder: null, style: "paragraph", required: true, maxLength: 1000 }] },
        { key: "close", kind: "modal", label: "チケットを閉じる", title: "Close ticket", triggerId: "close-ticket", inputs: [{ key: "ticket_id", label: "Ticket Channel ID", placeholder: null, style: "short", required: true, maxLength: 20 }] },
        { key: "close-own", kind: "button", label: "自分のticketを閉じる", style: "danger", emoji: null, triggerId: "close-own-ticket" },
      ],
      triggers: [
        { id: "submit-ticket", event: "modal_submit", componentKey: "form", steps: [
          { id: "create-ticket", action: "channel.create_text", name: "ticket-{{actor}}", topic: null, visibility: "staff_only", staffRoleId: "12345678901234567" },
          { id: "save-ticket", action: "state.set", scope: "member", key: "ticket_channel_id", value: "{{result:create-ticket:channelId}}", dependsOn: ["create-ticket"] },
          { id: "send-inquiry", action: "message.send", delivery: "workflow_channel_step", channelStepId: "create-ticket", content: "{{input:issue}}", dependsOn: ["create-ticket"] },
        ] },
        { id: "close-ticket", event: "modal_submit", componentKey: "close", steps: [
          { id: "delete-ticket", action: "channel.delete", channelStepId: null, channelId: "{{input:ticket_id}}", when: { op: "member.has_role", roleName: "Support" } },
        ] },
        { id: "close-own-ticket", event: "button", componentKey: "close-own", steps: [
          { id: "delete-own-ticket", action: "channel.delete", channelStepId: null, channelId: "{{state:member:ticket_channel_id}}", when: { op: "state.exists", scope: "member", key: "ticket_channel_id" } },
          { id: "clear-ticket-state", action: "state.delete", scope: "member", key: "ticket_channel_id", dependsOn: ["delete-own-ticket"] },
        ] },
      ],
    });
    expect(analyzeRequestRequirements(request).privateTicketRequested).toBe(true);
    expect(analyzeRequestRequirements(request).unsupportedSkills).toEqual([]);
    expect(validateWorkflowAgainstRequest(request, ticketWorkflow)).toEqual([]);
  });

  it("validates per-message unique reaction votes and notifies only at the threshold", () => {
    const request = "提案に賛成が20票集まったら管理者に通知して。1人1票まで";
    const voteWorkflow = compileInteractiveWorkflow({
      version: 1, name: "Proposal vote", title: "Proposal", description: "React to vote.", color: "blue",
      components: [{ key: "post", kind: "button", label: "Post proposal", style: "primary", emoji: null, triggerId: "proposal" }],
      triggers: [
        { id: "proposal", event: "button", componentKey: "post", steps: [{ id: "post-proposal", action: "message.send", delivery: "workflow_channel", content: "Proposal of the week" }] },
        { id: "votes", event: "reaction.added", channelId: "workflow_channel", messageStepId: "post-proposal", emoji: "👍", steps: [
          { id: "register-vote", action: "collection.add", scope: "workflow", collection: "votes", partitionByMessage: true, item: "{{input:authorId}}", maxItems: 1000 },
          { id: "count-votes", action: "collection.count", scope: "workflow", collection: "votes", partitionByMessage: true, dependsOn: ["register-vote"] },
          { id: "notify-owner", action: "message.send", delivery: "workflow_owner_dm", content: "Proposal received 20 votes.", dependsOn: ["count-votes"], when: { op: "and", conditions: [
            { op: "result.equals", stepId: "register-vote", field: "added", value: true },
            { op: "result.equals", stepId: "count-votes", field: "count", value: 20 },
          ] } },
        ] },
      ],
    });
    expect(analyzeRequestRequirements(request).voteRequested).toBe(true);
    expect(analyzeRequestRequirements(request).unsupportedSkills).toEqual([]);
    expect(validateWorkflowAgainstRequest(request, voteWorkflow)).toEqual([]);
  });

  it("validates scoped gateway event triggers and Workflow-owned message targets", () => {
    const gateway = interactiveWorkflowSchema.parse({
      version: 1, name: "Message automation", title: "Messages", description: "", color: "blue", components: [],
      triggers: [{ id: "message-trigger", event: "message.created", channelId: "12345678901234567", steps: [
        { id: "reply", action: "message.reply", content: "Received {{input:content}}" },
        { id: "edit-reply", action: "message.edit", targetStepId: "reply", content: "Handled", dependsOn: ["reply"] },
      ] }],
    });
    expect(gateway.triggers[0]?.event).toBe("message.created");
    expect(interactiveWorkflowSchema.safeParse({
      ...gateway,
      triggers: [{ id: "bad-reply", event: "member.join", steps: [{ id: "reply", action: "message.reply", content: "reply" }] }],
    }).success).toBe(false);
    expect(interactiveWorkflowSchema.safeParse({
      ...gateway,
      triggers: [{ id: "bad-resource", event: "reaction.added", channelId: "12345678901234567", emoji: null, steps: [{ id: "create", action: "channel.create_voice", name: "unsafe" }] }],
    }).success).toBe(false);
  });

  it("accepts the recruitment UI/actions without feature-specific schema branches", () => {
    expect(signup.triggers.flatMap((trigger) => trigger.steps).map((step) => step.action)).toEqual(["entry.join", "panel.refresh", "entry.leave", "panel.refresh"]);
  });

  it("accepts consent and managed-role grant as a composed onboarding flow", () => {
    expect(onboarding.triggers[0]?.steps.map((step) => step.action)).toEqual(["state.set", "role.grant", "panel.refresh"]);
  });

  it("composes resource and Giveaway Skills through the same admin/user triggers", () => {
    const managerGuard = { op: "and", conditions: [{ op: "member.has_permission", permission: "ManageGuild" }, { op: "member.has_permission", permission: "ManageChannels" }] } as const;
    const definition = compileInteractiveWorkflow({
      version: 1, name: "Server onboarding and giveaway", title: "Welcome", description: "Configure resources and join the active giveaway.", color: "blue",
      components: [
        { key: "configure", kind: "button", label: "Configure", style: "primary", emoji: null, triggerId: "configure-trigger" },
        { key: "enter", kind: "button", label: "Enter", style: "success", emoji: null, disabledWhen: { op: "state.not_exists", scope: "workflow", key: "active_giveaway_id" }, triggerId: "giveaway-trigger" },
      ],
      triggers: [
        { id: "configure-trigger", event: "button", componentKey: "configure", steps: [
          { id: "create-role", action: "resource.role.create", name: "Member", when: { op: "and", conditions: [{ op: "member.has_permission", permission: "ManageGuild" }, { op: "member.has_permission", permission: "ManageRoles" }] } },
          { id: "create-category", action: "resource.channel.create_category", name: "community", when: managerGuard },
          { id: "create-channel", action: "resource.channel.create_text", name: "welcome", topic: "Welcome", categoryStepId: "create-category", dependsOn: ["create-category"], when: managerGuard },
          { id: "start-giveaway", action: "giveaway.create", prize: "Game key", durationSeconds: 3600, winnerCount: 1, when: { op: "and", conditions: [{ op: "member.has_permission", permission: "ManageGuild" }, { op: "member.has_permission", permission: "ManageRoles" }] } },
          { id: "save-giveaway", action: "state.set", scope: "workflow", key: "active_giveaway_id", value: "{{result:start-giveaway:giveawayId}}", dependsOn: ["start-giveaway"] },
        ] },
        { id: "giveaway-trigger", event: "button", componentKey: "enter", steps: [{ id: "enter-giveaway", action: "giveaway.join", giveawayId: "{{state:workflow:active_giveaway_id}}" }] },
      ],
    });
    expect(definition.triggers[0]?.steps.map((step) => step.action)).toContain("resource.channel.create_text");
    expect(definition.triggers[0]?.steps.map((step) => step.action)).toContain("giveaway.create");
    expect(resourcesAndGiveaway.triggers[0]?.steps.map((step) => step.action)).toContain("resource.role.create");
    expect(resourcesAndGiveaway.triggers[0]?.steps.map((step) => step.action)).toContain("resource.channel.create_text");
    expect(resourcesAndGiveaway.triggers[0]?.steps.map((step) => step.action)).toContain("giveaway.create");
    const request = "Create a permissionless role, category, text channel and Giveaway in the same workflow.";
    expect(analyzeRequestRequirements(request).unifiedResourceInteraction).toBe(true);
    expect(validateWorkflowAgainstRequest(request, resourcesAndGiveaway)).toEqual([]);
    expect(validatePlanTargetAgainstRequest(request, "resources")).not.toHaveLength(0);
    expect(validatePlanTargetAgainstRequest(request, "interactive")).toHaveLength(0);
    const unguarded = structuredClone(resourcesAndGiveaway);
    const categoryStep = unguarded.triggers[0]!.steps.find((step) => step.action === "resource.channel.create_category");
    if (categoryStep) delete categoryStep.when;
    expect(interactiveWorkflowSchema.safeParse(unguarded).success).toBe(false);
    const wrongCategoryReference = structuredClone(resourcesAndGiveaway);
    const textStep = wrongCategoryReference.triggers[0]!.steps.find((step) => step.action === "resource.channel.create_text");
    if (textStep?.action === "resource.channel.create_text") textStep.categoryStepId = "missing-category";
    expect(interactiveWorkflowSchema.safeParse(wrongCategoryReference).success).toBe(false);
  });

  it("accepts persistent interval/deadline triggers and rejects member-only scheduled actions", () => {
    const recurring = interactiveWorkflowSchema.parse({ ...signup, triggers: [
      ...signup.triggers,
      { id: "daily-refresh", event: "schedule", intervalSeconds: 86400, steps: [{ id: "refresh", action: "panel.refresh" }] },
      { id: "close-deadline", event: "deadline", afterSeconds: 86400, steps: [{ id: "close-message", action: "message.send", content: "募集を締め切りました。" }] },
    ] });
    expect(recurring.triggers.filter((trigger) => trigger.event === "schedule" || trigger.event === "deadline")).toHaveLength(2);
    expect(interactiveWorkflowSchema.safeParse({ ...signup, triggers: [
      ...signup.triggers,
      { id: "scheduled-role", event: "schedule", intervalSeconds: 3600, steps: [{ id: "grant", action: "role.grant", roleName: "Member" }] },
    ] }).success).toBe(false);
  });

  it("accepts VoiceState join/leave triggers with threshold and empty-channel deletion", () => {
    expect(voiceSession.triggers.find((trigger) => trigger.event === "voice.member_join_event")?.steps.some((step) => step.action === "voice.channel.create")).toBe(true);
    expect(voiceSession.triggers.find((trigger) => trigger.event === "voice.member_leave_event")?.steps.some((step) => step.action === "voice.channel.delete")).toBe(true);
  });

  it("binds Modal submit fields to a typed Workflow trigger", () => {
    const modal = compileInteractiveWorkflow({
      version: 1, name: "Reason form", title: "Reason", description: "Describe your request", color: "purple",
      components: [{ key: "reason_form", kind: "modal", label: "Open form", title: "Request", triggerId: "submit_reason", inputs: [{ key: "reason", label: "Reason", placeholder: null, style: "paragraph", required: true, maxLength: 500 }] }],
      triggers: [{ id: "submit_reason", event: "modal_submit", componentKey: "reason_form", steps: [{ id: "save_reason", action: "state.set", scope: "member", key: "request_reason", value: "{{input:reason}}" }] }],
    });
    expect(modal.triggers[0]?.event).toBe("modal_submit");
  });

  it("orders stable step IDs by dependency and rejects cycles", () => {
    const ordered = orderInteractiveWorkflowSteps([
      { id: "finish", dependsOn: ["join"], action: "panel.refresh" },
      { id: "join", dependsOn: [], action: "entry.join" },
    ]);
    expect(ordered.map((step) => step.id)).toEqual(["join", "finish"]);
    const cyclic = structuredClone(signup);
    cyclic.triggers[0]!.steps[0]!.dependsOn = ["refresh"];
    cyclic.triggers[0]!.steps[1]!.dependsOn = ["register"];
    expect(interactiveWorkflowSchema.safeParse(cyclic).success).toBe(false);
  });

  it("requires explicit dependencies before reading a previous step result", () => {
    const withResult = structuredClone(signup);
    withResult.triggers[0]!.steps = [
      { id: "register", dependsOn: [], action: "entry.join", collection: "participants", maxEntries: 5 },
      { id: "notify", dependsOn: ["register"], action: "message.send", delivery: "workflow_channel", channelStepId: null, content: "Count {{result:register:count}}" },
      { id: "refresh", dependsOn: ["register"], action: "panel.refresh" },
    ];
    expect(interactiveWorkflowSchema.safeParse(withResult).success).toBe(true);
    withResult.triggers[0]!.steps[1]!.dependsOn = [];
    expect(interactiveWorkflowSchema.safeParse(withResult).success).toBe(false);
  });

  it("compiles generic entry invariants into count display and panel refresh steps", () => {
    const compiled = compileInteractiveWorkflow({
      version: 1, name: "Recruitment", title: "Recruitment", description: "Join here", color: "blue",
      components: [{ key: "join", kind: "button", label: "Join", style: "primary", emoji: null, triggerId: "join-trigger", disabledWhen: { op: "entries.gte", collection: "players", value: 5 } }],
      triggers: [{ id: "join-trigger", event: "button", componentKey: "join", steps: [{ id: "register", action: "entry.join", collection: "players", maxEntries: 5 }] }],
    });
    expect(compiled.description).toContain("{{entries:players:count}}");
    expect(compiled.triggers[0]?.steps.map((step) => step.action)).toEqual(["entry.join", "panel.refresh"]);
  });

  it("normalizes entry triggers with a display-count and panel refresh", () => {
    const invalid = structuredClone(signup);
    invalid.components[0] = { ...invalid.components[0]!, kind: "button", key: "join", label: "参加", style: "success", emoji: null, triggerId: "join-trigger" } as typeof invalid.components[number];
    invalid.triggers[0]!.steps = [{ id: "register", dependsOn: [], action: "entry.join", collection: "participants", maxEntries: 5 }];
    const compiled = compileInteractiveWorkflow(invalid);
    expect(compiled.description).toContain("{{entries:participants:count}}");
    expect(compiled.triggers[0]?.steps.map((step) => step.action)).toEqual(["entry.join", "panel.refresh"]);
  });

  it("renders a Components V2 container and evaluates the cap condition", () => {
    const rendered = renderInteractiveWorkflow("workflow-id", signup, { entries: { participants: 5 }, states: {}, roleNames: new Set(), permissions: new Set() });
    const root = JSON.parse(JSON.stringify(rendered.components?.[0])) as { type: number; components: { type: number; components?: { type: number; disabled?: boolean }[]; accessory?: { disabled?: boolean; custom_id?: string } }[] };
    expect(rendered.flags).toBe(MessageFlags.IsComponentsV2);
    const join = root.components.find((component) => component.accessory?.custom_id?.endsWith(":join"));
    expect(join?.accessory?.disabled).toBe(true);
    expect(evaluateWorkflowCondition(signup.components[0]!.disabledWhen!, { entries: { participants: 5 }, states: {}, roleNames: new Set(), permissions: new Set() })).toBe(true);
  });

  it("renders scoped state/input templates as data, not executable expressions", () => {
    expect(renderWorkflowTemplate("count={{entries:participants:count}} state={{state:member:consent}} input={{input:reason}}", {
      entries: { participants: 3 }, states: { "member:consent": true }, inputs: { reason: "OK" }, selected: [], actorId: "u1",
    })).toBe("count=3 state=true input=OK");
    expect(renderWorkflowTemplate("registered={{result:register:joined}}", {
      entries: {}, states: {}, results: { register: { joined: true } }, selected: [], inputs: {},
    })).toBe("registered=true");
  });

  it("evaluates bounded time-window predicates in the condition DSL", () => {
    const now = Date.now();
    expect(evaluateWorkflowCondition({ op: "time.within", startAt: new Date(now - 1000).toISOString(), endAt: new Date(now + 1000).toISOString() }, {
      entries: {}, states: {}, roleNames: new Set(), permissions: new Set(),
    })).toBe(true);
    expect(evaluateWorkflowCondition({ op: "and", conditions: [
      { op: "entries.lt", collection: "participants", value: 5 },
      { op: "time.within", startAt: new Date(now - 1000).toISOString(), endAt: new Date(now - 500).toISOString() },
    ] }, { entries: { participants: 1 }, states: {}, roleNames: new Set(), permissions: new Set() })).toBe(false);
  });
});
