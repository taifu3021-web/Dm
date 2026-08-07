import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from "discord.js";
import { logger } from "../lib/logger";

const DM_RATE_LIMIT_MS = 800;

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("檢查機器人是否正常運作"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("查看機器人可用指令"),
  new SlashCommandBuilder()
    .setName("about")
    .setDescription("查看機器人資訊"),
  new SlashCommandBuilder()
    .setName("dm")
    .setDescription("管理員對指定成員發送私訊")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator.toString())
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("要接收私訊的成員")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("要發送的訊息，最多 2000 個字元")
        .setMaxLength(2000)
        .setRequired(true),
    ),
].map((command) => command.toJSON());

let client: Client | undefined;
let started = false;

function createDmQueue() {
  let queue: Promise<void> = Promise.resolve();

  return (member: User, message: string): Promise<void> => {
    const sendTask = queue.then(async () => {
      try {
        await member.send(message);
      } finally {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, DM_RATE_LIMIT_MS),
        );
      }
    });

    queue = sendTask.catch(() => undefined);
    return sendTask;
  };
}

async function registerCommands(applicationId: string, guildId?: string) {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);

  await rest.put(route, { body: commands });
  logger.info(
    { scope: guildId ? "guild" : "global", guildId },
    "Discord slash commands registered",
  );
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  sendDm: (member: User, message: string) => Promise<void>,
): Promise<void> {
  if (interaction.commandName === "ping") {
    await interaction.reply({
      content: `Pong！延遲 ${interaction.client.ws.ping}ms`,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "help") {
    await interaction.reply({
      content:
        "**可用指令**\n`/ping` — 檢查機器人狀態\n`/help` — 查看這份說明\n`/about` — 查看機器人資訊\n`/dm` — 管理員私訊指定成員",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "about") {
    await interaction.reply({
      content: "這是一個使用 discord.js 建立的 Discord 機器人。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName !== "dm") {
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "只有伺服器管理員可以使用這個指令。",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.options.getUser("member", true);
  const message = interaction.options.getString("message", true).trim();

  if (!message) {
    await interaction.reply({
      content: "訊息不能是空白。",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await sendDm(member, message);
    await interaction.editReply(`已成功私訊 ${member.tag}。`);
  } catch (error) {
    logger.warn({ err: error, userId: member.id }, "Discord DM delivery failed");
    await interaction.editReply(
      `無法私訊 ${member.tag}。對方可能關閉了私人訊息，或機器人沒有權限傳送。`,
    );
  }
}

export function startDiscordBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn(
      "DISCORD_BOT_TOKEN is not configured; Discord bot will remain offline",
    );
    return;
  }

  if (started) {
    return;
  }
  started = true;

  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const sendDm = createDmQueue();

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await registerCommands(
        readyClient.application.id,
        process.env["DISCORD_GUILD_ID"],
      );
      logger.info(
        { username: readyClient.user.tag },
        "Discord bot is online",
      );
    } catch (error) {
      logger.error({ err: error }, "Discord slash command registration failed");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      await handleCommand(interaction, sendDm);
    } catch (error) {
      logger.error(
        { err: error, command: interaction.commandName },
        "Discord command failed",
      );

      const response = {
        content: "指令執行時發生錯誤，請稍後再試。",
        ephemeral: true,
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(response);
      } else {
        await interaction.reply(response);
      }
    }
  });

  client.login(token).catch((error) => {
    started = false;
    logger.error({ err: error }, "Discord bot login failed");
  });
}