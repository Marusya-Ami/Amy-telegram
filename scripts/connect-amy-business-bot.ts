/**
 * One-time setup: sign in as the Amy user account and connect the existing
 * Secretary bot with account.updateConnectedBot.
 *
 * This is not the production message transport. It does not change the bot
 * webhook, Amy Brain, memory, continuity, follow-ups, or the scheduler.
 *
 * Session file: data/telegram-user.session (gitignored).
 * Remove it with: npm run connect-business-bot -- --delete-session
 * That only deletes the local file. It does not disconnect the bot.
 */
import { createInterface } from "node:readline/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";

import { Api, Logger, TelegramClient } from "teleproto";
import { LogLevel } from "teleproto/extensions/Logger";
import { StringSession } from "teleproto/sessions";

const SESSION_PATH = join(process.cwd(), "data", "telegram-user.session");
const SESSION_DISPLAY = "data/telegram-user.session";

const RETRYABLE_LOGIN = new Set([
  "PHONE_CODE_INVALID",
  "PHONE_CODE_EXPIRED",
  "PHONE_NUMBER_INVALID",
  "PASSWORD_HASH_INVALID",
]);

const RIGHT_LABELS: Array<[keyof Api.BusinessBotRights, string]> = [
  ["reply", "can_reply"],
  ["readMessages", "can_read_messages"],
  ["deleteSentMessages", "delete_sent_messages"],
  ["deleteReceivedMessages", "delete_received_messages"],
  ["editName", "edit_name"],
  ["editBio", "edit_bio"],
  ["editProfilePhoto", "edit_profile_photo"],
  ["editUsername", "edit_username"],
  ["viewGifts", "view_gifts"],
  ["sellGifts", "sell_gifts"],
  ["changeGiftSettings", "change_gift_settings"],
  ["transferAndUpgradeGifts", "transfer_and_upgrade_gifts"],
  ["transferStars", "transfer_stars"],
  ["manageStories", "manage_stories"],
];

function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return Promise.resolve();
  }
  if (process.argv.includes("--delete-session")) {
    deleteLocalSession();
    return Promise.resolve();
  }
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--");
  if (unknown.length > 0) {
    console.error("Unknown argument. Run with --help for usage.");
    process.exitCode = 1;
    return Promise.resolve();
  }
  return connectBusinessBot();
}

function printUsage(): void {
  console.log(`Usage:
  npm run connect-business-bot
  npm run connect-business-bot -- --delete-session

Reads TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_BUSINESS_BOT_USERNAME.
Does not use TELEGRAM_BOT_TOKEN.
--delete-session removes ${SESSION_DISPLAY} only. It does not disconnect the bot.`);
}

function deleteLocalSession(): void {
  if (!existsSync(SESSION_PATH)) {
    console.log(`No local session file at ${SESSION_DISPLAY}.`);
    console.log("The connected business bot was not changed.");
    return;
  }
  rmSync(SESSION_PATH);
  console.log(`Removed ${SESSION_DISPLAY}.`);
  console.log("The connected business bot was not disconnected.");
}

function loadEnvFile(): void {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = normalized.indexOf("=");
    if (eq < 1) continue;
    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(normalized.slice(eq + 1));
  }
}

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  const commentAt = trimmed.indexOf(" #");
  return (commentAt === -1 ? trimmed : trimmed.slice(0, commentAt)).trim();
}

function readConfig(): { apiId: number; apiHash: string; username: string } {
  loadEnvFile();
  const missing = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_BUSINESS_BOT_USERNAME"].filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Set them in .env. Do not use TELEGRAM_BOT_TOKEN for this script.`,
    );
  }
  const apiIdText = process.env.TELEGRAM_API_ID?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(apiIdText)) {
    throw new Error("TELEGRAM_API_ID must be a positive integer.");
  }
  const username = (process.env.TELEGRAM_BUSINESS_BOT_USERNAME ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
    throw new Error("TELEGRAM_BUSINESS_BOT_USERNAME must be a Telegram username, with or without @.");
  }
  return {
    apiId: Number(apiIdText),
    apiHash: process.env.TELEGRAM_API_HASH?.trim() ?? "",
    username,
  };
}

function readSessionFile(): string {
  if (!existsSync(SESSION_PATH)) return "";
  return readFileSync(SESSION_PATH, "utf8").trim();
}

function persistSession(session: StringSession): void {
  const serialized = session.save();
  if (!serialized) return;
  mkdirSync(dirname(SESSION_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_PATH, serialized, { encoding: "utf8", mode: 0o600 });
  chmodSync(SESSION_PATH, 0o600);
}

function publicError(error: unknown): string {
  let message = error instanceof Error ? error.message : "unknown error";
  const secrets = [process.env.TELEGRAM_API_HASH, process.env.TELEGRAM_API_ID].filter(
    (value): value is string => Boolean(value && value.length > 0),
  );
  for (const secret of secrets) {
    message = message.split(secret).join("[redacted]");
  }
  return message.replace(/\+?\d[\d\s()-]{6,}\d/g, "[redacted]");
}

function telegramErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error && "errorMessage" in error) {
    const code = (error as { errorMessage?: unknown }).errorMessage;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return undefined;
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Login cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char < " ") continue;
        value += char;
      }
    };
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
    };
    input.on("data", onData);
  });
}

async function connectBusinessBot(): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    console.error("Run this setup in an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  let client: TelegramClient | undefined;
  try {
    const config = readConfig();
    const session = new StringSession(readSessionFile());
    client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: 5,
      baseLogger: new Logger(LogLevel.NONE),
    });

    await client.start({
      phoneNumber: () => promptLine("Phone number: "),
      phoneCode: () => promptLine("Telegram login code: "),
      password: () => promptHidden("2FA password: "),
      onError: async (error: Error) => {
        const code = telegramErrorCode(error);
        if (code && RETRYABLE_LOGIN.has(code)) {
          console.error(`Telegram rejected that attempt (${code}). Try again.`);
          return false;
        }
        console.error(`Login failed: ${publicError(error)}`);
        return true;
      },
    });
    persistSession(session);

    const bot = await resolveBusinessBot(client, config.username);
    await client.invoke(
      new Api.account.UpdateConnectedBot({
        bot,
        rights: new Api.BusinessBotRights({
          reply: true,
          readMessages: true,
        }),
        recipients: new Api.InputBusinessBotRecipients({
          existingChats: true,
          newChats: true,
          contacts: true,
          nonContacts: true,
        }),
      }),
    );
    persistSession(session);

    const listed = await client.invoke(new Api.account.GetConnectedBots());
    const connected = printConfirmation(bot, config.username, listed);
    if (!connected) {
      console.error("connection failed");
      console.error("account.getConnectedBots did not list this bot.");
      process.exitCode = 1;
      return;
    }
    console.log("connection succeeded");
    console.log("");
    console.log(
      "Now send a message to Amy from another Telegram account. The existing bot webhook should receive a business_connection/business_message update.",
    );
    console.log("");
    console.log(`Temporary MTProto session: ${SESSION_DISPLAY}`);
    console.log("That file is gitignored. Deleting it does not disconnect the business bot.");
    console.log("Remove it with: npm run connect-business-bot -- --delete-session");
  } catch (error) {
    console.error("connection failed");
    console.error(publicError(error));
    if (existsSync(SESSION_PATH)) {
      console.error(`A local session file is at ${SESSION_DISPLAY}. It was not printed.`);
      console.error("Remove it with: npm run connect-business-bot -- --delete-session");
    }
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.disconnect().catch(() => undefined);
    }
  }
}

async function resolveBusinessBot(client: TelegramClient, username: string): Promise<Api.User> {
  const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username }));
  if (resolved.className !== "contacts.ResolvedPeer" || resolved.peer.className !== "PeerUser") {
    throw new Error("That username is not a private user. This connection does not include groups or channels.");
  }
  const peerId = resolved.peer.userId.toString();
  const bot = resolved.users.find(
    (user): user is Api.User => user.className === "User" && user.id.toString() === peerId,
  );
  if (!bot?.bot) {
    throw new Error("That username did not resolve to a bot.");
  }
  const names = usernamesOf(bot);
  if (names.length > 0 && !names.includes(username.toLowerCase())) {
    throw new Error("The resolved bot username did not match TELEGRAM_BUSINESS_BOT_USERNAME.");
  }
  if (!bot.botBusiness) {
    throw new Error(
      "The resolved user does not have the bot_business capability. Enable Secretary Mode in BotFather, then run this again.",
    );
  }
  if (bot.accessHash == null) {
    throw new Error("Telegram did not return an access hash for the bot.");
  }
  return bot;
}

function usernamesOf(user: Api.User): string[] {
  const names = [user.username, ...(user.usernames?.map((entry) => entry.username) ?? [])];
  return names.filter((name): name is string => Boolean(name)).map((name) => name.toLowerCase());
}

function printConfirmation(
  bot: Api.User,
  requestedUsername: string,
  listed: Api.account.TypeConnectedBots,
): boolean {
  if (listed.className !== "account.ConnectedBots") return false;
  const botId = bot.id.toString();
  const connection = listed.connectedBots.find(
    (item) => item.className === "ConnectedBot" && item.botId.toString() === botId,
  );
  const listedUser = listed.users.find(
    (user): user is Api.User => user.className === "User" && user.id.toString() === botId,
  );
  const username = listedUser?.username ?? bot.username ?? requestedUsername;
  const connected = Boolean(connection);
  console.log("CONNECTED BUSINESS BOT");
  console.log(`Bot: @${username} (id ${botId})`);
  console.log(`Connected: ${connected ? "true" : "false"}`);
  console.log(`Recipients: ${connection ? describeRecipients(connection.recipients) : "(not listed)"}`);
  console.log(`Rights: ${connection ? describeRights(connection.rights) : "(not listed)"}`);
  return connected;
}

function describeRecipients(recipients: Api.TypeBusinessBotRecipients): string {
  if (recipients.className !== "BusinessBotRecipients") return "unavailable";
  const parts: string[] = [];
  if (recipients.existingChats) parts.push("existing_chats");
  if (recipients.newChats) parts.push("new_chats");
  if (recipients.contacts) parts.push("contacts");
  if (recipients.nonContacts) parts.push("non_contacts");
  if (recipients.excludeSelected) parts.push("exclude_selected");
  if (recipients.users?.length) parts.push(`selected_users=${recipients.users.length}`);
  if (recipients.excludeUsers?.length) parts.push(`exclude_users=${recipients.excludeUsers.length}`);
  parts.push("private_chats_only");
  return parts.join(", ");
}

function describeRights(rights: Api.TypeBusinessBotRights): string {
  if (rights.className !== "BusinessBotRights") return "unavailable";
  const enabled = RIGHT_LABELS.filter(([key]) => rights[key] === true).map(([, label]) => label);
  return enabled.length > 0 ? enabled.join(", ") : "(none)";
}

void main();
