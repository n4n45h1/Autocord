import type { InteractiveWorkflow } from "./interactive-workflow.js";

export type RequestRequirements = {
  complex: boolean;
  contactForm: boolean;
  giveawayRequested: boolean;
  recruitmentCap: number | null;
  resourceRoleCreate: boolean;
  resourceCategoryCreate: boolean;
  resourceTextChannelCreate: boolean;
  resourceCreate: boolean;
  unifiedResourceInteraction: boolean;
  voiceRequested: boolean;
  voiceThreshold: number | null;
  requiredCapabilities: string[];
  expectedEffects: string[];
  unsupportedSkills: string[];
};

export function analyzeRequestRequirements(instruction: string): RequestRequirements {
  const normalized = instruction.toLocaleLowerCase();
  const contactForm = /お問い合わせ|問合せ|問い合わせ|contact\s*(form|us)|inquiry\s*form/.test(normalized);
  const giveawayRequested = /give\s*away|懸賞|抽選|配布企画|プレゼント企画|ギブアウェイ/i.test(instruction);
  const resourceRoleCreate = /(?:ロール|role).*(?:作成|create)|(?:作成|create).*(?:ロール|role)/i.test(instruction);
  const resourceCategoryCreate = /(?:カテゴリ|category).*(?:作成|create)|(?:作成|create).*(?:カテゴリ|category)/i.test(instruction);
  const resourceTextChannelCreate = /(?:テキストチャンネル|text\s*channel).*(?:作成|create)|(?:作成|create).*(?:テキストチャンネル|text\s*channel)/i.test(instruction);
  const resourceCreate = resourceRoleCreate || resourceCategoryCreate || resourceTextChannelCreate;
  const voiceRequested = /\bvc\b|ボイス|音声チャンネル|voice\s*(channel|chat)/i.test(instruction)
    && /作成|生成|開設|削除|退出|入室|集ま|create|delete|empty|join|leave/i.test(instruction);
  const voiceThresholdMatch = instruction.match(/(\d{1,2})\s*(?:人|名)\s*(?:集まったら|揃ったら|そろったら|以上になったら|members?\s*(?:join|gather))/i);
  const voiceThreshold = voiceRequested && voiceThresholdMatch ? Number(voiceThresholdMatch[1]) : null;
  const participantRequest = /募集|参加|定員|人数|recruit|signup|participant/i.test(instruction);
  const participantLimit = instruction.match(/(?:最大|上限|まで|max(?:imum)?\s*)\s*(\d{1,3})\s*(?:人|名|players?)|(?:\b|^)(\d{1,3})\s*(?:人|名)\s*(?:まで|募集|参加)/i);
  const recruitmentCap = participantRequest && participantLimit ? Number(participantLimit[1] ?? participantLimit[2]) : null;
  const validRecruitmentCap = Number.isInteger(recruitmentCap) && recruitmentCap! > 0 ? recruitmentCap : null;
  const unifiedResourceInteraction = resourceCreate && /workflow|interactive|ボタン|panel|フォーム|同意|募集|give\s*away|懸賞/i.test(instruction);
  const unsupportedSkills: string[] = [];
  if (/ポイント|points/i.test(instruction) && /交換|redeem|redemption/i.test(instruction)) unsupportedSkills.push("workflow.atomic_conditional_debit_and_redemption");
  if (/\brpg\b|戦士|魔法使い|僧侶/i.test(instruction) && /戦闘|バトル|ショップ|経験値|攻撃力/i.test(instruction)) unsupportedSkills.push("workflow.turn_based_game_loop_and_transactional_shop");
  if (/チケット|問い合わせ|inquiry/i.test(instruction) && /専用チャンネル|スタッフだけ|private\s*channel/i.test(instruction)) unsupportedSkills.push("channel.private_ticket_permission_preset_and_close_lifecycle");
  if (/(?:賛成|賛成票|vote|votes).{0,30}\d{1,3}\s*票|\d{1,3}\s*票.{0,30}(?:賛成|vote)/i.test(instruction)) unsupportedSkills.push("trigger.reaction_added_and_atomic_unique_vote_threshold");
  if (/毎週.{0,8}土曜|毎週.{0,8}土曜日|every\s+saturday/i.test(instruction)) unsupportedSkills.push("schedule.at_timezone_and_weekly_calendar_trigger");
  if (voiceRequested && /ボタン.{0,12}参加|参加.{0,12}ボタン|button.{0,20}join/i.test(instruction)) unsupportedSkills.push("workflow.button_signup_to_voice_session_membership");
  const requiredCapabilities = [
    ...(contactForm ? ["ui.modal", "trigger.modal_submit", "state.member.write", "notification.owner_dm"] : []),
    ...(giveawayRequested ? ["giveaway.create", "giveaway.join", "giveaway.leave", "giveaway.draw_and_notify"] : []),
    ...(validRecruitmentCap !== null ? ["trigger.button", "entry.unique", "entry.capacity", "entry.cancel", "panel.refresh"] : []),
    ...(voiceRequested ? ["voice.member_join_event", "voice.channel.create", "voice.member_leave_event", "voice.channel.delete"] : []),
    ...unsupportedSkills,
    ...(resourceRoleCreate ? ["resource.role.create"] : []),
    ...(resourceCategoryCreate ? ["resource.channel.create_category"] : []),
    ...(resourceTextChannelCreate ? ["resource.channel.create_text"] : []),
  ];
  const expectedEffects = [
    ...(contactForm ? ["store submitted fields in member state", "send submitted content only to workflow owner privately"] : []),
    ...(giveawayRequested ? ["create a time-bounded workflow-owned giveaway", "register unique participants and draw winners"] : []),
    ...(validRecruitmentCap !== null ? [`register unique members up to ${validRecruitmentCap}`, "refresh count and disable join at capacity"] : []),
    ...(voiceRequested ? [`create and gather members into a dedicated voice channel after ${voiceThreshold ?? "a configured"} members join`, "delete only the workflow-owned voice channel after it becomes empty"] : []),
    ...(resourceRoleCreate ? ["create a permissionless Autocord-owned role"] : []),
    ...(resourceCategoryCreate ? ["create a default-permission category"] : []),
    ...(resourceTextChannelCreate ? ["create a default-permission text channel"] : []),
  ];
  return {
    complex: contactForm || giveawayRequested || voiceRequested || validRecruitmentCap !== null || resourceCreate || unsupportedSkills.length > 0 || /schedule|定期|期限|modal|フォーム|ワークフロー/i.test(instruction),
    contactForm,
    giveawayRequested,
    recruitmentCap: validRecruitmentCap,
    resourceRoleCreate,
    resourceCategoryCreate,
    resourceTextChannelCreate,
    resourceCreate,
    unifiedResourceInteraction,
    voiceRequested,
    voiceThreshold: Number.isInteger(voiceThreshold) && voiceThreshold! > 0 ? voiceThreshold : null,
    requiredCapabilities,
    expectedEffects,
    unsupportedSkills: [...new Set(unsupportedSkills)],
  };
}

export function validateWorkflowAgainstRequest(instruction: string, workflow: InteractiveWorkflow): string[] {
  const requirements = analyzeRequestRequirements(instruction);
  const issues: string[] = [];
  if (requirements.contactForm) {
    const modalComponents = workflow.components.filter((component) => component.kind === "modal");
    const modalTriggers = workflow.triggers.filter((trigger) => trigger.event === "modal_submit");
    if (!modalComponents.length || !modalTriggers.length) issues.push("お問い合わせフォームはModal表示とmodal_submit triggerが必須です。");
    const steps = modalTriggers.flatMap((trigger) => trigger.steps);
    if (!steps.some((step) => step.action === "state.set" && step.scope === "member" && typeof step.value === "string" && step.value.includes("{{input:"))) issues.push("Modal入力をmember-scoped stateへ保存するstate.setがありません。");
    if (!steps.some((step) => step.action === "message.send" && step.delivery === "workflow_owner_dm" && step.content.includes("{{input:"))) issues.push("問い合わせ内容を公開チャンネルへ出さずWorkflow ownerへDM通知するmessage.sendがありません。");
    if (workflow.description.includes("{{input:") || workflow.description.includes("{{state:member:")) issues.push("個人のModal入力/member stateを公開パネル本文に含めることはできません。");
    for (const step of workflow.triggers.flatMap((trigger) => trigger.steps)) {
      const leaksPrivateData = (content: string) => content.includes("{{input:") || content.includes("{{state:member:");
      if (step.action === "message.send" && step.delivery === "workflow_channel" && leaksPrivateData(step.content)) issues.push("個人の問い合わせ内容を公開Workflow channelへ送るactionは禁止です。");
      if (step.action === "message.edit" && leaksPrivateData(step.content)) issues.push("個人の問い合わせ内容を公開Workflow panelへ編集表示するactionは禁止です。");
    }
    const explicitlyRequestsRole = /ロール|役割|role/i.test(instruction);
    if (!explicitlyRequestsRole && workflow.triggers.some((trigger) => trigger.steps.some((step) => step.action === "role.grant" || step.action === "role.revoke" || step.action === "resource.role.create"))) issues.push("問い合わせフォームだけの依頼にRole作成/配布を追加できません。");
  }
  if (requirements.recruitmentCap !== null) {
    const joins = workflow.triggers.flatMap((trigger) => trigger.steps.filter((step) => step.action === "entry.join"));
    if (!joins.some((step) => step.maxEntries === requirements.recruitmentCap)) issues.push(`要求された参加上限${requirements.recruitmentCap}人に一致するentry.joinがありません。`);
    for (const join of joins.filter((step) => step.maxEntries === requirements.recruitmentCap)) {
      if (!workflow.triggers.some((trigger) => trigger.steps.some((step) => step.action === "entry.leave" && step.collection === join.collection))) issues.push(`参加取消用entry.leave(${join.collection})がありません。`);
      if (!workflow.description.includes(`{{entries:${join.collection}:count}}`)) issues.push(`募集人数の表示template {{entries:${join.collection}:count}}がありません。`);
    }
  }
  if (requirements.voiceRequested) {
    const joinTrigger = workflow.triggers.find((trigger) => trigger.event === "voice.member_join_event");
    const leaveTrigger = workflow.triggers.find((trigger) => trigger.event === "voice.member_leave_event");
    const createStep = joinTrigger?.steps.find((step) => step.action === "voice.channel.create");
    const deleteStep = leaveTrigger?.steps.find((step) => step.action === "voice.channel.delete");
    if (!joinTrigger || !createStep) issues.push("VC作成にはvoice.member_join_eventとvoice.channel.createが必要です。");
    if (!leaveTrigger || !deleteStep) issues.push("空室削除にはvoice.member_leave_eventとvoice.channel.deleteが必要です。");
    if (!createStep?.moveMembers) issues.push("作成VCへの参加者移動(moveMembers)が必要です。");
    if (requirements.voiceThreshold === null) issues.push("VC作成を開始する人数のしきい値を確認してください。");
    if (requirements.voiceThreshold !== null && createStep) {
      const conditionList = createStep.when?.op === "or" ? createStep.when.conditions : [];
      const hasThreshold = conditionList.some((condition) => condition.op === "voice.members.gte" && condition.value === requirements.voiceThreshold);
      const reusesSession = conditionList.some((condition) => condition.op === "voice.session.exists");
      if (!hasThreshold || !reusesSession) issues.push(`voice.channel.createはvoice.members.gte=${requirements.voiceThreshold} OR voice.session.existsで実行し、既存VCの重複作成を避けてください。`);
    }
    if (deleteStep) {
      const conditionList = deleteStep.when ? deleteStep.when.op === "and" || deleteStep.when.op === "or" ? deleteStep.when.conditions : [deleteStep.when] : [];
      if (!conditionList.some((condition) => condition.op === "voice.members.eq" && condition.value === 0)) issues.push("voice.channel.deleteには空室(voice.members.eq=0)の条件が必要です。");
    }
  }
  if (requirements.giveawayRequested) {
    const createSteps = workflow.triggers.flatMap((trigger) => trigger.steps.filter((step) => step.action === "giveaway.create"));
    const joinSteps = workflow.triggers.flatMap((trigger) => trigger.steps.filter((step) => step.action === "giveaway.join"));
    const leaveSteps = workflow.triggers.flatMap((trigger) => trigger.steps.filter((step) => step.action === "giveaway.leave"));
    if (!createSteps.length) issues.push("Giveaway要求にはgiveaway.createが必要です。");
    if (!joinSteps.some((step) => step.giveawayId.includes("active_giveaway_id"))) issues.push("Giveaway参加にはWorkflow所有active_giveaway_idへのgiveaway.joinが必要です。");
    if (!leaveSteps.some((step) => step.giveawayId.includes("active_giveaway_id"))) issues.push("Giveaway取消にはWorkflow所有active_giveaway_idへのgiveaway.leaveが必要です。");
  }
  if (requirements.unifiedResourceInteraction) {
    const steps = workflow.triggers.flatMap((trigger) => trigger.steps);
    if (requirements.resourceRoleCreate && !steps.some((step) => step.action === "resource.role.create")) issues.push("同一Workflow内にresource.role.createが必要です。");
    if (requirements.resourceCategoryCreate && !steps.some((step) => step.action === "resource.channel.create_category")) issues.push("同一Workflow内にresource.channel.create_categoryが必要です。");
    if (requirements.resourceTextChannelCreate && !steps.some((step) => step.action === "resource.channel.create_text")) issues.push("同一Workflow内にresource.channel.create_textが必要です。");
  }
  return issues;
}

export function validatePlanTargetAgainstRequest(instruction: string, target: "panel" | "resources" | "interactive"): string[] {
  const requirements = analyzeRequestRequirements(instruction);
  if (requirements.unsupportedSkills.length) return [`未実装Skillsが必要です: ${requirements.unsupportedSkills.join("、")}`];
  if ((requirements.contactForm || requirements.giveawayRequested || requirements.recruitmentCap !== null || requirements.voiceRequested || requirements.unifiedResourceInteraction) && target !== "interactive") return ["要求を満たすInteractive Workflowではないため、Panel/Resource Planへの置換を拒否しました。"];
  if (requirements.resourceCreate && target === "panel") return ["Resource creation request cannot be converted to a role panel."];
  return [];
}
