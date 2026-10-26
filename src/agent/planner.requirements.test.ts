import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makePlan } from "./planner.js";
import { analyzeRequestRequirements, validatePlanTargetAgainstRequest, validateWorkflowAgainstRequest } from "./requirements.js";

const mocks = vi.hoisted(() => ({ generateOpenCodePlan: vi.fn() }));
vi.mock("./opencode.js", () => ({ generateOpenCodePlan: mocks.generateOpenCodePlan }));

const originalBackend = process.env.AI_BACKEND;
const originalFallback = process.env.AI_FALLBACK_MODEL;

function response(object: unknown) {
  mocks.generateOpenCodePlan.mockResolvedValue({ object, model: "mock/max", inputTokens: 10, outputTokens: 10 });
}

afterEach(() => {
  mocks.generateOpenCodePlan.mockReset();
  if (originalBackend === undefined) delete process.env.AI_BACKEND;
  else process.env.AI_BACKEND = originalBackend;
  if (originalFallback === undefined) delete process.env.AI_FALLBACK_MODEL;
  else process.env.AI_FALLBACK_MODEL = originalFallback;
});

describe("Agentcord Max requirement routing and plan verification", () => {
  it("requires a Modal workflow with member persistence and owner-only notification for contact requests", async () => {
    process.env.AI_BACKEND = "opencode-server";
    response({ target: "interactive", workflow: {
      version: 1, name: "Contact", title: "お問い合わせ", description: "内容を送信してください。", color: "blue",
      components: [{ key: "contact", kind: "modal", label: "入力する", title: "お問い合わせ", triggerId: "submit", inputs: [{ key: "message", label: "内容", placeholder: null, style: "paragraph", required: true, maxLength: 1000 }] }],
      triggers: [{ id: "submit", event: "modal_submit", componentKey: "contact", steps: [
        { id: "save", action: "state.set", scope: "member", key: "contact_message", value: "{{input:message}}" },
        { id: "notify", action: "message.send", delivery: "workflow_owner_dm", content: "問い合わせ: {{input:message}}" },
      ] }],
    } });
    const plan = await makePlan("お問い合わせフォームを作成して", undefined, "max");
    expect(plan.interactiveWorkflow?.components[0]?.kind).toBe("modal");
    expect(validateWorkflowAgainstRequest("お問い合わせフォームを作成して", plan.interactiveWorkflow!)).toEqual([]);
    expect(plan.interactiveWorkflow?.triggers[0]?.steps.some((step) => step.action === "role.grant")).toBe(false);
  });

  it("plans VoiceState-driven VC creation and empty-session deletion instead of a panel downgrade", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const request = "2人集まったら専用VCを作成し、全員退出したら削除する通話募集";
    const voiceWorkflow = {
      version: 1, name: "Temporary party VC", title: "VC募集", description: "Voice Lobbyの2人参加で専用VCを作ります。", color: "purple",
      components: [{ key: "status", kind: "button", label: "状態", style: "secondary", emoji: null, triggerId: "status" }],
      triggers: [
        { id: "status", event: "button", componentKey: "status", steps: [{ id: "refresh", action: "panel.refresh" }] },
        { id: "join", event: "voice.member_join_event", voiceChannelId: "12345678901234567", steps: [{ id: "create", action: "voice.channel.create", name: "party-voice", moveMembers: true, when: { op: "or", conditions: [{ op: "voice.members.gte", value: 2 }, { op: "voice.session.exists" }] } }] },
        { id: "leave", event: "voice.member_leave_event", steps: [{ id: "delete", action: "voice.channel.delete", when: { op: "voice.members.eq", value: 0 } }] },
      ],
    };
    response({ target: "interactive", workflow: voiceWorkflow });
    const plan = await makePlan(request, undefined, "max", undefined, [], [{ id: "12345678901234567", name: "Voice Lobby", category: null }]);
    expect(plan.interactiveWorkflow?.triggers.some((trigger) => trigger.event === "voice.member_join_event")).toBe(true);
    expect(validateWorkflowAgainstRequest(request, plan.interactiveWorkflow!)).toEqual([]);
    expect(analyzeRequestRequirements(request).unsupportedSkills).toEqual([]);
  });

  it("keeps the requested recruitment cap and rejects unrelated targets", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const workflow = JSON.parse(readFileSync(new URL("../../examples/workflows/valorant-recruitment.json", import.meta.url), "utf8"));
    response({ target: "interactive", workflow });
    const plan = await makePlan("5人まで参加できるVALORANT募集。参加と取消、人数表示", undefined, "max");
    expect(validateWorkflowAgainstRequest("5人まで参加できるVALORANT募集。参加と取消、人数表示", plan.interactiveWorkflow!)).toEqual([]);
    expect(validatePlanTargetAgainstRequest("お問い合わせフォームを作成して", "panel")).not.toHaveLength(0);
  });

  it("keeps Role, Channel and Giveaway actions in one Interactive target and normalizes permission labels", async () => {
    process.env.AI_BACKEND = "opencode-server";
    const workflow = JSON.parse(readFileSync(new URL("../../examples/workflows/resources-and-giveaway.json", import.meta.url), "utf8"));
    const category = workflow.triggers[0].steps.find((step: { action: string }) => step.action === "resource.channel.create_category");
    category.when.conditions[1].permission = "Manage Channels";
    response({ target: "interactive", workflow });
    const request = "Create a permissionless role, category, text channel and Giveaway in the same workflow.";
    const plan = await makePlan(request, undefined, "max");
    const actions = plan.interactiveWorkflow?.triggers.flatMap((trigger) => trigger.steps.map((step) => step.action)) ?? [];
    expect(plan.interactiveWorkflow).toBeDefined();
    expect(actions).toContain("resource.role.create");
    expect(actions).toContain("resource.channel.create_text");
    expect(actions).toContain("giveaway.create");
    expect(validateWorkflowAgainstRequest(request, plan.interactiveWorkflow!)).toEqual([]);
  });
});
