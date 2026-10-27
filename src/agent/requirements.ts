import type { InteractiveWorkflow, InteractiveWorkflowStep, WorkflowCondition } from "./interactive-workflow.js";

function conditionLeaves(condition: WorkflowCondition): WorkflowCondition[] {
  if (condition.op === "not") return conditionLeaves(condition.condition);
  if (condition.op === "and" || condition.op === "or") return condition.conditions.flatMap(conditionLeaves);
  return [condition];
}

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
  pointsRequested: boolean;
  privateTicketRequested: boolean;
  voteRequested: boolean;
  voteThreshold: number | null;
  weeklyScheduleRequested: boolean;
  weeklyResetAfterEvent: boolean;
  weeklyHour: number | null;
  weeklyMinute: number | null;
  weeklyTimeZone: string | null;
  weeklyDurationSeconds: number | null;
  requiredCapabilities: string[];
  expectedEffects: string[];
  unsupportedSkills: string[];
  missingInformation: string[];
};

export function analyzeRequestRequirements(instruction: string): RequestRequirements {
  const normalized = instruction.toLocaleLowerCase();
  const contactForm = /お問い合わせ|問合せ|問い合わせ|contact\s*(form|us)|inquiry\s*form/.test(normalized);
  const privateTicketRequested = contactForm && /専用チャンネル|スタッフだけ|スタッフ.{0,8}限定|staff|support.*(?:限定|only)|private[-_\s]*ticket/i.test(instruction);
  const giveawayRequested = /give\s*away|懸賞|抽選|配布企画|プレゼント企画|ギブアウェイ/i.test(instruction);
  const resourceRoleCreate = /(?:ロール|役割|\brole\b).{0,80}(?:作成|作って|追加|create)|(?:作成|作って|追加|create).{0,80}(?:ロール|役割|\brole\b)/i.test(instruction);
  const resourceCategoryCreate = /(?:カテゴリ|category).*(?:作成|create)|(?:作成|create).*(?:カテゴリ|category)/i.test(instruction);
  const resourceTextChannelCreate = /(?:テキストチャンネル|text\s*channel).*(?:作成|create)|(?:作成|create).*(?:テキストチャンネル|text\s*channel)/i.test(instruction);
  const resourceCreate = resourceRoleCreate || resourceCategoryCreate || resourceTextChannelCreate;
  const voiceRequested = /\bvc\b|ボイス|音声チャンネル|voice\s*(channel|chat)/i.test(instruction)
    && /作成|生成|開設|削除|退出|入室|集ま|create|delete|empty|join|leave/i.test(instruction);
  const voiceThresholdMatch = instruction.match(/(\d{1,2})\s*(?:人|名)|(?:閾値|threshold)\s*(?:は|=|:)?\s*(\d{1,2})/i);
  const voiceThreshold = voiceRequested && voiceThresholdMatch ? Number(voiceThresholdMatch[1] ?? voiceThresholdMatch[2]) : null;
  const pointsRequested = /ポイント|\bpoints?\b|\bpt\b|\d+\s*pt\b/i.test(instruction) && /交換|景品|redeem|reward|報酬|引き落|引落|減算|消費|\bdebit\b/i.test(instruction);
  const voteRequested = /賛成|投票|vote|票|likes?/i.test(instruction) && (/票|votes?|likes?|1人1票/i.test(instruction));
  const voteCounts = voteRequested ? [...instruction.matchAll(/(\d{1,3})\s*票|(\d{1,3})\s*votes?/gi)].map((match) => Number(match[1] ?? match[2])) : [];
  const voteThreshold = voteCounts.find((count) => count > 1) ?? voteCounts[0] ?? null;
  const weeklyScheduleRequested = /毎週.{0,8}土曜|every\s+saturday/i.test(instruction);
  const weeklyClockMatch = instruction.match(/\b(\d{1,2}):(\d{2})\b|(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/i);
  const weeklyHour = weeklyClockMatch ? Number(weeklyClockMatch[1] ?? weeklyClockMatch[3]) : null;
  const weeklyMinute = weeklyClockMatch ? Number(weeklyClockMatch[2] ?? weeklyClockMatch[4] ?? 0) : null;
  const zoneMatch = instruction.match(/\b(?:JST|UTC|GMT)\b|\b[A-Za-z_]+\/[A-Za-z_+-]+\b|[+-]\d{2}:?\d{2}/i);
  const weeklyTimeZone = zoneMatch?.[0].toUpperCase() === "JST" ? "Asia/Tokyo" : zoneMatch?.[0] ?? null;
  const weeklyDurationMatch = instruction.match(/(\d{1,3})\s*(?:時間|hours?)\s*(?:(\d{1,2})\s*(?:分|minutes?))?|(\d{1,4})\s*(?:分|minutes?)/i);
  const weeklyDurationSeconds = weeklyDurationMatch ? (Number(weeklyDurationMatch[1] ?? 0) * 3600 + Number(weeklyDurationMatch[2] ?? 0) * 60 + Number(weeklyDurationMatch[3] ?? 0) * 60) : null;
  const weeklyResetAfterEvent = /終了後|イベント後|after\s+(?:the\s+)?event/i.test(instruction) && /ランキング|rank|reset|リセット/i.test(instruction);
  const participantRequest = /募集|参加|定員|人数|recruit|signup|participant/i.test(instruction);
  const participantLimit = instruction.match(/(?:最大|上限|まで|max(?:imum)?\s*)\s*(\d{1,3})\s*(?:人|名|players?)|(?:\b|^)(\d{1,3})\s*(?:人|名)\s*(?:まで|募集|参加)/i);
  const explicitButtonRecruitment = /button|ボタン|参加ボタン/i.test(instruction);
  const recruitmentCap = participantRequest && participantLimit && (!voiceRequested || explicitButtonRecruitment) ? Number(participantLimit[1] ?? participantLimit[2]) : null;
  const validRecruitmentCap = Number.isInteger(recruitmentCap) && recruitmentCap! > 0 ? recruitmentCap : null;
  const unifiedResourceInteraction = resourceCreate && /workflow|interactive|ボタン|panel|フォーム|同意|募集|give\s*away|懸賞/i.test(instruction);
  const unsupportedSkills: string[] = [];
  if (/\brpg\b|戦士|魔法使い|僧侶/i.test(instruction) && /戦闘|バトル|ショップ|経験値|攻撃力/i.test(instruction)) unsupportedSkills.push("workflow.turn_based_game_loop_and_transactional_shop");
  if (voiceRequested && /ボタン.{0,12}参加|参加.{0,12}ボタン|button.{0,20}join/i.test(instruction)) unsupportedSkills.push("workflow.button_signup_to_voice_session_membership");
  const missingInformation = [
    ...(weeklyScheduleRequested && weeklyHour === null ? ["毎週イベントを実行する時刻 (例: 18:00)"] : []),
    ...(weeklyScheduleRequested && !weeklyTimeZone ? ["毎週イベントのIANAタイムゾーン (例: Asia/Tokyo)"] : []),
    ...(weeklyScheduleRequested && weeklyResetAfterEvent && weeklyDurationSeconds === null ? ["イベントの開催時間/終了時刻 (ランキングをリセットする遅延時間)"] : []),
  ];
  const requiredCapabilities = [
    ...(contactForm ? ["ui.modal", "trigger.modal_submit", "state.member.write", "notification.owner_dm"] : []),
    ...(giveawayRequested ? ["giveaway.create", "giveaway.join", "giveaway.leave", "giveaway.draw_and_notify"] : []),
    ...(validRecruitmentCap !== null ? ["trigger.button", "entry.unique", "entry.capacity", "entry.cancel", "panel.refresh"] : []),
    ...(voiceRequested ? ["voice.member_join_event", "voice.channel.create", "voice.member_leave_event", "voice.channel.delete"] : []),
    ...(pointsRequested ? ["entry.unique", "state.member.increment", "state.member.atomic_debit", "message.dm"] : []),
    ...(privateTicketRequested ? ["channel.create_text.staff_only", "message.send.private_channel", "channel.delete.owner_or_staff"] : []),
    ...(voteRequested ? ["trigger.reaction.added", "collection.add.partitioned_by_message", "collection.count", "notification.workflow_owner_dm"] : []),
    ...(weeklyScheduleRequested ? ["schedule.at"] : []),
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
    ...(pointsRequested ? ["award 100 points only after a new unique event entry", "atomically debit at least 500 points before sending the redemption result privately"] : []),
    ...(privateTicketRequested ? ["store inquiry inputs only in a staff-only Workflow-owned Text Channel", "allow the ticket owner or configured staff role to close only that owned ticket"] : []),
    ...(voteRequested && voteThreshold !== null ? [`count one unique vote per user and notify the Workflow owner at exactly ${voteThreshold} votes`] : []),
    ...(weeklyScheduleRequested ? ["start a persistent weekly Saturday schedule in the requested local time zone"] : []),
    ...(resourceRoleCreate ? ["create a permissionless Autocord-owned role"] : []),
    ...(resourceCategoryCreate ? ["create a default-permission category"] : []),
    ...(resourceTextChannelCreate ? ["create a default-permission text channel"] : []),
  ];
  return {
    complex: contactForm || giveawayRequested || voiceRequested || pointsRequested || privateTicketRequested || voteRequested || weeklyScheduleRequested || validRecruitmentCap !== null || resourceCreate || unsupportedSkills.length > 0 || /schedule|定期|期限|modal|フォーム|ワークフロー/i.test(instruction),
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
    pointsRequested,
    privateTicketRequested,
    voteRequested,
    voteThreshold,
    weeklyScheduleRequested,
    weeklyResetAfterEvent,
    weeklyHour,
    weeklyMinute,
    weeklyTimeZone,
    weeklyDurationSeconds,
    requiredCapabilities,
    expectedEffects,
    unsupportedSkills: [...new Set(unsupportedSkills)],
    missingInformation,
  };
}

export function validateWorkflowAgainstRequest(instruction: string, workflow: InteractiveWorkflow): string[] {
  const requirements = analyzeRequestRequirements(instruction);
  const issues: string[] = [];
  if (requirements.pointsRequested) {
    const steps = workflow.triggers.flatMap((trigger) => trigger.steps);
    const registration = steps.find((step) => step.action === "entry.join")
      ?? steps.find((step) => step.action === "collection.add" && step.scope === "workflow" && typeof step.item === "string" && step.item.includes("{{actor}}"));
    const award = steps.find((step) => step.action === "state.increment" && step.scope === "member" && step.key === "points" && step.amount === 100);
    const awardField = registration?.action === "entry.join" ? "joined" : "added";
    const awardGuard = award?.when?.op === "result.equals" && registration && award.when.stepId === registration.id && award.when.field === awardField && award.when.value === true
      || award?.when?.op === "and" && registration && award.when.conditions.some((condition) => condition.op === "result.equals" && condition.stepId === registration.id && condition.field === awardField && condition.value === true);
    if (!registration) issues.push("ポイント加算にはactor-keyed collection.addまたは一意entry.joinが必要です。");
    if (!award || !registration || !award.dependsOn.includes(registration.id) || !awardGuard) issues.push("新規参加時だけmember pointsへ100を加算する依存条件がありません。");
    const debit = steps.find((step) => step.action === "state.debit" && step.scope === "member" && step.key === "points" && Number(step.amount) === 500 && Number(step.minimumBalance) >= 500 && Boolean(step.idempotencyKey));
    if (!debit) issues.push("state.debitはmember pointsにamount=500、minimumBalance=500と固定idempotencyKeyを指定し、同一DB transactionで一度だけ引き落としてください。");
    if (!debit || !steps.some((step) => step.action === "message.dm" && step.recipient === "trigger_member" && step.dependsOn.includes(debit.id) && (step.when?.op === "result.equals" && step.when.stepId === debit.id && step.when.field === "debited" && step.when.value === true || step.when?.op === "and" && step.when.conditions.some((condition) => condition.op === "result.equals" && condition.stepId === debit.id && condition.field === "debited" && condition.value === true)))) issues.push("交換成功時のみ実行するmember DM通知がありません。");
  }
  if (requirements.voteRequested) {
    const voteTrigger = workflow.triggers.find((trigger) => trigger.event === "reaction.added");
    const add = voteTrigger?.steps.find((step) => step.action === "collection.add" && step.scope === "workflow" && step.partitionByMessage && typeof step.item === "string" && step.item.includes("{{input:authorId}}"));
    const addCollection = add && "collection" in add ? add.collection : undefined;
    const count = voteTrigger?.steps.find((step) => "collection" in step && step.action === "collection.count" && step.partitionByMessage && step.collection === addCollection && add && step.dependsOn.includes(add.id));
    const notification = voteTrigger?.steps.find((step) => step.action === "message.send" && step.delivery === "workflow_owner_dm");
    const guardedAdd = notification?.when?.op === "and" && add && notification.when.conditions.some((condition) => condition.op === "result.equals" && condition.stepId === add.id && condition.field === "added" && condition.value === true);
    const guardedCount = notification?.when?.op === "and" && count && notification.when.conditions.some((condition) => condition.op === "result.equals" && condition.stepId === count.id && condition.field === "count" && condition.value === requirements.voteThreshold);
    if (requirements.voteThreshold === null) issues.push("投票の賛成票閾値を数値で指定してください。");
    if (!voteTrigger) issues.push("投票にはreaction.added triggerが必要です。");
    if (!add) issues.push("投票者をmessage-partitioned Collectionへ重複なしで追加するcollection.addがありません。");
    if (!count) issues.push("新規投票後の同一message Collection countがありません。");
    if (!notification) issues.push("閾値到達時のWorkflow owner DMがありません。");
    if (notification && (!guardedAdd || !guardedCount)) issues.push("Owner DMはnew add (added=true) AND count==thresholdでguardしてください。");
    if (notification && count && !notification.dependsOn.includes(count.id)) issues.push("投票通知はCollection countに依存してください。");
  }
  if (requirements.weeklyScheduleRequested) {
    const weeklyTrigger = workflow.triggers.find((trigger) => trigger.event === "schedule.at");
    if (!weeklyTrigger) issues.push("毎週土曜のcalendar実行にはschedule.at triggerが必要です。");
    else {
      if (weeklyTrigger.dayOfWeek !== 6 || weeklyTrigger.hour !== requirements.weeklyHour || weeklyTrigger.minute !== requirements.weeklyMinute || weeklyTrigger.timeZone !== requirements.weeklyTimeZone) issues.push("schedule.atの曜日・時刻・IANA timezoneが要求に一致しません。");
      if (requirements.weeklyResetAfterEvent) {
        const wait = weeklyTrigger.steps.find((step) => step.action === "workflow.wait" && step.seconds === requirements.weeklyDurationSeconds);
        const reset = weeklyTrigger.steps.find((step) => (step.action === "collection.clear" || step.action === "state.reset") && "scope" in step && step.scope !== "member");
        if (!wait || !reset || !reset.dependsOn.includes(wait.id)) issues.push("イベント終了後のランキングresetには指定遅延のworkflow.waitと、それに依存するWorkflow/Guild Collection clearまたはState resetが必要です。");
      }
    }
  }
  if (requirements.contactForm) {
    const modalComponents = workflow.components.filter((component) => component.kind === "modal");
    const modalTriggers = workflow.triggers.filter((trigger) => trigger.event === "modal_submit");
    if (!modalComponents.length || !modalTriggers.length) issues.push("お問い合わせフォームはModal表示とmodal_submit triggerが必須です。");
    const steps = modalTriggers.flatMap((trigger) => trigger.steps);
    if (requirements.privateTicketRequested) {
      const ticketSteps = steps.filter((step) => step.action === "channel.create_text" && step.visibility === "staff_only");
      const savesTicketId = steps.some((step) => step.action === "state.set" && step.scope === "member" && ticketSteps.some((ticket) => typeof step.value === "string" && step.value.includes(`{{result:${ticket.id}:channelId}}`)));
      if (!savesTicketId) issues.push("作成したticket IDをmember-scoped stateへ保存するstate.setがありません。");
    } else if (!steps.some((step) => step.action === "state.set" && step.scope === "member" && typeof step.value === "string" && step.value.includes("{{input:"))) issues.push("Modal入力をmember-scoped stateへ保存するstate.setがありません。");
    if (requirements.privateTicketRequested) {
      const ticket = steps.find((step) => step.action === "channel.create_text" && step.visibility === "staff_only" && Boolean(step.staffRoleId));
      if (!ticket) issues.push("スタッフだけが閲覧できるstaff_only channel.create_textと事前設定済みstaffRoleIdがありません。");
      const ticketModal = modalTriggers.find((trigger) => trigger.steps.some((step) => step.action === "channel.create_text" && step.visibility === "staff_only"));
      const modalComponent = ticketModal ? workflow.components.find((component): component is Extract<InteractiveWorkflow["components"][number], { kind: "modal" }> => component.kind === "modal" && component.triggerId === ticketModal.id) : undefined;
      const formInputs = modalComponent?.inputs.map((input) => input.key) ?? [];
      const privateSends = ticket ? steps.filter((step): step is Extract<InteractiveWorkflowStep, { action: "message.send" }> => step.action === "message.send" && step.delivery === "workflow_channel_step" && step.channelStepId === ticket.id) : [];
      if (!ticket || !privateSends.length || !formInputs.length || !formInputs.every((key) => privateSends.some((send) => send.content.includes(`{{input:${key}}}`)))) issues.push("すべてのModal回答を{{input:key}} templateでstaff_only ticket channelへ送るmessage.sendがありません。");
      const staffClose = workflow.triggers.some((trigger) => trigger.event === "modal_submit" && trigger.steps.some((step) => step.action === "channel.delete" && typeof step.channelId === "string" && step.channelId.includes("{{input:") && step.when && conditionLeaves(step.when).some((condition) => condition.op === "member.has_role")));
      if (!staffClose) issues.push("Workflow所有ticketだけをstaff roleで閉じるchannel.delete actionがありません。");
    } else if (!steps.some((step) => step.action === "message.send" && step.delivery === "workflow_owner_dm" && step.content.includes("{{input:"))) issues.push("問い合わせ内容を公開チャンネルへ出さずWorkflow ownerへDM通知するmessage.sendがありません。");
    if (workflow.description.includes("{{input:") || workflow.description.includes("{{state:member:")) issues.push("個人のModal入力/member stateを公開パネル本文に含めることはできません。");
    for (const step of workflow.triggers.flatMap((trigger) => trigger.steps)) {
      const leaksPrivateData = (content: string) => content.includes("{{input:") || content.includes("{{state:member:");
      if (step.action === "message.send") {
        if (step.delivery === "workflow_channel" && leaksPrivateData(step.content)) issues.push("個人の問い合わせ内容を公開Workflow channelへ送るactionは禁止です。");
        if (requirements.privateTicketRequested && leaksPrivateData(step.content)) {
          const target = workflow.triggers.flatMap((trigger) => trigger.steps).find((candidate) => candidate.id === step.channelStepId);
          if (step.delivery !== "workflow_channel_step" || target?.action !== "channel.create_text" || target.visibility !== "staff_only") issues.push("private ticketのModal回答はstaff_only ticket channel以外へ送信できません。");
        }
      }
      if (step.action === "message.send" && step.delivery === "workflow_channel_step" && leaksPrivateData(step.content)) {
        const target = workflow.triggers.flatMap((trigger) => trigger.steps).find((candidate) => candidate.id === step.channelStepId);
        if (target?.action !== "channel.create_text" || target.visibility !== "staff_only") issues.push("個人の問い合わせ内容はstaff_only ticket channel以外へ送信できません。");
      }
      if (step.action === "message.edit" && leaksPrivateData(step.content)) issues.push("個人の問い合わせ内容を公開Workflow panelへ編集表示するactionは禁止です。");
    }
    const explicitlyRequestsRole = /ロール|役割|\brole\b/i.test(instruction);
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
