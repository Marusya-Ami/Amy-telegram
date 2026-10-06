import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { classifyMediaSentCommand, deliverMediaThenRecord, formatMediaSentHistory, mediaSentLabel, recordSuccessfulMediaDelivery } from "@/services/media/delivery";
import { decideSales, selectFreeMedia, type MediaCandidate } from "@/services/sales/decide";
import { readSalesSignal } from "@/services/sales/signals";

const NOW = new Date("2026-09-28T19:32:00.000Z");

test("shadow FREE_MEDIA does not record a delivery or start cooldown", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, relationshipStage: "ENGAGED" } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram-business", platformConversationId: telegramUserId, businessConnectionId: "conn-media-shadow" },
  });
  const asset = await createAsset(prisma, "shadow");
  try {
    await observeSalesTurn(turn(user.id, conversation.id, ["send me a pic"]), { mode: "shadow", now: NOW });
    const decision = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(decision.decision, "FREE_MEDIA");
    assert.equal(decision.mode, "SHADOW");
    assert.equal(await prisma.mediaSent.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.message.count({ where: { userId: user.id, direction: "OUTBOUND" } }), 0);

    await observeSalesTurn(turn(user.id, conversation.id, ["love that cute pic"]), { mode: "shadow", now: NOW });
    const contextual = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(contextual.decision, "FREE_MEDIA");
    assert.notEqual(contextual.reasonCode, "free_media_cooldown");
    assert.equal(await prisma.mediaSent.count({ where: { userId: user.id } }), 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
  }
});

test("a successful delivery starts the free-media cooldown and an explicit request is also subject to it", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram-business", platformConversationId: telegramUserId, businessConnectionId: "conn-media-sent" },
  });
  const asset = await createAsset(prisma, "sent");
  const secondAsset = await createAsset(prisma, "second");
  try {
    const row = await recordSuccessfulMediaDelivery({
      userId: user.id,
      conversationId: conversation.id,
      mediaAssetId: asset.id,
      source: "FREE_MEDIA",
      telegramMessageId: "900",
      sentAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    assert.equal(row.telegramMessageId, "900");
    assert.equal(await prisma.mediaSent.count({ where: { userId: user.id } }), 1);

    await observeSalesTurn(turn(user.id, conversation.id, ["love that cute pic"]), { mode: "shadow", now: NOW });
    const cooled = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    assert.equal(cooled.decision, "SUPPRESS");
    assert.equal(cooled.reasonCode, "free_media_cooldown");

    await observeSalesTurn(turn(user.id, conversation.id, ["send me a pic"]), { mode: "shadow", now: NOW });
    const explicit = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    assert.equal(explicit.decision, "SUPPRESS");
    assert.equal(explicit.reasonCode, "free_media_cooldown");
    assert.equal(await prisma.mediaSent.count({ where: { userId: user.id } }), 1);

    // After cooldown expired (61 minutes after NOW = 71 minutes after sentAt > 60 min cooldown), explicit request is allowed for unseen second asset
    const afterCooldown = new Date(NOW.getTime() + 61 * 60 * 1000);
    await observeSalesTurn(turn(user.id, conversation.id, ["send me a pic"]), { mode: "shadow", now: afterCooldown });
    const after = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    assert.equal(after.decision, "FREE_MEDIA");
    assert.equal(after.reasonCode, "explicit_media_request");
    assert.notEqual(after.candidateMediaAssetId, asset.id);
    assert.ok(after.candidateMediaAssetId);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
    await prisma.mediaAsset.delete({ where: { id: secondAsset.id } }).catch(() => undefined);
  }
});

test("a failed Telegram send records nothing and does not start cooldown", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram-business", platformConversationId: telegramUserId, businessConnectionId: "conn-media-fail" },
  });
  const asset = await createAsset(prisma, "fail");
  try {
    await assert.rejects(() => deliverMediaThenRecord({
      userId: user.id,
      conversationId: conversation.id,
      mediaAssetId: asset.id,
      source: "FREE_MEDIA",
      send: async () => {
        throw new Error("telegram down");
      },
    }));
    assert.equal(await prisma.mediaSent.count({ where: { userId: user.id } }), 0);
    await observeSalesTurn(turn(user.id, conversation.id, ["love that cute pic"]), { mode: "shadow", now: NOW });
    const decision = await prisma.salesDecision.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(decision.decision, "FREE_MEDIA");
    assert.notEqual(decision.reasonCode, "free_media_cooldown");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
  }
});

test("one user's delivery does not cool down or count for another user", async () => {
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const first = await seedPair(prisma, "user-a");
  const second = await seedPair(prisma, "user-b");
  const asset = await createAsset(prisma, "shared");
  try {
    await recordSuccessfulMediaDelivery({
      userId: first.userId,
      conversationId: first.conversationId,
      mediaAssetId: asset.id,
      source: "FREE_MEDIA",
      sentAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    });
    await observeSalesTurn(turn(first.userId, first.conversationId, ["love that cute pic"]), { mode: "shadow", now: NOW });
    await observeSalesTurn(turn(second.userId, second.conversationId, ["love that cute pic"]), { mode: "shadow", now: NOW });
    const cooled = await prisma.salesDecision.findFirstOrThrow({ where: { userId: first.userId } });
    const open = await prisma.salesDecision.findFirstOrThrow({ where: { userId: second.userId } });
    assert.equal(cooled.reasonCode, "free_media_cooldown");
    assert.equal(open.decision, "FREE_MEDIA");
    assert.equal(await prisma.mediaSent.count({ where: { userId: second.userId } }), 0);
  } finally {
    await prisma.user.delete({ where: { id: first.userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: second.userId } }).catch(() => undefined);
    await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
  }
});

test("selection prefers a relevant unseen asset, never recycles sent assets, and never selects an inactive asset", () => {
  const seen = photo("asset-x", { contexts: ["casual_selfie", "at_home"] });
  const unseen = photo("asset-y", { contexts: ["casual_selfie", "at_home"] });
  const inactive = photo("asset-z", { contexts: ["casual_selfie", "at_home"], active: false });
  const signal = readSalesSignal(["love that cute pic"]);
  const recent = new Date(NOW.getTime() - 60 * 60 * 1000);
  const older = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);

  assert.equal(selectFreeMedia(signal, [seen, unseen, inactive], "UNKNOWN", 0, [{ mediaAssetId: seen.id, sentAt: recent }])?.id, unseen.id);
  assert.equal(
    selectFreeMedia(signal, [seen, unseen], "UNKNOWN", 0, [
      { mediaAssetId: seen.id, sentAt: older },
      { mediaAssetId: unseen.id, sentAt: recent },
    ]),
    null,
  );
  assert.equal(selectFreeMedia(signal, [inactive], "UNKNOWN", 0)?.id, undefined);
});

test("a strong contextual match that was already sent is not recycled even when library has only sent assets", () => {
  const sentHome = photo("home-sent", { category: "home", contexts: ["casual_selfie", "at_home"], mood: "relaxed" });
  const signal = readSalesSignal(["love that cute pic"]);
  const history = [{ mediaAssetId: sentHome.id, sentAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }];
  assert.equal(selectFreeMedia(signal, [sentHome], "UNKNOWN", 0, history), null);
});

test("interaction dynamic still breaks a tie between equally relevant unseen photos", () => {
  const cute = photo("cute-one", { category: "cute", contexts: ["mirror"] });
  const flirty = photo("flirty-one", { category: "flirty", contexts: ["mirror"] });
  const signal = { ...readSalesSignal(["love that cute pic"]), desiredContexts: ["mirror"] };
  assert.equal(selectFreeMedia(signal, [cute, flirty], "DOMINANT_AMY", 0.9)?.id, flirty.id);
  assert.equal(selectFreeMedia(signal, [cute, flirty], "DOMINANT_USER", 0.9)?.id, cute.id);
  assert.equal(selectFreeMedia(signal, [flirty, cute], "UNKNOWN", 0.2)?.id, cute.id);
});

test("a shadow decision is not treated as delivery history", () => {
  const signal = readSalesSignal(["love that cute pic"]);
  const home = photo("media-home");
  const decision = decideSales({
    signal,
    declinedNow: false,
    assets: [home],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: null,
    mediaDeliveries: [],
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
  assert.equal(decision.decision, "FREE_MEDIA");
  const cooled = decideSales({
    signal,
    declinedNow: false,
    assets: [home],
    offers: [],
    purchasedOfferIds: new Set(),
    interactions: [],
    priorFreeMediaAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    mediaDeliveries: [{ mediaAssetId: home.id, sentAt: new Date(NOW.getTime() - 5 * 60 * 1000) }],
    dynamic: "UNKNOWN",
    dynamicConfidence: 0,
    now: NOW,
  });
  assert.equal(cooled.reasonCode, "free_media_cooldown");
});

test("/media_sent is owner-only and shows compact delivery history", async () => {
  const command = commandUpdate("42", "/media_sent 100");
  assert.equal(classifyMediaSentCommand(command, ""), null);
  assert.equal(classifyMediaSentCommand(command, "99"), null);
  assert.equal(classifyMediaSentCommand(commandUpdate("42", "/media_sent"), "42"), null);
  assert.equal(classifyMediaSentCommand({ ...command, business_message: command.message, message: undefined }, "42"), null);
  assert.equal(classifyMediaSentCommand(command, "42")?.telegramUserId, "100");

  const when = new Date("2026-09-28T19:32:00.000Z");
  const label = mediaSentLabel({ category: "selfie", id: "cmasset123456" });
  const text = formatMediaSentHistory([{ source: "FREE_MEDIA", label, sentAt: when }]);
  assert.match(text, /^FREE_MEDIA\nselfie_123456\n2026-09-28 14:32 Cancun$/);
  assert.equal(text.includes("free/"), false);
  assert.equal(text.includes("http"), false);
  assert.equal(formatMediaSentHistory([]), "No media delivery history.");

  const { prisma } = await import("@/lib/db/prisma");
  const { processMediaSentCommand } = await import("@/services/media/delivery");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, platform: "telegram-business", platformConversationId: telegramUserId, businessConnectionId: "conn-media-inspect" },
  });
  const asset = await prisma.mediaAsset.create({
    data: {
      telegramFileId: `file-${telegramUserId}`,
      telegramFileUniqueId: `unique-${telegramUserId}`,
      storagePath: `free/secret/${telegramUserId}.jpg`,
      mediaType: "PHOTO",
      category: "selfie",
      description: "not shown",
      tags: ["casual_selfie"],
      mood: "relaxed",
      flirtLevel: 1,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["casual_selfie"],
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  await recordSuccessfulMediaDelivery({
    userId: user.id,
    conversationId: conversation.id,
    mediaAssetId: asset.id,
    source: "FREE_MEDIA",
    telegramMessageId: "901",
    sentAt: when,
  });
  const sent: string[] = [];
  try {
    await processMediaSentCommand(commandUpdate("42", `/media_sent ${telegramUserId}`), "42", async (_chatId, body) => {
      sent.push(body);
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /FREE_MEDIA/);
    assert.match(sent[0] ?? "", /selfie_/);
    assert.equal((sent[0] ?? "").includes("secret"), false);
    assert.equal((sent[0] ?? "").includes(telegramUserId), false);
    assert.equal((sent[0] ?? "").includes("901"), false);
    await processMediaSentCommand(commandUpdate("42", "/media_sent 424242"), "42", async (_chatId, body) => {
      sent.push(body);
    });
    assert.equal(sent[1], "No media delivery history.");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
  }
});

function photo(id: string, patch: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id,
    category: "selfie",
    tags: ["casual_selfie"],
    mood: "relaxed",
    flirtLevel: 1,
    contexts: ["casual_selfie", "at_home"],
    active: true,
    ...patch,
  };
}

function turn(userId: string, conversationId: string, userTexts: string[]) {
  return { userId, conversationId, triggerMessageId: null, userTexts, amyTexts: ["hey"] };
}

function commandUpdate(id: string, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: Number(id), type: "private" },
      from: { id: Number(id), is_bot: false },
      text,
    },
  };
}

function uniqueId(): string {
  return String(8_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
}

async function seedPair(
  prisma: typeof import("@/lib/db/prisma").prisma,
  label: string,
): Promise<{ userId: string; conversationId: string }> {
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: `${label}-${telegramUserId}`,
      businessConnectionId: `conn-${label}`,
    },
  });
  return { userId: user.id, conversationId: conversation.id };
}

async function createAsset(prisma: typeof import("@/lib/db/prisma").prisma, label: string) {
  const suffix = `${label}-${uniqueId()}`;
  return prisma.mediaAsset.create({
    data: {
      telegramFileId: `file-${suffix}`,
      telegramFileUniqueId: `unique-${suffix}`,
      storagePath: `free/test/${suffix}.jpg`,
      mediaType: "PHOTO",
      category: "selfie",
      description: "casual selfie",
      tags: ["casual_selfie"],
      mood: "relaxed",
      flirtLevel: 1,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["casual_selfie", "at_home"],
      active: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
}
