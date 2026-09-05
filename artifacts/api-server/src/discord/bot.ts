import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from "discord.js";
import { and, asc, eq } from "drizzle-orm";
import { db, discordLicensesTable } from "@workspace/db";
import { logger } from "../lib/logger";

const DM_RATE_LIMIT_MS = 800;
const MAX_REPEAT = 100;

const commands = [
  new SlashCommandBuilder()
    .setName("dm")
    .setDescription("管理員對指定成員發送私訊")
    .setDMPermission(false)
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
  new SlashCommandBuilder()
    .setName("license")
    .setDescription("授權指定使用者")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription("使用者 ID")
        .setMinLength(17)
        .setMaxLength(20)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("授權備註，可選填")
        .setMaxLength(500)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("removelicense")
    .setDescription("移除指定使用者的授權")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription("使用者 ID")
        .setMinLength(17)
        .setMaxLength(20)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("licenselist")
    .setDescription("查看全部授權狀態清單")
    .setDMPermission(false),
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

async function clearCommands(
  applicationId: string,
  token: string,
  guildId?: string,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), { body: [] });
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: [],
    });
  }
  logger.info(
    { scope: guildId ? "global+guild" : "global" },
    "Discord worker slash commands cleared",
  );
}

function normalizeLogText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/@/g, "@​").trim().slice(0, 500);
}

async function sendDiscordLog(client: Client, message: string): Promise<void> {
  const channelId = process.env["DISCORD_LOG_CHANNEL_ID"]?.trim();
  if (!channelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      logger.warn("Discord log channel is not text-based");
      return;
    }

    const sendableChannel = channel as unknown as {
      send: (payload: {
        content: string;
        allowedMentions: { parse: string[] };
      }) => Promise<unknown>;
    };

    if (typeof sendableChannel.send !== "function") {
      logger.warn("Discord log channel cannot receive messages");
      return;
    }

    await sendableChannel.send({
      content: normalizeLogText(message),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.warn({ err: error }, "Discord log delivery failed");
  }
}

function isDiscordUserId(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

async function requireGuildOwner(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "此指令只能在伺服器中使用。",
      ephemeral: true,
    });
    return false;
  }

  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({
      content: "只有伺服器擁有者可以使用此指令。",
      ephemeral: true,
    });
    return false;
  }

  return true;
}

async function replyLicenseList(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const licenses = await db
    .select({
      userId: discordLicensesTable.userId,
      note: discordLicensesTable.note,
    })
    .from(discordLicensesTable)
    .where(eq(discordLicensesTable.guildId, guildId))
    .orderBy(asc(discordLicensesTable.userId));

  if (licenses.length === 0) {
    await interaction.reply("目前沒有任何授權資料。");
    return;
  }

  const lines = licenses.map(({ userId, note }) => {
    const normalizedNote = note?.replace(/\s+/g, " ").trim();
    return normalizedNote
      ? `ID: ${userId} | 狀態：已授權 | 備註：${normalizedNote}`
      : `ID: ${userId} | 狀態：已授權`;
  });

  const chunks: string[] = [];
  let current = `授權狀態清單（共 ${licenses.length} 筆）\n`;
  for (const line of lines) {
    if (current.length + line.length + 1 > 1900) {
      chunks.push(current.trimEnd());
      current = "";
    }
    current += `${line}\n`;
  }
  if (current.trim()) {
    chunks.push(current.trimEnd());
  }

  await interaction.reply(chunks[0] ?? "目前沒有任何授權資料。");
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(chunk);
  }
}

async function isLicensedUser(
  guildId: string,
  userId: string,
): Promise<boolean> {
  const [license] = await db
    .select({ id: discordLicensesTable.id })
    .from(discordLicensesTable)
    .where(
      and(
        eq(discordLicensesTable.guildId, guildId),
        eq(discordLicensesTable.userId, userId),
      ),
    )
    .limit(1);

  return Boolean(license);
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  sendDm: (
    userId: string,
    message: string,
    repeat: number,
  ) => Promise<number>,
  sendLog: (message: string) => Promise<void>,
): Promise<void> {
  if (interaction.commandName === "license") {
    if (!(await requireGuildOwner(interaction))) {
      return;
    }

    const guildId = interaction.guildId as string;
    const userId = interaction.options.getString("id", true).trim();
    const note = interaction.options.getString("note")?.trim() || null;

    if (!isDiscordUserId(userId)) {
      await interaction.reply({
        content: "使用者 ID 格式不正確。",
        ephemeral: true,
      });
      return;
    }

    await db
      .insert(discordLicensesTable)
      .values({ guildId, userId, note })
      .onConflictDoUpdate({
        target: [discordLicensesTable.guildId, discordLicensesTable.userId],
        set: { note, updatedAt: new Date() },
      });

    await interaction.reply(
      note
        ? `已授權使用者 ID：${userId}\n備註：${note}`
        : `已授權使用者 ID：${userId}`,
    );
    await sendLog(
      note
        ? `授權已新增或更新 | 使用者 ID：${userId} | 備註：${note}`
        : `授權已新增或更新 | 使用者 ID：${userId}`,
    );
    return;
  }

  if (interaction.commandName === "removelicense") {
    if (!(await requireGuildOwner(interaction))) {
      return;
    }

    const guildId = interaction.guildId as string;
    const userId = interaction.options.getString("id", true).trim();

    if (!isDiscordUserId(userId)) {
      await interaction.reply({
        content: "使用者 ID 格式不正確。",
        ephemeral: true,
      });
      return;
    }

    const deleted = await db
      .delete(discordLicensesTable)
      .where(
        and(
          eq(discordLicensesTable.guildId, guildId),
          eq(discordLicensesTable.userId, userId),
        ),
      )
      .returning({ id: discordLicensesTable.id });

    await interaction.reply(
      deleted.length > 0
        ? `已移除使用者 ID：${userId} 的授權。`
        : `找不到使用者 ID：${userId} 的授權資料。`,
    );
    await sendLog(
      deleted.length > 0
        ? `授權已移除 | 使用者 ID：${userId}`
        : `移除授權失敗：找不到資料 | 使用者 ID：${userId}`,
    );
    return;
  }

  if (interaction.commandName === "licenselist") {
    if (!(await requireGuildOwner(interaction))) {
      return;
    }

    await replyLicenseList(interaction, interaction.guildId as string);
    await sendLog(`授權清單已查詢 | 筆數：${(
      await db
        .select({ id: discordLicensesTable.id })
        .from(discordLicensesTable)
        .where(eq(discordLicensesTable.guildId, interaction.guildId as string))
    ).length}`);
    return;
  }

  if (interaction.commandName !== "dm") {
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      content: "此指令只能在伺服器中使用。",
      ephemeral: true,
    });
    return;
  }

  if (!(await isLicensedUser(interaction.guildId, interaction.user.id))) {
    await interaction.reply({
      content: "你尚未取得此伺服器的使用授權。",
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
    await sendLog(
      `私訊發送成功 | 每台機器人：${repeat} 次 | 機器人數量：${workerCount} | 總次數：${totalCount}`,
    );
  } catch (error) {
    logger.warn({ err: error }, "Discord DM delivery failed");
    await interaction.editReply(
      `無法完成每台機器人 ${repeat} 次的私訊任務。對方可能關閉了私人訊息，或機器人沒有權限傳送。`,
    );
    await sendLog(`私訊發送失敗 | 每台機器人：${repeat} 次`);
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
        try {
          await clearCommands(
            readyClient.application.id,
            token,
            process.env["DISCORD_GUILD_ID"],
          );
          logger.info("Discord worker bot is online");
        } catch (error) {
          logger.error(
            { err: error },
            "Discord worker slash command cleanup failed",
          );
        }
        return;
      }

      try {
        await registerCommands(
          readyClient.application.id,
          token,
          process.env["DISCORD_GUILD_ID"],
        );
        logger.info("Discord bot is online");
        await sendDiscordLog(readyClient, "主機器人已上線。");
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
        await handleCommand(
          interaction,
          dmDispatcher.send,
          (message) => sendDiscordLog(client, message),
        );
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
        await sendDiscordLog(client, "指令執行失敗。");
      }
    });

    client.login(token).catch((error) => {
      logger.error({ err: error }, "Discord bot login failed");
    });
  }
}