import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@/lib/db/prisma";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { freeSelectableAssetWhere, isFreePhotoEligible } from "@/services/media/eligibility";
import {
  classifyPaidFulfillmentCommand,
  fulfillPaidContent,
  processPaidFulfillmentCommand,
} from "@/services/payments/fulfillPaidContent";
import { hasPurchasedOffer } from "@/services/payments/offers";
import { executePaidOffer, paidOfferMode } from "@/services/payments/paidOffer";
import { handleSuccessfulPayment } from "@/services/payments/telegramStars";

test("paid offer mode stays shadow unless the value is exactly live", () => {
  assert.equal(paidOfferMode("shadow"), "shadow");
  assert.equal(paidOfferMode(undefined), "shadow");
  assert.equal(paidOfferMode("live"), "live");
});

test("a paid purchase delivers every active deliverable in position order", async () => {
  const fixture = await seed("order");
  const second = await photo(fixture, "home", "second");
  const first = await photo(fixture, "cute", "first");
  const preview = await photo(fixture, "selfie", "preview");
  await assign(fixture.offerId, preview.id, "PREVIEW", 0);
  await assign(fixture.offerId, second.id, "DELIVERABLE", 2);
  await assign(fixture.offerId, first.id, "DELIVERABLE", 1);
  const sent: string[] = [];
  try {
    const payment = await pay(fixture);
    const stage = await prisma.user.findUniqueOrThrow({ where: { id: fixture.userId }, select: { relationshipStage: true, interactionDynamic: true } });
    const result = await fulfillPaidContent({
      paymentId: payment.id,
      sendPhoto: async (input) => {
        assert.equal(input.businessConnectionId, fixture.connectionId);
        assert.equal(input.chatId, fixture.telegramUserId);
        sent.push(input.mediaAssetId);
        return { telegramMessageId: `tg-${sent.length}` };
      },
    });
    assert.equal(result.status, "fulfilled");
    assert.deepEqual(sent, [first.id, second.id]);
    const rows = await prisma.paidContentDelivery.findMany({
      where: { paymentId: payment.id },
      orderBy: { position: "asc" },
    });
    assert.deepEqual(rows.map((row) => row.mediaAssetId), [first.id, second.id]);
    assert.deepEqual(rows.map((row) => row.position), [1, 2]);
    assert.equal(rows.every((row) => row.telegramMessageId), true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: fixture.userId }, select: { relationshipStage: true, interactionDynamic: true } });
    assert.equal(after.relationshipStage, stage.relationshipStage);
    assert.equal(after.interactionDynamic, stage.interactionDynamic);
    assert.equal(await hasPurchasedOffer(fixture.userId, fixture.offerId), true);
    assert.equal(await executePaidOffer({
      mode: "live",
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      triggerKey: `again-${fixture.userId}`,
      offerId: fixture.offerId,
      confidence: 0.95,
      emotionalState: "NORMAL",
      declinedNow: false,
      userTexts: ["private photos"],
      createInvoiceLink: async () => "https://t.me/invoice/should-not",
      sendOffer: async () => ({ telegramMessageId: "nope" }),
    }), "already_purchased");
  } finally {
    await fixture.cleanup();
  }
});

test("a duplicate successful payment does not send the same deliverable twice", async () => {
  const fixture = await seed("dup");
  const asset = await photo(fixture, "cute", "once");
  await assign(fixture.offerId, asset.id, "DELIVERABLE", 1);
  const payload = `dup${fixture.telegramUserId.slice(-12)}`;
  let sends = 0;
  try {
    await prisma.paymentIntent.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.userId,
        conversationId: fixture.conversationId,
        offerId: fixture.offerId,
        amount: 180,
        currency: "XTR",
        providerInvoicePayload: payload,
      },
    });
    const charge = {
      currency: "XTR",
      total_amount: 180,
      invoice_payload: payload,
      telegram_payment_charge_id: `charge-${fixture.telegramUserId}`,
    };
    assert.equal(await handleSuccessfulPayment({ payment: charge, telegramUserId: fixture.telegramUserId }), "recorded");
    const payment = await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: charge.telegram_payment_charge_id } });
    const send = async () => {
      sends += 1;
      return { telegramMessageId: "once" };
    };
    assert.equal((await fulfillPaidContent({ paymentId: payment.id, sendPhoto: send })).status, "fulfilled");
    assert.equal(await handleSuccessfulPayment({ payment: charge, telegramUserId: fixture.telegramUserId }), "duplicate");
    assert.equal((await fulfillPaidContent({ paymentId: payment.id, sendPhoto: send })).status, "fulfilled");
    assert.equal(sends, 1);
    assert.equal(await prisma.paidContentDelivery.count({ where: { paymentId: payment.id } }), 1);
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a failed send is not recorded and a retry finishes the rest in order", async () => {
  const fixture = await seed("retry");
  const first = await photo(fixture, "cute", "a");
  const second = await photo(fixture, "home", "b");
  await assign(fixture.offerId, first.id, "DELIVERABLE", 1);
  await assign(fixture.offerId, second.id, "DELIVERABLE", 2);
  const sent: string[] = [];
  try {
    const payment = await pay(fixture);
    const firstPass = await fulfillPaidContent({
      paymentId: payment.id,
      sendPhoto: async (input) => {
        sent.push(input.mediaAssetId);
        if (input.mediaAssetId === second.id) throw new Error("telegram down");
        return { telegramMessageId: "ok-1" };
      },
    });
    assert.equal(firstPass.status, "incomplete");
    assert.deepEqual(sent, [first.id, second.id]);
    const stored = await prisma.paidContentDelivery.findMany({ where: { paymentId: payment.id } });
    assert.deepEqual(stored.map((row) => row.mediaAssetId), [first.id]);
    const secondPass = await fulfillPaidContent({
      paymentId: payment.id,
      sendPhoto: async (input) => {
        sent.push(`retry:${input.mediaAssetId}`);
        return { telegramMessageId: "ok-2" };
      },
    });
    assert.equal(secondPass.status, "fulfilled");
    assert.deepEqual(sent, [first.id, second.id, `retry:${second.id}`]);
    const finalRows = await prisma.paidContentDelivery.findMany({ where: { paymentId: payment.id }, orderBy: { position: "asc" } });
    assert.deepEqual(finalRows.map((row) => row.mediaAssetId), [first.id, second.id]);
  } finally {
    await fixture.cleanup();
  }
});

test("missing, inactive, preview, and other-offer media are not delivered", async () => {
  const fixture = await seed("filter");
  const other = await prisma.paymentOffer.create({
    data: {
      slug: `other-${fixture.telegramUserId}`,
      title: "Other",
      description: "no",
      kind: "PAID_CONTENT",
      active: true,
    },
  });
  const preview = await photo(fixture, "selfie", "prev");
  const inactiveRow = await photo(fixture, "work", "inactive-row");
  const inactiveAsset = await photo(fixture, "casual", "inactive-asset");
  const wrong = await photo(fixture, "cute", "wrong");
  await assign(fixture.offerId, preview.id, "PREVIEW", 1);
  const inactive = await assign(fixture.offerId, inactiveRow.id, "DELIVERABLE", 2);
  await prisma.paymentOfferMedia.update({ where: { id: inactive.id }, data: { active: false } });
  await assign(fixture.offerId, inactiveAsset.id, "DELIVERABLE", 3);
  await prisma.mediaAsset.update({ where: { id: inactiveAsset.id }, data: { active: false } });
  await assign(other.id, wrong.id, "DELIVERABLE", 1);
  const sent: string[] = [];
  try {
    const empty = await pay(fixture, "empty");
    const none = await fulfillPaidContent({
      paymentId: empty.id,
      sendPhoto: async () => {
        sent.push("nope");
        return { telegramMessageId: "x" };
      },
    });
    assert.equal(none.status, "nothing_to_deliver");
    assert.deepEqual(sent, []);
    assert.equal(await prisma.paidContentDelivery.count({ where: { paymentId: empty.id } }), 0);
  } finally {
    await prisma.paymentOfferMedia.deleteMany({ where: { offerId: other.id } });
    await prisma.paymentOffer.delete({ where: { id: other.id } });
    await fixture.cleanup();
  }
});

test("fulfillment refuses a conversation without a business connection", async () => {
  const fixture = await seed("nobiz");
  const asset = await photo(fixture, "cute", "biz");
  await assign(fixture.offerId, asset.id, "DELIVERABLE", 1);
  let sends = 0;
  try {
    await prisma.conversation.update({ where: { id: fixture.conversationId }, data: { businessConnectionId: null } });
    const payment = await pay(fixture);
    const result = await fulfillPaidContent({
      paymentId: payment.id,
      sendPhoto: async () => {
        sends += 1;
        return { telegramMessageId: "no" };
      },
    });
    assert.equal(result.status, "missing_business");
    assert.equal(sends, 0);
    assert.equal(await prisma.paidContentDelivery.count({ where: { paymentId: payment.id } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("an already fulfilled payment is not sent again", async () => {
  const fixture = await seed("done");
  const asset = await photo(fixture, "cute", "done");
  await assign(fixture.offerId, asset.id, "DELIVERABLE", 1);
  let sends = 0;
  try {
    const payment = await pay(fixture);
    const send = async () => {
      sends += 1;
      return { telegramMessageId: "done" };
    };
    await fulfillPaidContent({ paymentId: payment.id, sendPhoto: send });
    const again = await fulfillPaidContent({ paymentId: payment.id, sendPhoto: send });
    assert.equal(again.status, "fulfilled");
    assert.equal(sends, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("parallel fulfillment of one payment sends each deliverable once", async () => {
  const fixture = await seed("parallel");
  const asset = await photo(fixture, "cute", "par");
  await assign(fixture.offerId, asset.id, "DELIVERABLE", 1);
  let sends = 0;
  try {
    const payment = await pay(fixture);
    const send = async () => {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { telegramMessageId: `p-${sends}` };
    };
    const [first, second] = await Promise.all([
      fulfillPaidContent({ paymentId: payment.id, sendPhoto: send }),
      fulfillPaidContent({ paymentId: payment.id, sendPhoto: send }),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "fulfilled");
    assert.equal(sends, 1);
    assert.equal(await prisma.paidContentDelivery.count({ where: { paymentId: payment.id } }), 1);
  } finally {
    await fixture.cleanup();
  }
});

test("free media cannot select a locked deliverable", async () => {
  const fixture = await seed("free");
  const asset = await photo(fixture, "cute", "locked");
  await assign(fixture.offerId, asset.id, "DELIVERABLE", 1);
  try {
    assert.equal(isFreePhotoEligible({ active: true, availability: "LOCKED", deliverable: true }), false);
    const found = await prisma.mediaAsset.findFirst({
      where: freeSelectableAssetWhere({ id: asset.id }),
    });
    assert.equal(found, null);
  } finally {
    await fixture.cleanup();
  }
});

test("owner fulfillment commands stay private and do not create a payment", async () => {
  const fixture = await seed("owner");
  const asset = await photo(fixture, "cute", "owner");
  await assign(fixture.offerId, asset.id, "DELIVERABLE", 1);
  const owner = "424242";
  try {
    assert.equal(classifyPaidFulfillmentCommand(command("7", `/paid_fulfillment ${fixture.telegramUserId}`), owner), null);
    assert.equal(classifyPaidFulfillmentCommand(command(owner, `/paid_delivery_test ${fixture.telegramUserId} ${fixture.slug}`, "biz"), owner), null);
    const inspect = classifyPaidFulfillmentCommand(command(owner, `/paid_fulfillment ${fixture.telegramUserId}`), owner);
    assert.equal(inspect?.kind, "inspect");
    const trial = classifyPaidFulfillmentCommand(command(owner, `/paid_delivery_test ${fixture.telegramUserId} ${fixture.slug}`), owner);
    assert.equal(trial?.kind, "test");
    const replies: string[] = [];
    await processPaidFulfillmentCommand(command(owner, `/paid_delivery_test ${fixture.telegramUserId} ${fixture.slug}`), owner, {
      sendOwner: async (_chat, text) => {
        replies.push(text);
      },
    });
    assert.match(replies[0] ?? "", /No payment was created/);
    assert.match(replies[0] ?? "", new RegExp(asset.category));
    assert.equal((replies[0] ?? "").includes(asset.telegramFileId), false);
    assert.equal((replies[0] ?? "").includes("free/"), false);
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 0);
    const payment = await pay(fixture);
    await fulfillPaidContent({
      paymentId: payment.id,
      sendPhoto: async () => ({ telegramMessageId: "owner-sent" }),
    });
    await processPaidFulfillmentCommand(command(owner, `/paid_fulfillment ${fixture.telegramUserId}`), owner, {
      sendOwner: async (_chat, text) => {
        replies.push(text);
      },
    });
    assert.match(replies[1] ?? "", /Delivered: 1/);
    assert.equal((replies[1] ?? "").includes("owner-sent"), false);
    assert.equal((replies[1] ?? "").includes(asset.telegramFileId), false);
  } finally {
    await fixture.cleanup();
  }
});

async function pay(fixture: Fixture, suffix = "pay") {
  const intent = await prisma.paymentIntent.create({
    data: {
      provider: "TELEGRAM_STARS",
      userId: fixture.userId,
      conversationId: fixture.conversationId,
      offerId: fixture.offerId,
      status: "PAID",
      amount: 180,
      currency: "XTR",
      providerInvoicePayload: `payload-${fixture.userId}-${suffix}`,
      paidAt: new Date(),
    },
  });
  return prisma.payment.create({
    data: {
      provider: "TELEGRAM_STARS",
      userId: fixture.userId,
      offerId: fixture.offerId,
      intentId: intent.id,
      amount: 180,
      currency: "XTR",
      status: "PAID",
      providerPaymentId: `charge-${fixture.userId}-${suffix}`,
      paidAt: new Date(),
    },
  });
}

async function assign(offerId: string, mediaAssetId: string, role: "PREVIEW" | "DELIVERABLE", position: number) {
  return prisma.paymentOfferMedia.create({
    data: { offerId, mediaAssetId, role, position, active: true },
  });
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
      availability: "LOCKED",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
}

type Fixture = {
  userId: string;
  telegramUserId: string;
  conversationId: string;
  connectionId: string;
  offerId: string;
  slug: string;
  cleanup: () => Promise<void>;
};

async function seed(label: string): Promise<Fixture> {
  const telegramUserId = String(7_400_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const connectionId = `conn-${telegramUserId}`;
  const slug = `set-${label}-${telegramUserId}`;
  const user = await prisma.user.create({ data: { telegramUserId, firstName: "Test", relationshipStage: "NEW" } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: connectionId,
      active: true,
    },
  });
  const offer = await prisma.paymentOffer.create({
    data: {
      slug,
      title: "Set",
      description: "private",
      kind: "PAID_CONTENT",
      active: true,
      prices: { create: { provider: "TELEGRAM_STARS", amount: 180, currency: "XTR", active: true } },
    },
  });
  return {
    userId: user.id,
    telegramUserId,
    conversationId: conversation.id,
    connectionId,
    offerId: offer.id,
    slug,
    cleanup: async () => {
      await prisma.paidContentDelivery.deleteMany({ where: { userId: user.id } });
      await prisma.paidOfferExecution.deleteMany({ where: { userId: user.id } });
      await prisma.payment.deleteMany({ where: { userId: user.id } });
      await prisma.paymentIntent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
      await prisma.paymentOfferMedia.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOfferPrice.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOffer.delete({ where: { id: offer.id } }).catch(() => undefined);
      await prisma.mediaAsset.deleteMany({ where: { telegramFileUniqueId: { contains: user.id } } });
    },
  };
}

function command(id: string, text: string, business?: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      business_connection_id: business,
      chat: { id: Number(id), type: "private" },
      from: { id: Number(id), is_bot: false },
      text,
    },
  };
}
