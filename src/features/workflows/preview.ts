import type { InteractiveWorkflow, InteractiveWorkflowStep } from "../../agent/interactive-workflow.js";

export function interactiveWorkflowSummary(workflow: InteractiveWorkflow): string {
  const effect = (step: InteractiveWorkflowStep): string => {
    switch (step.action) {
      case "entry.join": return `entry.join ${step.collection} max=${step.maxEntries}`;
      case "entry.leave": return `entry.leave ${step.collection}`;
      case "state.set": return `state.set ${step.scope}:${step.key} = ${JSON.stringify(step.value)}`;
      case "role.grant": return `role.grant ${step.roleName} to trigger member`;
      case "role.revoke": return `role.revoke ${step.roleName} from trigger member`;
      case "message.send": return `${step.delivery === "workflow_owner_dm" ? "message.send → Workflow owner DM" : step.delivery === "workflow_channel_step" ? `message.send → created channel step ${step.channelStepId} (private routing depends on that channel's visibility)` : "message.send → published workflow channel"}; content=${JSON.stringify(step.content)}`;
      case "message.edit": return `message.edit Workflow panel/message display; content=${JSON.stringify(step.content)}`;
      case "message.dm": return `message.dm → ${step.recipient === "workflow_owner" ? "Workflow owner" : "triggering member"}; content=${JSON.stringify(step.content)}`;
      case "message.reply": return `message.reply → triggering source message; content=${JSON.stringify(step.content)}`;
      case "message.delete": return `message.delete Workflow message from step ${step.targetStepId}`;
      case "message.pin": return `message.pin Workflow message from step ${step.targetStepId}`;
      case "message.unpin": return `message.unpin Workflow message from step ${step.targetStepId}`;
      case "panel.refresh": return "panel.refresh rendered state/components";
      case "voice.channel.create": return `voice.channel.create ${step.name}; moveMembers=${step.moveMembers}; copy source permission overwrites`;
      case "voice.channel.delete": return "voice.channel.delete Workflow-owned channel when empty";
      case "channel.move_members": return `channel.move_members registered members in ${step.collection}, max ${step.maxMembers}, into owned channel step ${step.channelStepId}`;
      case "channel.delete_empty": return "channel.delete_empty internal cleanup of the owned voice channel after empty-state recheck";
      case "resource.role.create": return `resource.role.create ${step.name} (no permissions)`;
      case "resource.channel.create_category": return `resource.channel.create_category ${step.name} (Guild default permissions)`;
      case "resource.channel.create_text": return `resource.channel.create_text ${step.name}${step.categoryStepId ? ` under category step ${step.categoryStepId}` : ""} (Guild default permissions)`;
      case "giveaway.create": return `giveaway.create ${step.prize}; ${step.winnerCount} winners; ${step.durationSeconds}s`;
      case "giveaway.join": return `giveaway.join ${step.giveawayId} for trigger member`;
      case "giveaway.leave": return `giveaway.leave ${step.giveawayId} for trigger member`;
      case "giveaway.end": return `giveaway.end ${step.giveawayId}`;
      case "giveaway.pause": return `giveaway.pause ${step.giveawayId}`;
      case "giveaway.resume": return `giveaway.resume ${step.giveawayId}`;
      case "giveaway.reroll": return `giveaway.reroll ${step.giveawayId}`;
      default: return JSON.stringify(step);
    }
  };
  const componentSummary = workflow.components.map((component) => {
    if (component.kind === "modal") return `modal:${component.key} (${component.inputs.map((input) => `${input.key}:${input.label}${input.required ? " required" : ""}`).join(", ")})`;
    if (component.kind === "select") return `select:${component.key} (${component.options.length} options: ${component.options.slice(0, 5).map((option) => option.label).join(", ")}${component.options.length > 5 ? ", …" : ""})`;
    return `button:${component.key} ${component.label} [${component.style}]`;
  }).join("; ");
  const componentCounts = {
    buttons: workflow.components.filter((component) => component.kind === "button").length,
    selects: workflow.components.filter((component) => component.kind === "select").length,
    modals: workflow.components.filter((component) => component.kind === "modal").length,
  };
  const visibleButtons = componentCounts.buttons + componentCounts.modals;
  const triggerSummary = workflow.triggers.map((trigger) => {
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const timing = trigger.event === "schedule" ? ` every ${trigger.intervalSeconds}s`
      : trigger.event === "schedule.at" ? ` every ${weekdays[trigger.dayOfWeek]} ${String(trigger.hour).padStart(2, "0")}:${String(trigger.minute).padStart(2, "0")} ${trigger.timeZone}`
        : trigger.event === "deadline" ? ` after ${trigger.afterSeconds}s` : "";
    const voiceSource = "voiceChannelId" in trigger ? ` sourceVoice=${trigger.voiceChannelId}` : "";
    const steps = trigger.steps.map((step) => `${step.id}: ${effect(step)}${step.dependsOn.length ? ` after[${step.dependsOn.join(",")}]` : ""}${step.when ? ` when ${JSON.stringify(step.when)}` : ""}`).join(" → ");
    return `• ${trigger.event}${"componentKey" in trigger ? `(${trigger.componentKey})` : ""}${voiceSource}${timing}: ${steps}`;
  }).join("\n");
  const sideEffects = workflow.triggers.flatMap((trigger) => trigger.steps.flatMap((step) => {
    if (step.action === "message.send") return [`${step.delivery === "workflow_owner_dm" ? "DM: Workflow owner" : step.delivery === "workflow_channel_step" ? `Private-channel route via ${step.channelStepId}` : "Message: published channel"} (${step.id})`];
    if (step.action === "message.dm") return [`DM: ${step.recipient === "workflow_owner" ? "Workflow owner" : "trigger member"} (${step.id})`];
    if (["resource.channel.create_category", "resource.channel.create_text", "channel.create_text", "channel.create_voice"].includes(step.action)) return [`Channel create: ${step.action} ${"name" in step ? step.name : ""}${step.action === "channel.create_text" ? ` visibility=${step.visibility}` : ""} (${step.id})`];
    if (step.action === "resource.role.create") return [`Role create: ${step.name} (permissionless) (${step.id})`];
    if (["role.grant", "role.revoke", "role.rename"].includes(step.action)) return [`Role mutation: ${step.action} ${"roleName" in step ? step.roleName : ""} (${step.id})`];
    if (["channel.delete", "channel.delete_empty", "voice.channel.delete"].includes(step.action)) return [`Channel delete: ${step.action} (${step.id})`];
    if (step.action.startsWith("state.")) return [`Persistent State: ${step.action} ${"scope" in step && "key" in step ? `${step.scope}:${step.key}` : ""} (${step.id})`];
    if (step.action.startsWith("collection.") || step.action.startsWith("entry.")) return [`Persistent membership/data: ${step.action} (${step.id})`];
    if (step.action.startsWith("giveaway.")) return [`Giveaway state: ${step.action} (${step.id})`];
    if (step.action === "channel.move_member" || step.action === "channel.move_members") return [`Member movement: ${step.action} (${step.id})`];
    if (["channel.set_permission", "channel.rename"].includes(step.action)) return [`Channel mutation: ${step.action} (${step.id})`];
    if (step.action === "workflow.wait") return [`Persistent scheduled wait: ${step.seconds}s (${step.id})`];
    return [];
  }));
  const dmCount = workflow.triggers.flatMap((trigger) => trigger.steps).filter((step) => step.action === "message.dm" || step.action === "message.send" && step.delivery === "workflow_owner_dm").length;
  const channelCreates = workflow.triggers.flatMap((trigger) => trigger.steps).filter((step) => ["resource.channel.create_category", "resource.channel.create_text", "channel.create_text", "channel.create_voice"].includes(step.action)).length;
  const roleCreates = workflow.triggers.flatMap((trigger) => trigger.steps).filter((step) => step.action === "resource.role.create").length;
  return `${workflow.name}\nUI components: ${workflow.components.length} total (${visibleButtons} Discord buttons: ${componentCounts.buttons} regular + ${componentCounts.modals} Modal launchers; ${componentCounts.selects} Select menus; ${componentCounts.modals} Modal forms): ${componentSummary}\nResource counts: channels/categories created=${channelCreates}; Roles created=${roleCreates}; DMs sent=${dmCount === 0 ? "none" : dmCount}\nTriggers and conditions:\n${triggerSummary}\nSide effects from the compiled Workflow:\n${sideEffects.length ? sideEffects.map((item) => `• ${item}`).join("\n") : "• None beyond the listed UI/trigger behavior"}`;
}
