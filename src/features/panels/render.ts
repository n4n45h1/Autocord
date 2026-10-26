import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder,
  MessageFlags, SectionBuilder, SeparatorBuilder, StringSelectMenuBuilder,
  TextDisplayBuilder, type MessageCreateOptions,
} from "discord.js";
import type { PanelPlan } from "../../agent/plan.js";

const panelColors = { blue: 0x3498db, purple: 0x9b59b6, green: 0x2ecc71, red: 0xe74c3c, gray: 0x95a5a6 } as const;

function selectMenu(plan: PanelPlan, panelId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`rolepanel:${panelId}`).setPlaceholder("付与するロールを選択")
    .setMinValues(0).setMaxValues(plan.selectionMode === "single" ? 1 : Math.max(1, plan.options.length))
    .addOptions(plan.options.map((option) => ({ label: option.label, value: option.key, description: option.roleName.slice(0, 100), ...(option.emoji ? { emoji: option.emoji } : {}) }))));
}

function renderV2(plan: PanelPlan, panelId: string): MessageCreateOptions {
  const container = new ContainerBuilder().setAccentColor(panelColors[plan.color]);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${plan.title}\n${plan.description || "ロールを選択してください。"}`));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

  if (plan.componentStyle === "select") {
    const lines = plan.options.map((option, index) => `${option.emoji ? `${option.emoji} ` : ""}**${index + 1}. ${option.label.slice(0, 60)}** · ${option.roleName.slice(0, 60)}`);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
    container.addActionRowComponents(selectMenu(plan, panelId));
  } else {
    for (const option of plan.options) {
      const button = new ButtonBuilder().setCustomId(`rolebutton:${panelId}:${option.key}`).setLabel(option.label).setStyle(ButtonStyle.Secondary);
      if (option.emoji) button.setEmoji(option.emoji);
      container.addSectionComponents(new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${option.label}**\n${option.roleName}`))
        .setButtonAccessory(button));
    }
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

function renderClassic(plan: PanelPlan, panelId: string): MessageCreateOptions {
  const embed = new EmbedBuilder().setColor(panelColors[plan.color]).setTitle(plan.title).setDescription(plan.description || "ロールを選択してください。");
  const components = plan.componentStyle === "select"
    ? [selectMenu(plan, panelId)]
    : plan.options.map((option) => {
      const button = new ButtonBuilder().setCustomId(`rolebutton:${panelId}:${option.key}`).setLabel(option.label).setStyle(ButtonStyle.Secondary);
      if (option.emoji) button.setEmoji(option.emoji);
      return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
    });
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

export function renderPanel(plan: PanelPlan, panelId: string): MessageCreateOptions {
  return plan.renderMode === "components_v2" ? renderV2(plan, panelId) : renderClassic(plan, panelId);
}
