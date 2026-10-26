import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commands } from "./discord/commands.js";

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);
await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), { body: commands });
console.info("Application commands deployed");
