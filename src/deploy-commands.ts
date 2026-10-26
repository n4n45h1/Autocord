import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder().setName("agent").setDescription("日本語でロールパネルを作成・編集").addStringOption((option) => option.setName("指示").setDescription("例: ゲームロールのパネルを作って").setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName("autocord").setDescription("Autocordの管理コマンド").addSubcommand((sub) => sub.setName("panels").setDescription("このサーバーのパネル一覧")),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);
await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands });
console.info("Application commands deployed");
