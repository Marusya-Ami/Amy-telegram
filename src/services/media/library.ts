import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaAsset } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sendTextMessage } from "@/lib/telegram/client";
import type { TelegramPhotoSize, TelegramUpdate } from "@/lib/telegram/types";
import { MediaAnalysisError, analyzeFreePhoto } from "@/services/media/analyze";
import type { MediaAnalysis } from "@/services/media/schema";
import { downloadTelegramFile, type DownloadedTelegramFile } from "@/services/media/telegramFile";

const CONFIRM_WINDOW_MS = 15 * 60 * 1000;

export type OwnerBotAction =
  | { type: "photo"; chatId: string; fileId: string; fileUniqueId: string; caption: string | null }
  | { type: "media" | "last" | "delete_last" | "delete_last_confirm"; chatId: string };

export type MediaLibraryDeps = {
  ownerTelegramId: string;
  download: (fileId: string) => Promise<DownloadedTelegramFile>;
  analyze: (bytes: Buffer, mimeType: string) => Promise<MediaAnalysis>;
  send: (chatId: string, text: string) => Promise<void>;
  writePhoto: (relativePath: string, bytes: Buffer) => Promise<void>;
  removePhoto: (relativePath: string) => Promise<void>;
  now: () => Date;
};

export function classifyOwnerBotUpdate(update: TelegramUpdate, ownerTelegramId: string): OwnerBotAction | null {
  const owner = ownerTelegramId.trim();
  if (!owner) return null;
  const message = update.message;
  if (!message?.from || message.from.is_bot) return null;
  if (message.chat?.type !== "private") return null;
  if (message.business_connection_id) return null;
  if (String(message.from.id) !== owner) return null;

  const photo = largestPhoto(message.photo);
  if (photo) {
    return {
      type: "photo",
      chatId: String(message.chat.id),
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      caption: noteFromCaption(message.caption),
    };
  }

  const command = adminCommand(typeof message.text === "string" ? message.text : "");
  if (!command) return null;
  return { type: command, chatId: String(message.chat.id) };
}

export function isOwnerBotAdminUpdate(update: TelegramUpdate, ownerTelegramId: string): boolean {
  return classifyOwnerBotUpdate(update, ownerTelegramId) !== null;
}

export async function processOwnerBotAdminUpdate(
  update: TelegramUpdate,
  deps: MediaLibraryDeps = defaultDeps(),
): Promise<void> {
  const action = classifyOwnerBotUpdate(update, deps.ownerTelegramId);
  if (!action) return;

  if (action.type === "photo") {
    await importOwnerPhoto(action, deps);
    return;
  }
  if (action.type === "media") {
    await deps.send(action.chatId, await mediaSummary());
    return;
  }
  if (action.type === "last") {
    await deps.send(action.chatId, await lastAssetText());
    return;
  }
  if (action.type === "delete_last") {
    await deps.send(action.chatId, await requestDeleteLast(deps.now()));
    return;
  }
  await deps.send(action.chatId, await confirmDeleteLast(deps.now()));
}

async function importOwnerPhoto(
  action: Extract<OwnerBotAction, { type: "photo" }>,
  deps: MediaLibraryDeps,
): Promise<void> {
  const existing = await prisma.mediaAsset.findUnique({
    where: { telegramFileUniqueId: action.fileUniqueId },
  });
  if (existing) {
    await deps.send(action.chatId, alreadyText(existing));
    logger.info("media.duplicate", { assetId: existing.id });
    return;
  }

  const downloaded = await deps.download(action.fileId);
  const relativePath = path.posix.join("free", `${randomBytes(16).toString("hex")}${downloaded.extension}`);
  await deps.writePhoto(relativePath, downloaded.bytes);

  let analysis: MediaAnalysis;
  try {
    analysis = await deps.analyze(downloaded.bytes, downloaded.mimeType);
  } catch (error) {
    await deps.removePhoto(relativePath);
    if (error instanceof MediaAnalysisError) {
      await deps.send(action.chatId, "Analysis failed. The photo was not added. Send it again when you want me to retry.");
      return;
    }
    throw error;
  }

  try {
    const asset = await prisma.mediaAsset.create({
      data: {
        telegramFileId: action.fileId,
        telegramFileUniqueId: action.fileUniqueId,
        storagePath: relativePath,
        mediaType: "PHOTO",
        category: analysis.category,
        description: analysis.description,
        tags: analysis.tags,
        mood: analysis.mood,
        flirtLevel: analysis.flirtLevel,
        peopleCount: analysis.peopleCount,
        hasAmy: analysis.hasAmy,
        hasLuna: analysis.hasLuna,
        contexts: analysis.contexts,
        notes: action.caption,
      },
    });
    await deps.send(action.chatId, addedText(asset));
    logger.info("media.imported", { assetId: asset.id, category: asset.category });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await deps.removePhoto(relativePath);
      throw error;
    }
    await deps.removePhoto(relativePath);
    const duplicate = await prisma.mediaAsset.findUnique({ where: { telegramFileUniqueId: action.fileUniqueId } });
    if (duplicate) await deps.send(action.chatId, alreadyText(duplicate));
  }
}

export function addedText(asset: Pick<MediaAsset, "id" | "category" | "tags" | "mood" | "flirtLevel" | "description">): string {
  return [
    "✅ Added to Amy Library",
    "",
    `ID: ${asset.id}`,
    `Category: ${asset.category}`,
    `Tags: ${asset.tags.join(", ") || "none"}`,
    `Mood: ${asset.mood}`,
    `Flirt: ${asset.flirtLevel}/5`,
    `Description: ${asset.description}`,
  ].join("\n");
}

function alreadyText(asset: Pick<MediaAsset, "id">): string {
  return `Already in Amy Library\n\nID: ${asset.id}`;
}

async function mediaSummary(): Promise<string> {
  const grouped = await prisma.mediaAsset.groupBy({
    by: ["category"],
    where: { active: true, mediaType: "PHOTO" },
    _count: { _all: true },
  });
  const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
  const lines = [`Amy Library`, ``, `Active photos: ${total}`];
  for (const row of grouped.sort((a, b) => a.category.localeCompare(b.category))) {
    lines.push(`${row.category}: ${row._count._all}`);
  }
  return lines.join("\n");
}

async function lastAssetText(): Promise<string> {
  const asset = await prisma.mediaAsset.findFirst({ orderBy: { createdAt: "desc" } });
  if (!asset) return "The library is empty.";
  return [
    "Latest upload",
    "",
    `ID: ${asset.id}`,
    `Category: ${asset.category}`,
    `Tags: ${asset.tags.join(", ") || "none"}`,
    `Mood: ${asset.mood}`,
    `Flirt: ${asset.flirtLevel}/5`,
    `Description: ${asset.description}`,
    `Active: ${asset.active ? "yes" : "no"}`,
  ].join("\n");
}

async function requestDeleteLast(now: Date): Promise<string> {
  const asset = await prisma.mediaAsset.findFirst({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  if (!asset) return "The library is empty.";
  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { deactivationRequestedAt: now },
  });
  return `This deactivates the latest upload (ID: ${asset.id}). Send /delete_last confirm if you mean it.`;
}

async function confirmDeleteLast(now: Date): Promise<string> {
  const asset = await prisma.mediaAsset.findFirst({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  const requested = asset?.deactivationRequestedAt?.getTime() ?? 0;
  if (!asset || now.getTime() - requested > CONFIRM_WINDOW_MS) return "Send /delete_last first.";
  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { active: false, deactivationRequestedAt: null },
  });
  return `Deactivated\n\nID: ${asset.id}`;
}

function defaultDeps(): MediaLibraryDeps {
  return {
    ownerTelegramId: getEnv().OWNER_TELEGRAM_ID,
    download: downloadTelegramFile,
    analyze: analyzeFreePhoto,
    send: async (chatId, text) => {
      await sendTextMessage(chatId, text);
    },
    writePhoto: writeFreePhoto,
    removePhoto: removeFreePhoto,
    now: () => new Date(),
  };
}

export async function writeFreePhoto(relativePath: string, bytes: Buffer): Promise<void> {
  const destination = resolveFreePath(relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: 0o640 });
}

export async function removeFreePhoto(relativePath: string): Promise<void> {
  await rm(resolveFreePath(relativePath), { force: true });
}

export async function readFreePhoto(relativePath: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveFreePath(relativePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function resolveFreePath(relativePath: string): string {
  const root = path.resolve(getEnv().MEDIA_STORAGE_PATH);
  const destination = path.resolve(root, relativePath);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refused to write outside media storage");
  }
  if (!relativePath.startsWith("free/") && !relativePath.startsWith("paid/")) {
    throw new Error("Refused to write outside media library");
  }
  return destination;
}

function largestPhoto(photo: TelegramPhotoSize[] | undefined): TelegramPhotoSize | null {
  if (!Array.isArray(photo)) return null;
  const sizes = photo.filter(
    (size) => size && typeof size.file_id === "string" && typeof size.file_unique_id === "string",
  );
  if (sizes.length === 0) return null;
  return [...sizes].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

function rank(size: TelegramPhotoSize): number {
  if (typeof size.file_size === "number") return size.file_size;
  return (size.width ?? 0) * (size.height ?? 0);
}

function adminCommand(text: string): "media" | "last" | "delete_last" | "delete_last_confirm" | null {
  const parts = text.trim().split(/\s+/);
  const token = parts[0]?.split("@")[0]?.toLowerCase();
  const rest = parts.slice(1).join(" ").toLowerCase();
  if (token === "/media" && rest === "") return "media";
  if (token === "/last" && rest === "") return "last";
  if (token === "/delete_last" && rest === "") return "delete_last";
  if (token === "/delete_last" && rest === "confirm") return "delete_last_confirm";
  return null;
}

function noteFromCaption(caption: string | undefined): string | null {
  const note = caption?.trim() ?? "";
  if (!note) return null;
  return note.slice(0, 500);
}
