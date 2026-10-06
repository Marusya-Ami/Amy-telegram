import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { MEDIA_ANALYSIS_PROMPT, MediaAnalysisError } from "@/services/media/analyze";
import {
  addedText,
  classifyOwnerBotUpdate,
  processOwnerBotAdminUpdate,
  readFreePhoto,
  type MediaLibraryDeps,
} from "@/services/media/library";
import { parseMediaAnalysis } from "@/services/media/schema";
import { prisma } from "@/lib/db/prisma";

test("admin upload requires the configured numeric owner id", () => {
  const update = photoUpdate("42", "file-a", "unique-a");
  assert.equal(classifyOwnerBotUpdate(update, ""), null);
  assert.equal(classifyOwnerBotUpdate(update, "42")?.type, "photo");
  assert.equal(classifyOwnerBotUpdate({ ...update, message: { ...update.message!, from: { id: 42, username: "owner" } } }, "99"), null);
  assert.equal(classifyOwnerBotUpdate(businessPhoto("42", "file-a", "unique-a"), "42"), null);
});

test("commands are recognized only as exact owner bot commands", () => {
  assert.equal(classifyOwnerBotUpdate(textUpdate("7", "/media@amytalkingbot"), "7")?.type, "media");
  assert.equal(classifyOwnerBotUpdate(textUpdate("7", "/delete_last confirm"), "7")?.type, "delete_last_confirm");
  assert.equal(classifyOwnerBotUpdate(textUpdate("7", "/delete_last later"), "7"), null);
  assert.equal(classifyOwnerBotUpdate(textUpdate("8", "/media"), "7"), null);
});

test("analysis metadata keeps retrieval detail and drops generic vision labels", () => {
  const parsed = parseMediaAnalysis({
    category: "Home",
    description: "Amy taking a relaxed selfie at home in light pajamas, sitting in the living room and smiling at the camera.",
    tags: ["Woman", "photo", "lighting", "indoor", "person", "light pajamas", "living room", "sitting", "sitting"],
    mood: "Relaxed",
    flirtLevel: 1,
    peopleCount: 1,
    hasAmy: true,
    hasLuna: false,
    contexts: ["at home", "relaxing", "casual-selfie"],
  });
  assert.equal(parsed.category, "home");
  assert.deepEqual(parsed.tags, ["light_pajamas", "living_room", "sitting"]);
  assert.equal(parsed.mood, "relaxed");
  assert.deepEqual(parsed.contexts, ["at_home", "relaxing", "casual_selfie"]);
  assert.throws(() =>
    parseMediaAnalysis({
      ...parsed,
      description: "A young woman takes a selfie in a cozy indoor setting.",
      tags: ["woman", "selfie", "indoor", "lighting"],
    }),
  );
  assert.throws(() => parseMediaAnalysis({ ...parsed, flirtLevel: 6 }));
  assert.throws(() => parseMediaAnalysis({ ...parsed, category: "secret" }));
  assert.match(MEDIA_ANALYSIS_PROMPT, /Do not name any other person/);
  assert.match(MEDIA_ANALYSIS_PROMPT, /Do not invent/);
  assert.match(MEDIA_ANALYSIS_PROMPT, /library context, not facial identification/);
  assert.match(MEDIA_ANALYSIS_PROMPT, /time of day only when the image supports it/);
});

test("the largest photo size is stored once and a repeat file is not imported again", async () => {
  const owner = uniqueId();
  const fileUniqueId = `uniq-${owner}`;
  let downloads = 0;
  const sent: string[] = [];
  const deps = fakeDeps(owner, sent, {
    download: async () => {
      downloads += 1;
      return { bytes: Buffer.from("high-quality"), extension: ".jpg", mimeType: "image/jpeg" };
    },
  });

  try {
    await processOwnerBotAdminUpdate(photoUpdate(owner, "small-id", fileUniqueId, [{ file_id: "small-id", file_unique_id: "small-unique", file_size: 10 }, { file_id: "large-id", file_unique_id: fileUniqueId, file_size: 500 }]), deps);
    await processOwnerBotAdminUpdate(photoUpdate(owner, "large-id", fileUniqueId), deps);
    const assets = await prisma.mediaAsset.findMany({ where: { telegramFileUniqueId: fileUniqueId } });
    assert.equal(assets.length, 1);
    assert.equal(assets[0]?.telegramFileId, "large-id");
    assert.equal(assets[0]?.storagePath.startsWith("free/"), true);
    assert.equal(assets[0]?.storagePath.includes("telegram"), false);
    assert.equal(downloads, 1);
    assert.match(sent[0] ?? "", /Added to Amy Library/);
    assert.match(sent[0] ?? "", new RegExp(`ID: ${assets[0]?.id}`));
    assert.match(sent[1] ?? "", /Already in Amy Library/);
  } finally {
    await prisma.mediaAsset.deleteMany({ where: { telegramFileUniqueId: fileUniqueId } });
  }
});

test("failed analysis does not create library metadata", async () => {
  const owner = uniqueId();
  const fileUniqueId = `fail-${owner}`;
  const removed: string[] = [];
  const sent: string[] = [];
  try {
    await processOwnerBotAdminUpdate(photoUpdate(owner, "file", fileUniqueId), fakeDeps(owner, sent, {
      analyze: async () => {
        throw new MediaAnalysisError();
      },
      removePhoto: async (relativePath) => {
        removed.push(relativePath);
      },
    }));
    assert.equal(await prisma.mediaAsset.count({ where: { telegramFileUniqueId: fileUniqueId } }), 0);
    assert.equal(removed.length, 1);
    assert.match(sent[0] ?? "", /Analysis failed/);
  } finally {
    await prisma.mediaAsset.deleteMany({ where: { telegramFileUniqueId: fileUniqueId } });
  }
});

test("media commands count, show, and soft-delete only the latest active photo", async () => {
  const owner = uniqueId();
  const firstId = `cmd-a-${owner}`;
  const secondId = `cmd-b-${owner}`;
  const sent: string[] = [];
  const now = new Date("2026-09-25T00:00:00Z");
  const deps = fakeDeps(owner, sent, { now: () => now });
  try {
    await processOwnerBotAdminUpdate(photoUpdate(owner, "a", firstId), deps);
    await processOwnerBotAdminUpdate(photoUpdate(owner, "b", secondId), deps);
    sent.length = 0;
    await processOwnerBotAdminUpdate(textUpdate(owner, "/media"), deps);
    await processOwnerBotAdminUpdate(textUpdate(owner, "/last"), deps);
    await processOwnerBotAdminUpdate(textUpdate(owner, "/delete_last"), deps);
    await processOwnerBotAdminUpdate(textUpdate(owner, "/delete_last confirm"), deps);
    const second = await prisma.mediaAsset.findUniqueOrThrow({ where: { telegramFileUniqueId: secondId } });
    const first = await prisma.mediaAsset.findUniqueOrThrow({ where: { telegramFileUniqueId: firstId } });
    assert.equal(second.active, false);
    assert.equal(first.active, true);
    assert.match(sent[0] ?? "", /home: 2/);
    assert.match(sent[1] ?? "", new RegExp(`ID: ${second.id}`));
    assert.match(sent[3] ?? "", /Deactivated/);
    assert.match(addedText(second), /Flirt: 1\/5/);
  } finally {
    await prisma.mediaAsset.deleteMany({ where: { telegramFileUniqueId: { in: [firstId, secondId] } } });
  }
});

function fakeDeps(owner: string, sent: string[], overrides: Partial<MediaLibraryDeps> = {}): MediaLibraryDeps {
  return {
    ownerTelegramId: owner,
    download: async () => ({ bytes: Buffer.from("img"), extension: ".jpg", mimeType: "image/jpeg" }),
    analyze: async () => ({
      category: "home",
      description: "A person sitting on a couch.",
      tags: ["selfie", "couch"],
      mood: "relaxed",
      flirtLevel: 1,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["at home"],
    }),
    send: async (_chatId, text) => {
      sent.push(text);
    },
    writePhoto: async () => undefined,
    removePhoto: async () => undefined,
    now: () => new Date(),
    ...overrides,
  };
}

function photoUpdate(
  owner: string,
  fileId: string,
  fileUniqueId: string,
  photo?: TelegramUpdate["message"] extends infer _T ? NonNullable<TelegramUpdate["message"]>["photo"] : never,
): TelegramUpdate {
  const id = Number(owner);
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id, type: "private" },
      from: { id, is_bot: false, username: "not-used" },
      photo: photo ?? [{ file_id: fileId, file_unique_id: fileUniqueId, file_size: 100 }],
    },
  };
}

test("paid storage can be read and paths outside the library are refused", async () => {
  await assert.rejects(() => readFreePhoto("../secret"), /outside media storage/);
  await assert.rejects(() => readFreePhoto("other/photo.jpeg"), /outside media library/);
  assert.equal(await readFreePhoto("paid/missing-pack/01.jpeg"), null);
});

function businessPhoto(owner: string, fileId: string, fileUniqueId: string): TelegramUpdate {
  const update = photoUpdate(owner, fileId, fileUniqueId);
  return {
    update_id: Number(owner),
    business_message: { ...update.message!, business_connection_id: "conn" },
  };
}

function textUpdate(owner: string, text: string): TelegramUpdate {
  const id = Number(owner);
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      chat: { id, type: "private" },
      from: { id, is_bot: false },
    },
  };
}

function uniqueId(): string {
  return String(7_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
}
