import { describe, expect, it } from "vitest";
import { compileInteractiveWorkflow } from "./interactive-workflow.js";
import { analyzeRequestRequirements, validatePlanTargetAgainstRequest, validateWorkflowAgainstRequest } from "./requirements.js";

describe("request requirements and application-side plan validation", () => {
  it("requires a private Modal/state/owner-DM route for inquiry forms", () => {
    const request = "お問い合わせフォームを作成して";
    expect(analyzeRequestRequirements(request).requiredCapabilities).toEqual(["ui.modal", "trigger.modal_submit", "state.member.write", "notification.owner_dm"]);
    const form = compileInteractiveWorkflow({
      version: 1, name: "Contact", title: "お問い合わせ", description: "フォームから送信してください。", color: "blue",
      components: [{ key: "contact", kind: "modal", label: "入力する", title: "お問い合わせ", triggerId: "submit", inputs: [{ key: "message", label: "内容", placeholder: null, style: "paragraph", required: true, maxLength: 1000 }] }],
      triggers: [{ id: "submit", event: "modal_submit", componentKey: "contact", steps: [
        { id: "save", action: "state.set", scope: "member", key: "contact_message", value: "{{input:message}}" },
        { id: "notify", action: "message.send", delivery: "workflow_owner_dm", content: "問い合わせを受け付けました: {{input:message}}" },
      ] }],
    });
    expect(validateWorkflowAgainstRequest(request, form)).toEqual([]);
    expect(validateWorkflowAgainstRequest(request, { ...form, components: [{ key: "apply", kind: "button", label: "Contact", style: "primary", emoji: null, triggerId: "apply" }] } as typeof form).length).toBeGreaterThan(0);
    const roleSubstitution = compileInteractiveWorkflow({ ...form, triggers: [{ ...form.triggers[0]!, steps: [...form.triggers[0]!.steps, { id: "grant", action: "role.grant", roleName: "contact_form" }] }] });
    expect(validateWorkflowAgainstRequest(request, roleSubstitution).some((issue) => issue.includes("Role作成/配布"))).toBe(true);
    const publicLeak = compileInteractiveWorkflow({ ...form, triggers: [{ ...form.triggers[0]!, steps: form.triggers[0]!.steps.map((step) => step.action === "message.send" ? { ...step, delivery: "workflow_channel" as const } : step) }] });
    expect(validateWorkflowAgainstRequest(request, publicLeak).some((issue) => issue.includes("公開Workflow channel"))).toBe(true);
    expect(validatePlanTargetAgainstRequest(request, "panel")).toHaveLength(1);
    expect(validatePlanTargetAgainstRequest(request, "interactive")).toHaveLength(0);
  });

  it("requires VoiceState threshold/create/delete actions and refuses a panel downgrade", () => {
    const requirements = analyzeRequestRequirements("2人集まったら専用VCを作成し、全員退出したら削除する通話募集");
    expect(requirements.unsupportedSkills).toEqual([]);
    expect(requirements.voiceThreshold).toBe(2);
    expect(requirements.expectedEffects).toEqual(["create and gather members into a dedicated voice channel after 2 members join", "delete only the workflow-owned voice channel after it becomes empty"]);
    expect(validatePlanTargetAgainstRequest("VCを作成して", "panel")).toHaveLength(1);
    const workflow = compileInteractiveWorkflow({
      version: 1, name: "Voice team", title: "VC募集", description: "2人集まったら一時VCを作ります。", color: "blue",
      components: [{ key: "status", kind: "button", label: "状況", style: "secondary", emoji: null, triggerId: "status" }],
      triggers: [
        { id: "status", event: "button", componentKey: "status", steps: [{ id: "refresh", action: "panel.refresh" }] },
        { id: "create", event: "voice.member_join_event", voiceChannelId: "12345678901234567", steps: [{ id: "vc", action: "voice.channel.create", name: "team-voice", moveMembers: true, when: { op: "or", conditions: [{ op: "voice.members.gte", value: 2 }, { op: "voice.session.exists" }] } }] },
        { id: "delete", event: "voice.member_leave_event", steps: [{ id: "empty", action: "voice.channel.delete", when: { op: "voice.members.eq", value: 0 } }] },
      ],
    });
    expect(validateWorkflowAgainstRequest("2人集まったら専用VCを作成し、全員退出したら削除する通話募集", workflow)).toEqual([]);
  });

  it("keeps the 5-person recruitment cap and rejects unrelated target plans", () => {
    const request = "5人まで参加できるVALORANT募集。参加と取消、人数表示をつける";
    const requirements = analyzeRequestRequirements(request);
    expect(requirements.recruitmentCap).toBe(5);
    expect(requirements.expectedEffects).toContain("register unique members up to 5");
    expect(validatePlanTargetAgainstRequest(request, "resources")).toHaveLength(1);
  });
});
