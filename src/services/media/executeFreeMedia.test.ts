import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { classifyFreeMediaTestCommand, executeFreeMedia, freeMediaMode, processFreeMediaTestCommand } from "@/services/media/executeFreeMedia";
import { selectFreeMedia, type MediaCandidate } from "@/services/sales/decide";
import { readSalesSignal } from "@/services/sales/signals";

const NOW = new Date("2026-09-28T20:00:00.000Z");

test("missing or invalid FREE_MEDIA_MODE is shadow", () => {
  assert.equal(freeMediaMode(undefined), "shadow");
  assert.equal(freeMediaMode(""), "shadow");
  assert.equal(freeMediaMode("liveish"), "shadow");
  assert.equal(freeMediaMode("live"), "live");
});

test("shadow FREE_MEDIA sends no photo and creates no MediaSent", async () => {
  const fixture = await seedEligible("shadow");
  const sent: string[] = [];
  try {
    const { observeSalesTurn } = await import("@/services/sales/observe");
    await observeSalesTurn(await fixture.turn("send me a pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "shadow",
      loadCatalog: async () => fixture.catalog(),
      sendFreePhoto: async () => {
        sent.push("photo");
        return { telegramMessageId: "1" };
      },
    });
    const { prisma } = await import("@/lib/db/prisma");
    const decision = await prisma.salesDecision.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(decision.decision, "FREE_MEDIA");
    assert.equal(decision.mode, "SHADOW");
    assert.equal(sent.length, 0);
    assert.equal(await prisma.mediaSent.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.freeMediaExecution.count({ where: { userId: fixture.userId } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("live FREE_MEDIA sends one photo after selection and records MediaSent", async () => {
  const fixture = await seedEligible("live");
  const events: string[] = [];
  try {
    const { observeSalesTurn } = await import("@/services/sales/observe");
    await observeSalesTurn(await fixture.turn("send me a pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      loadCatalog: async () => fixture.catalog(),
      sendFreePhoto: async (photo) => {
        events.push(photo.mediaAssetId);
        assert.equal(photo.businessConnectionId, "conn-live");
        return { telegramMessageId: "501" };
      },
    });
    const { prisma } = await import("@/lib/db/prisma");
    assert.deepEqual(events, [fixture.assetId]);
    const row = await prisma.mediaSent.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(row.source, "FREE_MEDIA");
    assert.equal(row.mediaAssetId, fixture.assetId);
    assert.equal(row.telegramMessageId, "501");
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.tipLink.count({ where: { userId: fixture.userId } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a failed photo send leaves no MediaSent and can be retried", async () => {
  const fixture = await seedEligible("fail");
  let attempts = 0;
  const send = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("telegram down");
    return { telegramMessageId: "502" };
  };
  try {
    const first = await executeFreeMedia({
      mode: "live",
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      triggerMessageId: fixture.trigger,
      mediaAssetId: fixture.assetId,
      explicitMediaRequest: true,
      emotionalState: "NORMAL",
      declinedNow: false,
      now: NOW,
      sendPhoto: async () => send(),
    });
    const { prisma } = await import("@/lib/db/prisma");
    assert.equal(first, "send_failed");
    assert.equal(await prisma.mediaSent.count({ where: { userId: fixture.userId } }), 0);
    const second = await executeFreeMedia({
      mode: "live",
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      triggerMessageId: fixture.trigger,
      mediaAssetId: fixture.assetId,
      explicitMediaRequest: true,
      emotionalState: "NORMAL",
      declinedNow: false,
      now: new Date(NOW.getTime() + 3 * 60 * 1000),
      sendPhoto: async () => send(),
    });
    assert.equal(second, "sent");
    assert.equal(attempts, 2);
    assert.equal(await prisma.mediaSent.count({ where: { userId: fixture.userId } }), 1);
  } finally {
    await fixture.cleanup();
  }
});

test("the same trigger cannot deliver two free photos", async () => {
  const fixture = await seedEligible("dup");
  let sends = 0;
  const run = () => executeFreeMedia({
    mode: "live",
    userId: fixture.userId,
    conversationId: fixture.conversationId,
    triggerMessageId: fixture.trigger,
    mediaAssetId: fixture.assetId,
    explicitMediaRequest: true,
    emotionalState: "NORMAL",
    declinedNow: false,
    now: NOW,
    sendPhoto: async () => {
      sends += 1;
      return { telegramMessageId: "503" };
    },
  });
  try {
    const [first, second] = await Promise.all([run(), run()]);
    assert.deepEqual([first, second].sort(), ["duplicate", "sent"]);
    const third = await run();
    assert.equal(third, "duplicate");
    assert.equal(sends, 1);
    const { prisma } = await import("@/lib/db/prisma");
    assert.equal(await prisma.mediaSent.count({ where: { userId: fixture.userId } }), 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a delivery for one user does not send to another", async () => {
  const first = await seedEligible("user-a");
  const second = await seedEligible("user-b");
  const sent: string[] = [];
  try {
    await executeFreeMedia({
      mode: "live",
      userId: first.userId,
      conversationId: first.conversationId,
      triggerMessageId: first.trigger,
      mediaAssetId: first.assetId,
      explicitMediaRequest: true,
      emotionalState: "NORMAL",
      declinedNow: false,
      now: NOW,
      sendPhoto: async (photo) => {
        sent.push(photo.chatId);
        return { telegramMessageId: "504" };
      },
    });
    const { prisma } = await import("@/lib/db/prisma");
    assert.deepEqual(sent, [first.chatId]);
    assert.equal(await prisma.mediaSent.count({ where: { userId: second.userId } }), 0);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("cooldown follows MediaSent and an explicit request still bypasses it", async () => {
  const fixture = await seedEligible("cool");
  const { prisma } = await import("@/lib/db/prisma");
  const { recordSuccessfulMediaDelivery } = await import("@/services/media/delivery");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  let sends = 0;
  try {
    await recordSuccessfulMediaDelivery({
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      mediaAssetId: fixture.assetId,
      source: "MANUAL",
      sentAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    await observeSalesTurn(await fixture.turn("love that cute pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      sendFreePhoto: async () => {
        sends += 1;
        return { telegramMessageId: "505" };
      },
    });
    assert.equal(sends, 0);
    const cooled = await prisma.salesDecision.findFirstOrThrow({ where: { userId: fixture.userId }, orderBy: { createdAt: "desc" } });
    assert.equal(cooled.reasonCode, "free_media_cooldown");
    // Explicit request must NOT bypass cooldown!
    await observeSalesTurn(await fixture.turn("send me a pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      sendFreePhoto: async () => {
        sends += 1;
        return { telegramMessageId: "506" };
      },
    });
    assert.equal(sends, 0);

    // After cooldown window has elapsed (16 minutes), an unseen asset can be sent
    const uniq = `tg-file-uniq-free-2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const secondAsset = await prisma.mediaAsset.create({
      data: {
        category: "selfie",
        description: "another selfie",
        mood: "relaxed",
        flirtLevel: 1,
        contexts: ["casual_selfie"],
        tags: ["casual"],
        storagePath: "/tmp/amy-free-2.jpg",
        telegramFileId: `tg-file-free-2-${uniq}`,
        telegramFileUniqueId: uniq,
        mediaType: "PHOTO",
        availability: "FREE",
        active: true,
        peopleCount: 1,
        hasAmy: true,
        hasLuna: false,
      },
    });
    try {
      await observeSalesTurn(await fixture.turn("send me a pic"), {
        mode: "shadow",
        now: new Date(NOW.getTime() + 16 * 60 * 1000),
        freeMediaMode: "live",
        sendFreePhoto: async () => {
          sends += 1;
          return { telegramMessageId: "507" };
        },
      });
      assert.equal(sends, 1);
    } finally {
      await prisma.freeMediaExecution.deleteMany({ where: { mediaAssetId: secondAsset.id } }).catch(() => undefined);
      await prisma.mediaSent.deleteMany({ where: { mediaAssetId: secondAsset.id } }).catch(() => undefined);
      await prisma.mediaAsset.delete({ where: { id: secondAsset.id } }).catch(() => undefined);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("an asset that becomes inactive is not sent", async () => {
  const fixture = await seedEligible("inactive");
  const { prisma } = await import("@/lib/db/prisma");
  let sends = 0;
  try {
    await prisma.mediaAsset.update({ where: { id: fixture.assetId }, data: { active: false } });
    const outcome = await executeFreeMedia({
      mode: "live",
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      triggerMessageId: fixture.trigger,
      mediaAssetId: fixture.assetId,
      explicitMediaRequest: true,
      emotionalState: "NORMAL",
      declinedNow: false,
      now: NOW,
      sendPhoto: async () => {
        sends += 1;
        return { telegramMessageId: "507" };
      },
    });
    assert.equal(outcome, "no_asset");
    assert.equal(sends, 0);
    assert.equal(await prisma.mediaSent.count({ where: { userId: fixture.userId } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a missing business connection does not send from the technical bot", async () => {
  const fixture = await seedEligible("nobiz", { businessConnectionId: null, platform: "telegram" });
  let sends = 0;
  try {
    const outcome = await executeFreeMedia({
      mode: "live",
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      triggerMessageId: fixture.trigger,
      mediaAssetId: fixture.assetId,
      explicitMediaRequest: true,
      emotionalState: "NORMAL",
      declinedNow: false,
      now: NOW,
      sendPhoto: async () => {
        sends += 1;
        return { telegramMessageId: "508" };
      },
    });
    assert.equal(outcome, "invalid_business_connection");
    assert.equal(sends, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("premium, distress, and tip turns do not execute free media", async () => {
  const fixture = await seedEligible("separate");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  let sends = 0;
  const sendFreePhoto = async () => {
    sends += 1;
    return { telegramMessageId: "509" };
  };
  try {
    await observeSalesTurn(await fixture.turn("do you have any private pics?"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      tipMode: "shadow",
      loadCatalog: async () => fixture.catalog(),
      sendFreePhoto,
    });
    await observeSalesTurn(await fixture.turn("i want to die. send me a pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      loadCatalog: async () => fixture.catalog(),
      sendFreePhoto,
    });
    await observeSalesTurn(await fixture.turn("можно тебя поддержать?"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      tipMode: "shadow",
      loadCatalog: async () => fixture.catalog(),
      sendFreePhoto,
    });
    assert.equal(sends, 0);
    const { prisma } = await import("@/lib/db/prisma");
    const decisions = await prisma.salesDecision.findMany({ where: { userId: fixture.userId }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(decisions.map((row) => row.decision), ["NO_OFFER", "NO_OFFER", "TIP"]);
    assert.notEqual(decisions[0]?.reasonCode, "explicit_media_request");
    assert.equal(await prisma.mediaSent.count({ where: { userId: fixture.userId, source: "FREE_MEDIA" } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("selector still prefers an unseen relevant photo", () => {
  const seen = candidate("seen");
  const unseen = candidate("unseen");
  const picked = selectFreeMedia(readSalesSignal(["send me a pic"]), [seen, unseen], "UNKNOWN", 0, [
    { mediaAssetId: seen.id, sentAt: NOW },
  ]);
  assert.equal(picked?.id, unseen.id);
});

test("/free_media_test is owner-only and uses the live delivery path", async () => {
  const command = commandUpdate("42", "/free_media_test 100");
  assert.equal(classifyFreeMediaTestCommand(command, ""), null);
  assert.equal(classifyFreeMediaTestCommand(command, "99"), null);
  assert.equal(classifyFreeMediaTestCommand(commandUpdate("42", "/free_media_test"), "42"), null);
  assert.equal(classifyFreeMediaTestCommand({ ...command, business_message: command.message, message: undefined }, "42"), null);

  const fixture = await seedEligible("owner-test");
  const owner: string[] = [];
  let business = "";
  try {
    await processFreeMediaTestCommand(commandUpdate("42", `/free_media_test ${fixture.telegramUserId}`), "42", {
      now: NOW,
      sendOwner: async (_chatId, text) => {
        owner.push(text);
      },
      sendPhoto: async (photo) => {
        business = photo.businessConnectionId;
        return { telegramMessageId: "510" };
      },
    });
    assert.equal(business, "conn-owner-test");
    assert.match(owner[0] ?? "", /^Sent\.\n/);
    assert.equal((owner[0] ?? "").includes("free/"), false);
    assert.equal((owner[0] ?? "").includes("http"), false);
    const { prisma } = await import("@/lib/db/prisma");
    const row = await prisma.mediaSent.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(row.source, "FREE_MEDIA");
  } finally {
    await fixture.cleanup();
  }
});

function candidate(id: string): MediaCandidate {
  return {
    id,
    category: "selfie",
    tags: ["casual_selfie"],
    mood: "relaxed",
    flirtLevel: 1,
    contexts: ["casual_selfie", "at_home"],
    active: true,
  };
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
  return String(8_100_000_000 + Math.floor(Math.random() * 1_000_000_000));
}

async function seedEligible(
  label: string,
  options: { businessConnectionId?: string | null; platform?: string } = {},
) {
  const { prisma } = await import("@/lib/db/prisma");
  const telegramUserId = uniqueId();
  const user = await prisma.user.create({ data: { telegramUserId, aiEnabled: true, relationshipStage: "ENGAGED" } });
  const businessConnectionId = options.businessConnectionId === undefined ? `conn-${label}` : options.businessConnectionId;
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: options.platform ?? "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId,
      active: true,
    },
  });
  const suffix = `${label}-${telegramUserId}`;
  const asset = await prisma.mediaAsset.create({
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
  const trigger = `turn-${suffix}`;
  return {
    userId: user.id,
    conversationId: conversation.id,
    assetId: asset.id,
    telegramUserId,
    chatId: telegramUserId,
    trigger,
    async turn(text: string) {
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          userId: user.id,
          direction: "INBOUND",
          sender: "USER",
          type: "TEXT",
          text,
          telegramMessageId: `${suffix}-${uniqueId()}`,
        },
      });
      return {
        userId: user.id,
        conversationId: conversation.id,
        triggerMessageId: message.id,
        userTexts: [text],
        amyTexts: ["может быть"],
      };
    },
    catalog(withOffer = false) {
      return {
        assets: [candidate(asset.id)],
        offers: withOffer
          ? [{
              id: "offer-private",
              slug: "private-set",
              tags: ["private"],
              contexts: ["private_photos", "flirty"],
              flirtLevel: 3,
              active: true,
              hasActivePrice: true, priority: 1,
            }]
          : [],
        purchasedOfferIds: [] as string[],
        interactions: [],
        priorFreeMediaAt: null,
        mediaDeliveries: [],
        dynamic: "UNKNOWN" as const,
        dynamicConfidence: 0,
      };
    },
    async cleanup() {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
    },
  };
}

test("regression A: asset A sent once cannot be selected again for the same user", async () => {
  const fixture = await seedEligible("reg-a");
  const { prisma } = await import("@/lib/db/prisma");
  const { recordSuccessfulMediaDelivery } = await import("@/services/media/delivery");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  try {
    await recordSuccessfulMediaDelivery({
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      mediaAssetId: fixture.assetId,
      source: "FREE_MEDIA",
      sentAt: new Date(NOW.getTime() - 30 * 60 * 1000),
    });
    let sends = 0;
    await observeSalesTurn(await fixture.turn("send me a pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      sendFreePhoto: async () => {
        sends += 1;
        return { telegramMessageId: "999" };
      },
    });
    assert.equal(sends, 0);
    const decision = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: fixture.userId },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(decision.decision, "NO_OFFER");
    assert.equal(decision.reasonCode, "no_matching_media");
  } finally {
    await fixture.cleanup();
  }
});

test("regression B: asset A may still be selected for a different user", async () => {
  const fixture1 = await seedEligible("reg-b1");
  const { prisma } = await import("@/lib/db/prisma");
  const { recordSuccessfulMediaDelivery } = await import("@/services/media/delivery");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  const telegramUserId2 = uniqueId();
  const user2 = await prisma.user.create({ data: { telegramUserId: telegramUserId2, aiEnabled: true } });
  const conversation2 = await prisma.conversation.create({
    data: {
      userId: user2.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId2,
      businessConnectionId: "conn-reg-b2",
      active: true,
    },
  });
  try {
    await recordSuccessfulMediaDelivery({
      userId: fixture1.userId,
      conversationId: fixture1.conversationId,
      mediaAssetId: fixture1.assetId,
      source: "FREE_MEDIA",
      sentAt: new Date(NOW.getTime() - 30 * 60 * 1000),
    });
    let sends = 0;
    const msg2 = await prisma.message.create({
      data: {
        conversationId: conversation2.id,
        userId: user2.id,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "send me a pic",
        telegramMessageId: `msg-${uniqueId()}`,
      },
    });
    await observeSalesTurn(
      {
        userId: user2.id,
        conversationId: conversation2.id,
        triggerMessageId: msg2.id,
        userTexts: ["send me a pic"],
        amyTexts: ["может быть"],
      },
      {
        mode: "shadow",
        now: NOW,
        freeMediaMode: "live",
        sendFreePhoto: async () => {
          sends += 1;
          return { telegramMessageId: "998" };
        },
      },
    );
    assert.equal(sends, 1);
    const sentRecord = await prisma.mediaSent.findFirst({
      where: { userId: user2.id, mediaAssetId: fixture1.assetId },
    });
    assert.ok(sentRecord);
  } finally {
    await prisma.user.delete({ where: { id: user2.id } }).catch(() => undefined);
    await fixture1.cleanup();
  }
});

test("regression C: all eligible assets previously sent -> no_matching_media and no photo", async () => {
  const fixture = await seedEligible("reg-c");
  const { prisma } = await import("@/lib/db/prisma");
  const { recordSuccessfulMediaDelivery } = await import("@/services/media/delivery");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  try {
    await recordSuccessfulMediaDelivery({
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      mediaAssetId: fixture.assetId,
      source: "FREE_MEDIA",
      sentAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    let sends = 0;
    await observeSalesTurn(await fixture.turn("send me a pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      sendFreePhoto: async () => {
        sends += 1;
        return { telegramMessageId: "997" };
      },
    });
    assert.equal(sends, 0);
    const decision = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: fixture.userId },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(decision.decision, "NO_OFFER");
    assert.equal(decision.reasonCode, "no_matching_media");
  } finally {
    await fixture.cleanup();
  }
});

test("regression D: failed Telegram send does not incorrectly exhaust the asset", async () => {
  const fixture = await seedEligible("reg-d");
  const { prisma } = await import("@/lib/db/prisma");
  const { observeSalesTurn } = await import("@/services/sales/observe");
  try {
    await observeSalesTurn(await fixture.turn("send me a pic"), {
      mode: "shadow",
      now: NOW,
      freeMediaMode: "live",
      sendFreePhoto: async () => {
        throw new Error("Telegram network error");
      },
    });
    const count = await prisma.mediaSent.count({
      where: { userId: fixture.userId, mediaAssetId: fixture.assetId },
    });
    assert.equal(count, 0);

    let sends = 0;
    await observeSalesTurn(await fixture.turn("send me a pic"), {
      mode: "shadow",
      now: new Date(NOW.getTime() + 1000),
      freeMediaMode: "live",
      sendFreePhoto: async () => {
        sends += 1;
        return { telegramMessageId: "996" };
      },
    });
    assert.equal(sends, 1);
    const sentRecord = await prisma.mediaSent.findFirst({
      where: { userId: fixture.userId, mediaAssetId: fixture.assetId },
    });
    assert.ok(sentRecord);
  } finally {
    await fixture.cleanup();
  }
});

test("regression E: paid/LOCKED media behavior unchanged", async () => {
  const signal = readSalesSignal(["show me a pic"]);
  const lockedAsset: MediaCandidate = {
    id: "locked-asset-1",
    category: "selfie",
    tags: ["casual_selfie"],
    mood: "relaxed",
    flirtLevel: 1,
    contexts: ["casual_selfie"],
    active: true,
    freeEligible: false,
  };
  const selected = selectFreeMedia(signal, [lockedAsset]);
  assert.equal(selected, null);
});

