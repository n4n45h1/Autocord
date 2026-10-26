import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags,
  SectionBuilder, SeparatorBuilder, StringSelectMenuBuilder, TextDisplayBuilder,
  type MessageCreateOptions,
} from "discord.js";
import type { InteractiveWorkflow, WorkflowComponent } from "../../agent/interactive-workflow.js";
import { evaluateWorkflowCondition, renderWorkflowTemplate, type WorkflowConditionContext } from "./conditions.js";

const palette = { blue: 0x3498db, purple: 0x9b59b6, green: 0x2ecc71, red: 0xe74c3c, gray: 0x95a5a6 } as const;
export type WorkflowView = WorkflowConditionContext & { inputs?: Record<string, string>; selected?: readonly string[]; actorId?: string };

function disabled(component: WorkflowComponent, context: WorkflowView): boolean {
  return Boolean(component.disabledWhen && evaluateWorkflowCondition(component.disabledWhen, context));
}

export function renderInteractiveWorkflow(workflowId: string, spec: InteractiveWorkflow, context: WorkflowView): MessageCreateOptions {
  const container = new ContainerBuilder().setAccentColor(palette[spec.color]);
  const description = context.states["workflow:panel.description"];
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${spec.title}\n${renderWorkflowTemplate(typeof description === "string" ? description : spec.description, context)}`));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  for (const component of spec.components) {
    const isDisabled = disabled(component, context);
    if (component.kind === "select") {
      const menu = new StringSelectMenuBuilder().setCustomId(`iw:${workflowId}:${component.key}`).setPlaceholder(component.placeholder)
        .setMinValues(component.minValues).setMaxValues(component.maxValues).setDisabled(isDisabled)
        .addOptions(component.options.map((option) => ({ label: option.label, value: option.key, description: option.description ?? undefined, ...(option.emoji ? { emoji: option.emoji } : {}) })));
      container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
      continue;
    }
    const isModal = component.kind === "modal";
    const button = new ButtonBuilder().setCustomId(`${isModal ? "iwm" : "iw"}:${workflowId}:${component.key}`)
      .setLabel(component.label).setStyle(isModal ? ButtonStyle.Primary : ({ primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger } as const)[component.style])
      .setDisabled(isDisabled);
    if (component.kind === "button" && component.emoji) button.setEmoji(component.emoji);
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${component.label}**`)).setButtonAccessory(button));
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}
