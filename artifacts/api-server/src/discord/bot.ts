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
const MAX_REPEAT = 100;

const commands = [
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
    )
    .addIntegerOption((option) =>
      option
        .setName("repeat")
        .setDescription(`重複發送次數，最多 ${MAX_REPEAT} 次`)
        .setMinValue(1)
        .setMaxValue(MAX_REPEAT)
        .setRequired(false),
    ),
].map((command) => command.toJSON());

type DmWorker = {
  client: Client;
  online: boolean;
  pending: number;
  enqueue: (userId: string, message: string) => Promise<void>;
};

function createDmWorker(client: Client): DmWorker {
  let queue: Promise<void> = Promise.resolve();

  return {
    client,
    online: false,
    pending: 0,
    enqueue: (userId: string, message: string): Promise<void> => {
      const sendTask = queue.then(async () => {
        try {
          const member = await client.users.fetch(userId);
          await member.send(message);
        } finally {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, DM_RATE_LIMIT_MS),
          );
        }
      });

      queue = sendTask.catch(() => undefined);
      return sendTask;
    },
  };
}

function createDmDispatcher() {
  const workers: DmWorker[] = [];

  return {
    addWorker(worker: DmWorker): void {
      workers.push(worker);
    },
    send: async (
      userId: string,
      message: string,
      repeat: number,
    ): Promise<number> => {
      const onlineWorkers = workers.filter((worker) => worker.online);
      if (onlineWorkers.length === 0) {
        throw new Error("No Discord DM workers are online");
      }
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
        throw new Error(`repeat must be between 1 and ${MAX_REPEAT}`);
      }

      const tasks: Promise<void>[] = [];
      for (const worker of onlineWorkers) {
        for (let index = 0; index < repeat; index += 1) {
          worker.pending += 1;
          const task = worker.enqueue(userId, message).finally(() => {
            worker.pending -= 1;
          });
          tasks.push(task);
        }
      }

      await Promise.all(tasks);
      return onlineWorkers.length;
    },
  };
}

let started = false;

async function registerCommands(
  applicationId: string,
  token: string,
  guildId?: string,
) {
  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);

  await rest.put(route, { body: commands });
  logger.info(
    { scope: guildId ? "guild" : "global" },
    "Discord slash commands registered",
  );
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  sendDm: (
    userId: string,
    message: string,
    repeat: number,
  ) => Promise<number>,
): Promise<void> {
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
  const repeat = interaction.options.getInteger("repeat") ?? 1;

  if (!message) {
    await interaction.reply({
      content: "訊息不能是空白。",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const workerCount = await sendDm(member.id, message, repeat);
    const totalCount = workerCount * repeat;
    await interaction.editReply(
      `已由 ${workerCount} 台機器人各發送 ${repeat} 次，共 ${totalCount} 次。每台機器人每次發送間隔 0.8 秒。`,
    );
  } catch (error) {
    logger.warn({ err: error }, "Discord DM delivery failed");
    await interaction.editReply(
      `無法完成每台機器人 ${repeat} 次的私訊任務。對方可能關閉了私人訊息，或機器人沒有權限傳送。`,
    );
  }
}

export function startDiscordBot(): void {
  const configuredTokens =
    process.env["WORKER_BOT_TOKENS"] ?? process.env["DISCORD_BOT_TOKEN"] ?? "";
  const tokens = configuredTokens
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    logger.warn(
      "WORKER_BOT_TOKENS is not configured; Discord bots will remain offline",
    );
    return;
  }

  if (started) {
    return;
  }
  started = true;

  const dmDispatcher = createDmDispatcher();

  for (const [index, token] of tokens.entries()) {
    const isMainBot = index === 0;
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    const worker = createDmWorker(client);
    dmDispatcher.addWorker(worker);

    client.once(Events.ClientReady, async (readyClient) => {
      worker.online = true;

      if (!isMainBot) {
        logger.info("Discord worker bot is online");
        return;
      }

      try {
        await registerCommands(
          readyClient.application.id,
          token,
          process.env["DISCORD_GUILD_ID"],
        );
        logger.info("Discord bot is online");
      } catch (error) {
        logger.error(
          { err: error },
          "Discord slash command registration failed",
        );
      }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!isMainBot) {
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      try {
        await handleCommand(interaction, dmDispatcher.send);
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
      logger.error({ err: error }, "Discord bot login failed");
    });
  }
}