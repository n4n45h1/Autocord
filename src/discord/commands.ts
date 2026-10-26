import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder().setName("agent").setDescription("Agentcordに日本語で依頼")
    .addStringOption((o) => o.setName("指示").setDescription("ロールパネル作成・編集の依頼").setMaxLength(1500).setRequired(true))
    .addStringOption((o) => o.setName("mode").setDescription("Agentcordの処理モード").addChoices({ name: "Mini", value: "mini" }, { name: "Max", value: "max" })),
  new SlashCommandBuilder().setName("autocord").setDescription("Autocord管理")
    .addSubcommand((s) => s.setName("panels").setDescription("このサーバーのパネル一覧"))
    .addSubcommand((s) => s.setName("roles").setDescription("Autocord管理ロールの一覧"))
    .addSubcommand((s) => s.setName("channels").setDescription("発行可能なチャンネル一覧"))
    .addSubcommand((s) => s.setName("usage").setDescription("今月のAI利用量"))
    .addSubcommand((s) => s.setName("settings").setDescription("このサーバーの利用上限を表示・設定")
      .addIntegerOption((o) => o.setName("mini_monthly").setDescription("Miniの月間上限（サービス上限以下）").setMinValue(0).setMaxValue(1000))
      .addIntegerOption((o) => o.setName("max_monthly").setDescription("Maxの月間上限（サービス上限以下）").setMinValue(0).setMaxValue(1000)))
    .addSubcommand((s) => s.setName("history").setDescription("直近の操作履歴"))
    .addSubcommand((s) => s.setName("undo").setDescription("対応可能な直近変更を元に戻す").addStringOption((o) => o.setName("job_id").setDescription("元に戻す操作のジョブID").setRequired(true))),
  new SlashCommandBuilder().setName("giveaway").setDescription("配布企画を管理")
    .addSubcommand((s) => s.setName("create").setDescription("配布企画を開始")
      .addStringOption((o) => o.setName("prize").setDescription("賞品名").setRequired(true).setMaxLength(100))
      .addIntegerOption((o) => o.setName("minutes").setDescription("開催時間（分）").setRequired(true).setMinValue(1).setMaxValue(10080))
      .addIntegerOption((o) => o.setName("winners").setDescription("当選人数").setRequired(true).setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) => s.setName("end").setDescription("企画を終了して抽選")
      .addStringOption((o) => o.setName("giveaway_id").setDescription("企画ID").setRequired(true)))
    .addSubcommand((s) => s.setName("reroll").setDescription("完了済み企画を再抽選")
      .addStringOption((o) => o.setName("giveaway_id").setDescription("企画ID").setRequired(true)))
    .addSubcommand((s) => s.setName("pause").setDescription("開催中の企画を一時停止")
      .addStringOption((o) => o.setName("giveaway_id").setDescription("企画ID").setRequired(true)))
    .addSubcommand((s) => s.setName("resume").setDescription("一時停止中の企画を再開")
      .addStringOption((o) => o.setName("giveaway_id").setDescription("企画ID").setRequired(true))),
].map((command) => command.toJSON());
