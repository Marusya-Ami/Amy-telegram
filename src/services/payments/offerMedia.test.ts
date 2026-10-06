import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@/lib/db/prisma";
import { photoDeliveryFields } from "@/lib/telegram/client";
import { removeFreePhoto, writeFreePhoto } from "@/services/media/library";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { isFreePhotoEligible } from "@/services/media/eligibility";
import { selectFreeMedia, type MediaCandidate } from "@/services/sales/decide";
import { observeSalesTurn } from "@/services/sales/observe";
import {
  classifyOfferMediaCommand,
  offerMediaText,
  processOfferMediaCommand,
} from "@/services/payments/offerMedia";
import { executePaidOffer, processPaidOfferTestCommand } from "@/services/payments/paidOffer";

const INVOICE = "https://t.me/invoice/preview-secret";

test("sendPhoto can carry a caption and inline button without putting the url in the caption", () => {
  const fields = photoDeliveryFields({
    businessConnectionId: "conn",
    photo: "file-preview",
    caption: "🔒 Shower time 💋\n2 private photos",
    replyMarkup: { inline_keyboard: [[{ text: "⭐ Открыть за 420 Stars", url: INVOICE }]] },
  });
  assert.equal(fields.caption, "🔒 Shower time 💋\n2 private photos");
  assert.equal(JSON.stringify(fields.reply_markup).includes(INVOICE), true);
  assert.equal(String(fields.caption).includes("http"), false);
  assert.equal(fields.business_connection_id, "conn");
  const plain = photoDeliveryFields({ businessConnectionId: "conn", photo: "file-free" });
  assert.equal("caption" in plain, false);
  assert.equal("reply_markup" in plain, false);
});

test("an offer without deliverable bytes does not send a preview card", async () => {
  const fixture = await seed("text");
  try {
    let sent = false;
    const outcome = await executePaidOffer(live(fixture, {
      sendOffer: async () => {
        sent = true;
        return { telegramMessageId: "should-not-send" };
      },
    }));
    assert.equal(outcome, "no_offer");
    assert.equal(sent, false);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.paidContentDelivery.count({ where: { offerId: fixture.offerId } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("an active preview is one photo card and an inactive preview falls back to text", async () => {
  const fixture = await seed("preview");
  const preview = await photo(fixture, "selfie", "file-preview");
  const locked = await photo(fixture, "home", "file-locked");
  try {
    await assign(fixture, preview.id, "PREVIEW", 1);
    await assign(fixture, locked.id, "DELIVERABLE", 1);
    await writeFreePhoto(locked.storagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const seen: { assetIds: string[] } = { assetIds: [] };
    const outcome = await executePaidOffer(live(fixture, {
      sendOffer: async (delivery) => {
        seen.assetIds = delivery.media.map((item) => item.assetId);
        assert.equal(delivery.caption.includes("http"), false);
        assert.equal(delivery.caption.includes(preview.id), false);
        assert.equal(delivery.starCount, 180);
        return { telegramMessageId: "paid-media" };
      },
    }));
    assert.equal(outcome, "sent");
    assert.deepEqual(seen.assetIds, [locked.id]);
    assert.equal(await prisma.paidContentDelivery.count({ where: { userId: fixture.userId } }), 0);

    await prisma.mediaAsset.update({ where: { id: preview.id }, data: { active: false } });
    await prisma.paidOfferExecution.deleteMany({ where: { userId: fixture.userId } });
    await prisma.userOfferInteraction.deleteMany({ where: { userId: fixture.userId } });
    await prisma.paymentIntent.deleteMany({ where: { userId: fixture.userId } });
    let fallbackIds: string[] = [];
    const second = await executePaidOffer(live(fixture, {
      triggerKey: `${fixture.trigger}-fallback`,
      sendOffer: async (delivery) => {
        fallbackIds = delivery.media.map((item) => item.assetId);
        return { telegramMessageId: "paid-again" };
      },
    }));
    assert.equal(second, "sent");
    assert.deepEqual(fallbackIds, [locked.id]);
  } finally {
    await removeFreePhoto(locked.storagePath);
    await fixture.cleanup();
  }
});

test("deliverables stay out of free selection and ordered previews follow availability", async () => {
  const free = candidate("free-photo");
  const deliverable = candidate("locked-photo", false);
  const previewLocked = candidate("preview-locked", false);
  const previewFree = candidate("preview-free", true);
  assert.equal(selectFreeMedia(readSignal(), [deliverable, free])?.id, free.id);
  assert.equal(selectFreeMedia(readSignal(), [previewLocked, previewFree])?.id, previewFree.id);
  assert.equal(selectFreeMedia(readSignal(), [free])?.id, free.id);
  assert.equal(isFreePhotoEligible({ active: true, availability: "FREE", deliverable: true }), false);
  assert.equal(isFreePhotoEligible({ active: true, availability: "LOCKED", deliverable: false }), false);
  assert.equal(isFreePhotoEligible({ active: true, availability: "FREE", deliverable: false }), true);

  const fixture = await seed("eligible");
  const ordinary = await photo(fixture, "casual", "file-ordinary");
  const secret = await photo(fixture, "home", "file-secret");
  try {
    await assign(fixture, secret.id, "DELIVERABLE", 1);
    const visible = await prisma.mediaAsset.findMany({
      where: {
        id: { in: [ordinary.id, secret.id] },
        active: true,
        availability: "FREE",
        offerMedia: { none: { active: true, role: "DELIVERABLE" } },
      },
      select: { id: true },
    });
    assert.deepEqual(visible.map((row) => row.id).sort(), [ordinary.id]);
  } finally {
    await fixture.cleanup();
  }
});

test("owner media commands assign, order, and stay private", async () => {
  const owner = uniqueId();
  const fixture = await seed("assign");
  const first = await photo(fixture, "home", "file-a");
  const second = await photo(fixture, "selfie", "file-b");
  const inactive = await photo(fixture, "cute", "file-c");
  await prisma.mediaAsset.update({ where: { id: inactive.id }, data: { active: false } });
  const replies: string[] = [];
  const sendOwner = async (_chatId: string, text: string) => {
    replies.push(text);
  };
  try {
    assert.equal(classifyOfferMediaCommand(command(owner, `/offer_media ${fixture.slug}`), "999"), null);
    const business = command(owner, `/offer_media ${fixture.slug}`);
    business.message = { ...business.message!, business_connection_id: "conn" };
    assert.equal(classifyOfferMediaCommand(business, owner), null);

    await processOfferMediaCommand(command(owner, `/offer_media ${fixture.slug}`), owner, { sendOwner });
    assert.match(replies[0] ?? "", /PREVIEW\nnone/);
    assert.match(replies[0] ?? "", /DELIVERABLE\nnone/);
    assert.equal((replies[0] ?? "").includes("file-a"), false);

    await processOfferMediaCommand(command(owner, `/offer_preview_set ${fixture.slug} ${inactive.id}`), owner, { sendOwner });
    assert.match(replies[1] ?? "", /not active/);

    await processOfferMediaCommand(command(owner, `/offer_preview_set ${fixture.slug} ${first.id}`), owner, { sendOwner });
    assert.match(replies[2] ?? "", new RegExp(`PREVIEW\\n- home_${first.id.slice(-6)}`));
    assert.equal((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.id } })).availability, "LOCKED");

    await processOfferMediaCommand(command(owner, `/offer_deliverable_add ${fixture.slug} ${second.id}`), owner, { sendOwner });
    await processOfferMediaCommand(command(owner, `/offer_deliverable_add ${fixture.slug} ${first.id}`), owner, { sendOwner });
    assert.match(replies[4] ?? "", /already a preview/);
    const other = await photo(fixture, "work", "file-d");
    await processOfferMediaCommand(command(owner, `/offer_deliverable_add ${fixture.slug} ${other.id}`), owner, { sendOwner });
    const listed = await offerMediaText(fixture.slug);
    assert.match(listed, new RegExp(`1\\. selfie_${second.id.slice(-6)}`));
    assert.match(listed, new RegExp(`2\\. work_${other.id.slice(-6)}`));
    assert.equal(listed.includes(second.id), false);
    assert.equal(listed.includes("file-b"), false);

    const rows = await prisma.paymentOfferMedia.findMany({
      where: { offerId: fixture.offerId, role: "DELIVERABLE", active: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { mediaAssetId: true, position: true },
    });
    assert.deepEqual(rows.map((row) => row.mediaAssetId), [second.id, other.id]);
    assert.deepEqual(rows.map((row) => row.position), [1, 2]);

    await processOfferMediaCommand(command("7", `/offer_media ${fixture.slug}`), owner, { sendOwner });
    assert.equal(replies.length, 6);
  } finally {
    await fixture.cleanup();
  }
});

test("owner preview test uses the visual card and shadow still does not present", async () => {
  const owner = uniqueId();
  const fixture = await seed("owner-preview");
  const preview = await photo(fixture, "selfie", "file-owner-preview");
  const deliverable = await photo(fixture, "home", "file-owner-deliverable");
  await assign(fixture, preview.id, "PREVIEW", 1);
  await assign(fixture, deliverable.id, "DELIVERABLE", 1);
  await writeFreePhoto(deliverable.storagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const replies: string[] = [];
  let fileId = "";
  try {
    await processPaidOfferTestCommand(command(owner, `/paid_offer_test ${fixture.telegramUserId} ${fixture.slug}`), owner, {
      sendOwner: async (_chatId, text) => {
        replies.push(text);
      },
      createInvoiceLink: async () => INVOICE,
      sendOffer: async (delivery) => {
        fileId = delivery.media.map((item) => item.assetId).join(",");
        assert.equal(delivery.media.some((item) => item.assetId === preview.id), false);
        assert.equal(delivery.caption.includes("http"), false);
        return { telegramMessageId: "owner-preview" };
      },
    });
    assert.equal(fileId, deliverable.id);
    assert.match(replies[0] ?? "", /180 XTR/);
    assert.equal((replies[0] ?? "").includes(INVOICE), false);

    let calls = 0;
    await observeSalesTurn(
      {
        userId: fixture.userId,
        conversationId: fixture.conversationId,
        triggerMessageId: fixture.messageId,
        userTexts: ["do you have any private pics?"],
        amyTexts: ["ok"],
      },
      {
        mode: "shadow",
        paidOfferMode: "shadow",
        freeMediaMode: "shadow",
        tipMode: "shadow",
        loadCatalog: async () => ({
          assets: [],
          offers: [{
            id: fixture.offerId,
            slug: fixture.slug,
            tags: ["flirty", "private_photos", "shower"],
            contexts: ["flirty", "private_photos", "shower"],
            flirtLevel: 3,
            active: true,
            hasActivePrice: true, priority: 1,
          }],
          purchasedOfferIds: [],
          interactions: [],
          priorFreeMediaAt: null,
          mediaDeliveries: [],
          dynamic: "EQUAL",
          dynamicConfidence: 0,
        }),
        sendPaidOffer: async () => {
          calls += 1;
          return { telegramMessageId: "no" };
        },
      },
    );
    assert.equal(calls, 0);
    const decision = await prisma.salesDecision.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(decision.decision, "PAID_OFFER");
  } finally {
    await removeFreePhoto(deliverable.storagePath);
    await fixture.cleanup();
  }
});

test("a tip still does not present a paid offer", async () => {
  const fixture = await seed("tip");
  let calls = 0;
  try {
    await observeSalesTurn(
      {
        userId: fixture.userId,
        conversationId: fixture.conversationId,
        triggerMessageId: fixture.messageId,
        userTexts: ["I want to leave you a tip"],
        amyTexts: ["ok"],
      },
      {
        mode: "shadow",
        paidOfferMode: "live",
        tipMode: "shadow",
        freeMediaMode: "shadow",
        sendPaidOffer: async () => {
          calls += 1;
          return { telegramMessageId: "no" };
        },
      },
    );
    const decision = await prisma.salesDecision.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(decision.decision, "TIP");
    assert.equal(calls, 0);
  } finally {
    await fixture.cleanup();
  }
});

function readSignal() {
  return {
    intent: "MEDIA_REQUEST" as const,
    explicitMediaRequest: true,
    mediaInterest: true,
    premiumInterest: false,
    emotionalState: "NORMAL" as const,
    flirtLevel: 2,
    commercialReadiness: "LOW" as const,
    confidence: 0.9,
    desiredContexts: ["casual_selfie", "at_home"],
    evidence: [],
  };
}

function candidate(id: string, freeEligible = true): MediaCandidate {
  return {
    id,
    category: "casual",
    tags: ["casual_selfie"],
    mood: "relaxed",
    flirtLevel: 1,
    contexts: ["casual_selfie", "at_home"],
    active: true,
    freeEligible,
  };
}

function live(fixture: Fixture, extra: Partial<Parameters<typeof executePaidOffer>[0]> = {}) {
  return {
    mode: "live" as const,
    userId: fixture.userId,
    conversationId: fixture.conversationId,
    triggerKey: fixture.trigger,
    offerId: fixture.offerId,
    confidence: 0.92,
    emotionalState: "NORMAL",
    declinedNow: false,
    userTexts: ["у тебя есть приватные фото?"],
    source: "SALES_ENGINE" as const,
    createInvoiceLink: async () => INVOICE,
    sendOffer: async () => ({ telegramMessageId: "offer" }),
    ...extra,
  };
}

async function assign(fixture: Fixture, mediaAssetId: string, role: "PREVIEW" | "DELIVERABLE", position: number) {
  await prisma.paymentOfferMedia.create({
    data: { offerId: fixture.offerId, mediaAssetId, role, position, active: true },
  });
  await prisma.mediaAsset.update({ where: { id: mediaAssetId }, data: { availability: "LOCKED" } });
}

async function photo(fixture: Fixture, category: "selfie" | "home" | "cute" | "casual" | "work", fileId: string) {
  return prisma.mediaAsset.create({
    data: {
      telegramFileId: `${fileId}-${fixture.userId}`,
      telegramFileUniqueId: `${fileId}-${fixture.userId}`,
      storagePath: `free/${fixture.userId}-${fileId}.jpg`,
      mediaType: "PHOTO",
      category,
      description: "test",
      tags: ["casual_selfie"],
      mood: "relaxed",
      flirtLevel: 1,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["casual_selfie"],
      active: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
}

type Fixture = {
  userId: string;
  telegramUserId: string;
  conversationId: string;
  offerId: string;
  slug: string;
  trigger: string;
  messageId: string;
  cleanup: () => Promise<void>;
};

async function seed(label: string): Promise<Fixture> {
  const telegramUserId = uniqueId();
  const slug = `night-${label}-${telegramUserId}`;
  const user = await prisma.user.create({ data: { telegramUserId, firstName: "Test" } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: `conn-${telegramUserId}`,
      active: true,
    },
  });
  const offer = await prisma.paymentOffer.create({
    data: {
      slug,
      title: "Night set",
      description: "3 private photos",
      kind: "PAID_CONTENT",
      tags: ["flirty", "private_photos", "shower"],
      contexts: ["flirty", "private_photos", "shower"],
      flirtLevel: 3,
      active: true,
      prices: { create: { provider: "TELEGRAM_STARS", amount: 180, currency: "XTR", active: true } },
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: user.id,
      direction: "INBOUND",
      sender: "USER",
      type: "TEXT",
      text: "seed",
      telegramMessageId: `${user.id}-seed`,
    },
  });
  return {
    userId: user.id,
    telegramUserId,
    conversationId: conversation.id,
    offerId: offer.id,
    slug,
    trigger: `trigger-${user.id}-${label}`,
    messageId: message.id,
    cleanup: async () => {
      await prisma.payment.deleteMany({ where: { userId: user.id } });
      await prisma.paidContentDelivery.deleteMany({ where: { userId: user.id } });
      await prisma.paidOfferExecution.deleteMany({ where: { userId: user.id } });
      await prisma.paymentIntent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.paymentOfferMedia.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOfferPrice.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOffer.delete({ where: { id: offer.id } });
      await prisma.mediaAsset.deleteMany({ where: { telegramFileUniqueId: { contains: user.id } } });
    },
  };
}

function command(id: string, text: string): TelegramUpdate {
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
  return String(7_300_000_000 + Math.floor(Math.random() * 1_000_000_000));
}
