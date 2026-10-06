import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@/lib/db/prisma";
import { writeFreePhoto, removeFreePhoto } from "@/services/media/library";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { processTextBurst } from "@/services/messageProcessor/runTurn";
import { hasPurchasedOffer } from "@/services/payments/offers";
import {
  classifyOfferHistoryCommand,
  classifyPaidOfferTestCommand,
  executePaidOffer,
  paidOfferButtonLabel,
  paidOfferMode,
  paidOfferPresentation,
  processOfferHistoryCommand,
  processPaidOfferTestCommand,
  type PaidOfferSend,
} from "@/services/payments/paidOffer";
import { observeSalesTurn } from "@/services/sales/observe";
import { handlePurchasedPaidMedia, handleSuccessfulPayment } from "@/services/payments/telegramStars";
import { freeSelectableAssetWhere } from "@/services/media/eligibility";
import { TelegramRequestError } from "@/lib/telegram/client";
import type { StarsInvoiceLinkRequest } from "@/lib/telegram/client";

const INVOICE = "https://t.me/invoice/paid-offer-secret";

test("paid offer mode is live only for the exact value", () => {
  assert.equal(paidOfferMode("live"), "live");
  assert.equal(paidOfferMode("LIVE"), "shadow");
  assert.equal(paidOfferMode("shadow"), "shadow");
  assert.equal(paidOfferMode(""), "shadow");
  assert.equal(paidOfferMode("off"), "shadow");
});

test("presentation uses the supplied title, description, and star amount", () => {
  const ru = paidOfferPresentation({
    title: "Shower time 💋",
    description: "2 private photos",
    amount: 180,
    language: "ru",
  });
  assert.equal(ru.text, "🔒 Shower time 💋\n2 private photos");
  assert.equal(ru.buttonText, "⭐ Открыть за 180 Stars");
  assert.equal(paidOfferButtonLabel("en", 180), "⭐ Unlock for 180 Stars");
  assert.equal(paidOfferButtonLabel("es", 180), "⭐ Desbloquear por 180 Stars");
  assert.equal(ru.text.includes("http"), false);
  assert.equal(ru.buttonText.includes("http"), false);
  assert.equal(ru.text.includes("180"), false);
});

test("shadow paid offer stores the decision and does not present", async () => {
  const fixture = await seedOffer("shadow");
  const sent: string[] = [];
  try {
    await observeSalesTurn(turn(fixture, "do you have any private pics?"), {
      mode: "shadow",
      paidOfferMode: "shadow",
      freeMediaMode: "shadow",
      tipMode: "shadow",
      loadCatalog: async () => catalogFor(fixture),
      sendPaidOffer: async () => {
        sent.push("offer");
        return { telegramMessageId: "should-not-send" };
      },
    });
    const decision = await prisma.salesDecision.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(decision.decision, "PAID_OFFER");
    assert.equal(decision.mode, "SHADOW");
    assert.equal(sent.length, 0);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId, type: "SHOWN" } }), 0);
    assert.equal(await prisma.paidOfferExecution.count({ where: { userId: fixture.userId } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a live paid offer is presented after Amy's reply", async () => {
  const fixture = await seedOffer("order");
  const events: string[] = [];
  try {
    await prisma.message.create({
      data: {
        conversationId: fixture.conversationId,
        userId: fixture.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "у тебя есть приватные фото?",
        telegramMessageId: `${fixture.userId}-burst`,
        metadata: { kind: "text", processed: false },
      },
    });
    await processTextBurst(fixture.userId, {
      generate: async () => ["есть кое-что более личное"],
      send: async () => {
        events.push("reply");
        return { messageId: "amy-reply" };
      },
      sleep: async () => undefined,
      delayMs: () => 0,
      observeSales: async (input) => {
        events.push("observe");
        const stored = await prisma.message.findFirst({
          where: { userId: fixture.userId, direction: "OUTBOUND" },
          select: { text: true },
        });
        assert.equal(stored?.text, "есть кое-что более личное");
        await observeSalesTurn(input, {
          mode: "shadow",
          paidOfferMode: "live",
          freeMediaMode: "shadow",
          tipMode: "shadow",
          loadCatalog: async () => catalogFor(fixture),
          createPaidInvoice: invoiceChecker(),
          sendPaidOffer: async (delivery) => {
            events.push("offer");
            assert.equal(delivery.caption.includes("http"), false);
            assert.equal(delivery.caption, "Night set");
            assert.equal(delivery.starCount, 180);
            assert.equal(delivery.media.length, 1);
            assert.equal(delivery.businessConnectionId, fixture.connectionId);
            return { telegramMessageId: "offer-1" };
          },
        });
      },
    });
    assert.deepEqual(events, ["reply", "observe", "offer"]);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId, type: "SHOWN" } }), 1);
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(intent.status, "PENDING");
    assert.equal(intent.amount, 180);
  } finally {
    await fixture.cleanup();
  }
});

test("paid media send failure does not show the offer or leave a payable intent", async () => {
  const fixture = await seedOffer("invoice");
  try {
    const outcome = await executePaidOffer(liveInput(fixture, {
      sendOffer: async () => {
        throw new TelegramRequestError("Telegram sendPaidMedia failed", 400, false, "Bad Request: BUSINESS_PEER_USAGE_MISSING");
      },
    }));
    assert.equal(outcome, "send_failed");
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(intent.status, "CANCELLED");
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId } }), 0);
    assert.equal((await prisma.paidOfferExecution.findFirstOrThrow({ where: { userId: fixture.userId } })).status, "FAILED");
  } finally {
    await fixture.cleanup();
  }
});

test("presentation failure does not show the offer and can be retried", async () => {
  const fixture = await seedOffer("send");
  let attempts = 0;
  try {
    const failed = await executePaidOffer(liveInput(fixture, {
      createInvoiceLink: async () => INVOICE,
      sendOffer: async () => {
        attempts += 1;
        throw new Error("business send failed");
      },
    }));
    assert.equal(failed, "send_failed");
    assert.equal(attempts, 1);
    const cancelled = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: fixture.userId } });
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId } }), 0);

    const sent = await executePaidOffer(liveInput(fixture, {
      createInvoiceLink: invoiceChecker(),
      sendOffer: async (delivery) => {
        attempts += 1;
        assert.equal(delivery.caption.includes("http"), false);
        assert.equal(delivery.starCount, 180);
        return { telegramMessageId: "offer-retry" };
      },
    }));
    assert.equal(sent, "sent");
    assert.equal(attempts, 2);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId, type: "SHOWN" } }), 1);
    const statuses = (await prisma.paymentIntent.findMany({ where: { userId: fixture.userId } })).map((row) => row.status).sort();
    assert.deepEqual(statuses, ["CANCELLED", "PENDING"]);
  } finally {
    await fixture.cleanup();
  }
});

test("one trigger presents once, including concurrent callers", async () => {
  const fixture = await seedOffer("once");
  let sends = 0;
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sendOffer: PaidOfferSend = async (delivery) => {
    sends += 1;
    assert.equal(delivery.caption.includes("http"), false);
    if (sends === 1) await hold;
    return { telegramMessageId: "offer-once" };
  };
  try {
    const pending = Promise.all([
      executePaidOffer(liveInput(fixture, { createInvoiceLink: invoiceChecker(), sendOffer })),
      executePaidOffer(liveInput(fixture, { createInvoiceLink: invoiceChecker(), sendOffer })),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [first, second] = await pending;
    assert.deepEqual([first, second].sort(), ["duplicate", "sent"]);
    assert.equal(sends, 1);
    const again = await executePaidOffer(liveInput(fixture, { createInvoiceLink: invoiceChecker(), sendOffer }));
    assert.equal(again, "duplicate");
    assert.equal(sends, 1);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId, type: "SHOWN" } }), 1);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 1);
  } finally {
    release();
    await fixture.cleanup();
  }
});

test("a presented card can be completed after a crash without sending it again", async () => {
  const fixture = await seedOffer("crash");
  let sends = 0;
  try {
    await executePaidOffer(liveInput(fixture, {
      createInvoiceLink: async () => INVOICE,
      sendOffer: async () => {
        sends += 1;
        return { telegramMessageId: "offer-crash" };
      },
    }));
    await prisma.userOfferInteraction.deleteMany({ where: { userId: fixture.userId } });
    await prisma.paidOfferExecution.updateMany({
      where: { userId: fixture.userId },
      data: { status: "CLAIMED" },
    });
    const outcome = await executePaidOffer(liveInput(fixture, {
      createInvoiceLink: async () => {
        throw new Error("should reuse the sent card");
      },
      sendOffer: async () => {
        sends += 1;
        return { telegramMessageId: "offer-again" };
      },
    }));
    assert.equal(outcome, "sent");
    assert.equal(sends, 1);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId, type: "SHOWN" } }), 1);
  } finally {
    await fixture.cleanup();
  }
});

test("an already purchased offer is not presented", async () => {
  const fixture = await seedOffer("bought");
  try {
    const intent = await prisma.paymentIntent.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.userId,
        conversationId: fixture.conversationId,
        offerId: fixture.offerId,
        status: "PAID",
        amount: 180,
        currency: "XTR",
        providerInvoicePayload: `paid-${fixture.userId}`,
        paidAt: new Date(),
      },
    });
    await prisma.payment.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.userId,
        offerId: fixture.offerId,
        intentId: intent.id,
        amount: 180,
        currency: "XTR",
        status: "PAID",
        providerPaymentId: `charge-${fixture.userId}`,
        paidAt: new Date(),
      },
    });
    const outcome = await executePaidOffer(liveInput(fixture, {
      createInvoiceLink: async () => INVOICE,
      sendOffer: async () => ({ telegramMessageId: "nope" }),
    }));
    assert.equal(outcome, "already_purchased");
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 1);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId, type: "SHOWN" } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("shown and declined interactions suppress another paid offer", async () => {
  const fixture = await seedOffer("cooldown");
  const otherA = await extraOffer("other-a");
  const otherB = await extraOffer("other-b");
  const now = new Date("2026-09-28T18:00:00.000Z");
  try {
    await show(fixture, fixture.offerId, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
    assert.equal(await executePaidOffer(liveInput(fixture, { now })), "recent_same_offer");

    await prisma.userOfferInteraction.deleteMany({ where: { userId: fixture.userId } });
    await prisma.paidOfferExecution.deleteMany({ where: { userId: fixture.userId } });
    await show(fixture, otherA, new Date(now.getTime() - 60 * 60 * 1000));
    assert.equal(await executePaidOffer(liveInput(fixture, { now, triggerKey: `${fixture.trigger}-b` })), "recent_paid_offer");

    await prisma.userOfferInteraction.deleteMany({ where: { userId: fixture.userId } });
    await prisma.paidOfferExecution.deleteMany({ where: { userId: fixture.userId } });
    await show(fixture, otherA, new Date(now.getTime() - 5 * 60 * 60 * 1000));
    await show(fixture, otherB, new Date(now.getTime() - 6 * 60 * 60 * 1000));
    assert.equal(await executePaidOffer(liveInput(fixture, { now, triggerKey: `${fixture.trigger}-c` })), "paid_daily_cap");

    await prisma.userOfferInteraction.deleteMany({ where: { userId: fixture.userId } });
    await prisma.paidOfferExecution.deleteMany({ where: { userId: fixture.userId } });
    await prisma.userOfferInteraction.create({
      data: {
        userId: fixture.userId,
        offerId: fixture.offerId,
        conversationId: fixture.conversationId,
        type: "DECLINED",
        source: "SALES_ENGINE",
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    });
    assert.equal(await executePaidOffer(liveInput(fixture, { now, triggerKey: `${fixture.trigger}-d` })), "user_declined");
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId, type: "SHOWN" } }), 0);
  } finally {
    await fixture.cleanup();
    await prisma.paymentOfferPrice.deleteMany({ where: { offerId: { in: [otherA, otherB] } } });
    await prisma.paymentOffer.deleteMany({ where: { id: { in: [otherA, otherB] } } });
  }
});

test("distress, ordinary photos, premium photos, and tips stay on their own paths", async () => {
  const fixture = await seedOffer("routes");
  const asset = await prisma.mediaAsset.create({
    data: {
      telegramFileId: `file-${fixture.userId}`,
      telegramFileUniqueId: `unique-${fixture.userId}`,
      storagePath: `free/${fixture.userId}.jpg`,
      mediaType: "PHOTO",
      category: "casual",
      description: "ordinary",
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
  const paidSends: string[] = [];
  const sendPaidOffer: PaidOfferSend = async () => {
    paidSends.push("paid");
    return { telegramMessageId: "paid" };
  };
  try {
    await observeSalesTurn(turn(fixture, "I want to die. do you have any private pics?"), liveObserve(fixture, sendPaidOffer, asset.id));
    assert.equal(paidSends.length, 0);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 0);

    await observeSalesTurn(turn(fixture, "send me a pic"), liveObserve(fixture, sendPaidOffer, asset.id));
    const freeDecision = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: fixture.userId, decision: "FREE_MEDIA" },
    });
    assert.equal(freeDecision.decision, "FREE_MEDIA");
    assert.equal(paidSends.length, 0);

    await observeSalesTurn(turn(fixture, "do you have any private pics?"), liveObserve(fixture, sendPaidOffer, asset.id));
    assert.equal(paidSends.length, 1);
    const paid = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: fixture.userId, decision: "PAID_OFFER" },
    });
    assert.equal(paid.candidateOfferId, fixture.offerId);
    assert.equal(await prisma.mediaSent.count({ where: { userId: fixture.userId } }), 0);

    paidSends.length = 0;
    await observeSalesTurn(turn(fixture, "I want to leave you a tip"), liveObserve(fixture, sendPaidOffer, asset.id));
    const tip = await prisma.salesDecision.findFirstOrThrow({
      where: { userId: fixture.userId, decision: "TIP" },
    });
    assert.equal(tip.decision, "TIP");
    assert.equal(paidSends.length, 0);
  } finally {
    await fixture.cleanup();
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
  }
});

test("direct distress does not create an intent", async () => {
  const fixture = await seedOffer("distress");
  try {
    const outcome = await executePaidOffer(liveInput(fixture, { emotionalState: "DISTRESSED" }));
    assert.equal(outcome, "distress");
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.userOfferInteraction.count({ where: { userId: fixture.userId } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("paid offer owner commands are private and owner-only", async () => {
  const owner = uniqueId();
  const customer = uniqueId();
  assert.equal(classifyPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${customer}`), ""), null);
  assert.equal(classifyPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${customer}`), "999"), null);
  assert.equal(classifyPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${customer} shower-time`), owner)?.slug, "shower-time");
  assert.equal(classifyPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${customer} shower-time`), owner)?.force, false);
  assert.equal(classifyPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${customer} shower-time --force`), owner)?.force, true);
  assert.equal(classifyPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${customer} shower-time --FORCE`), owner), null);
  assert.equal(classifyPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${customer}`), owner)?.slug, null);
  assert.equal(classifyOfferHistoryCommand(commandUpdate(owner, `/offer_history ${customer}`), owner)?.telegramUserId, customer);
  assert.equal(classifyOfferHistoryCommand(commandUpdate("7", `/offer_history ${customer}`), owner), null);
  const business = commandUpdate(owner, `/paid_offer_test ${customer}`);
  business.message = { ...business.message!, business_connection_id: "conn" };
  assert.equal(classifyPaidOfferTestCommand(business, owner), null);
  const businessForce = commandUpdate(owner, `/paid_offer_test ${customer} shower-time --force`);
  businessForce.message = { ...businessForce.message!, business_connection_id: "conn" };
  assert.equal(classifyPaidOfferTestCommand(businessForce, owner), null);

  const replies: string[] = [];
  await processPaidOfferTestCommand(commandUpdate("7", `/paid_offer_test ${customer}`), owner, {
    sendOwner: async (_chatId, text) => {
      replies.push(text);
    },
  });
  await processOfferHistoryCommand(commandUpdate(owner, `/offer_history ${customer}`), owner, {
    sendOwner: async (_chatId, text) => {
      replies.push(text);
    },
  });
  assert.deepEqual(replies, ["No paid offer history."]);
});

test("owner test presents through the business path and history stays safe", async () => {
  const owner = uniqueId();
  const fixture = await seedOffer("owner");
  const secretPayload = `payload-do-not-show-${fixture.userId}`;
  try {
    await prisma.message.create({
      data: {
        conversationId: fixture.conversationId,
        userId: fixture.userId,
        direction: "INBOUND",
        sender: "USER",
        type: "TEXT",
        text: "у тебя есть приватные фото?",
        telegramMessageId: `${fixture.userId}-owner`,
      },
    });
    const replies: string[] = [];
    await processPaidOfferTestCommand(commandUpdate(owner, `/paid_offer_test ${fixture.telegramUserId} ${fixture.slug}`), owner, {
      sendOwner: async (_chatId, text) => {
        replies.push(text);
      },
      sendOffer: async (delivery) => {
        assert.equal(delivery.businessConnectionId, fixture.connectionId);
        assert.equal(delivery.chatId, fixture.telegramUserId);
        assert.equal(delivery.starCount, 180);
        assert.equal(delivery.caption.includes("http"), false);
        assert.equal(delivery.media.length, 1);
        return { telegramMessageId: "owner-offer" };
      },
    });
    assert.equal(replies.length, 1);
    assert.match(replies[0] ?? "", new RegExp(`Sent\\.\\n${fixture.slug}\\nNight set\\n180 XTR`));
    assert.equal((replies[0] ?? "").includes("http"), false);
    assert.equal((replies[0] ?? "").includes(secretPayload), false);
    const shown = await prisma.userOfferInteraction.findFirstOrThrow({ where: { userId: fixture.userId, type: "SHOWN" } });
    assert.equal(shown.source, "OWNER_TEST");
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 0);

    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: fixture.userId } });
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { providerInvoicePayload: secretPayload },
    });
    const recorded = await handleSuccessfulPayment({
      telegramUserId: fixture.telegramUserId,
      payment: {
        currency: "XTR",
        total_amount: 180,
        invoice_payload: secretPayload,
        telegram_payment_charge_id: secretPayload,
      },
    });
    const duplicate = await handleSuccessfulPayment({
      telegramUserId: fixture.telegramUserId,
      payment: {
        currency: "XTR",
        total_amount: 180,
        invoice_payload: secretPayload,
        telegram_payment_charge_id: secretPayload,
      },
    });
    assert.equal(recorded, "recorded");
    assert.equal(duplicate, "duplicate");
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId, status: "PAID" } }), 1);
    assert.equal((await prisma.paymentIntent.findFirstOrThrow({ where: { id: intent.id } })).status, "PAID");
    assert.equal(await hasPurchasedOffer(fixture.userId, fixture.offerId), true);

    await processOfferHistoryCommand(commandUpdate(owner, `/offer_history ${fixture.telegramUserId}`), owner, {
      sendOwner: async (_chatId, text) => {
        replies.push(text);
      },
    });
    const history = replies[1] ?? "";
    assert.match(history, /SHOWN/);
    assert.match(history, /PAID/);
    assert.match(history, new RegExp(fixture.slug));
    assert.match(history, /180 XTR/);
    assert.match(history, /Cancun/);
    assert.equal(history.includes(secretPayload), false);
    assert.equal(history.includes("http"), false);
    assert.equal(history.includes(intent.id), false);
  } finally {
    await fixture.cleanup();
  }
});

test("normal paid offer test stays blocked by recent_same_offer", async () => {
  const owner = uniqueId();
  const fixture = await seedOffer("force-blocked");
  const now = new Date("2026-09-30T18:00:00.000Z");
  const sends: string[] = [];
  try {
    await show(fixture, fixture.offerId, new Date(now.getTime() - 60 * 60 * 1000));
    const replies: string[] = [];
    await processPaidOfferTestCommand(
      commandUpdate(owner, `/paid_offer_test ${fixture.telegramUserId} ${fixture.slug}`),
      owner,
      {
        now,
        sendOwner: async (_chatId, text) => {
          replies.push(text);
        },
        createInvoiceLink: async () => {
          throw new Error("invoice should not be created");
        },
        sendOffer: async () => {
          sends.push("sent");
          return { telegramMessageId: "blocked" };
        },
      },
    );
    assert.equal(replies[0], "Not sent.\nrecent_same_offer");
    assert.equal(sends.length, 0);
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(
      await executePaidOffer(liveInput(fixture, {
        bypassShownCooldown: true,
        source: "SALES_ENGINE",
        triggerKey: `${fixture.trigger}-sales`,
        now,
      })),
      "recent_same_offer",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("forced paid offer test bypasses recent_same_offer", async () => {
  const owner = uniqueId();
  const fixture = await seedOffer("force-send");
  const now = new Date("2026-09-30T18:00:00.000Z");
  try {
    await show(fixture, fixture.offerId, new Date(now.getTime() - 60 * 60 * 1000));
    const replies: string[] = [];
    let presented = 0;
    await processPaidOfferTestCommand(
      commandUpdate(owner, `/paid_offer_test ${fixture.telegramUserId} ${fixture.slug} --force`),
      owner,
      {
        now,
        sendOwner: async (_chatId, text) => {
          replies.push(text);
        },
        createInvoiceLink: invoiceChecker(),
        sendOffer: async (delivery) => {
          presented += 1;
          assert.equal(delivery.businessConnectionId, fixture.connectionId);
          assert.equal(delivery.starCount, 180);
          assert.equal(delivery.media.length > 0, true);
          return { telegramMessageId: "forced-offer" };
        },
      },
    );
    assert.match(replies[0] ?? "", new RegExp(`Sent\\.\\n${fixture.slug}\\nNight set\\n180 XTR\\nforced`));
    assert.equal(presented, 1);
    const shown = await prisma.userOfferInteraction.findFirstOrThrow({
      where: { userId: fixture.userId, type: "SHOWN", source: "OWNER_TEST" },
    });
    assert.equal(shown.metadata && typeof shown.metadata === "object" && !Array.isArray(shown.metadata) && shown.metadata.forced, true);
    assert.equal(await executePaidOffer(liveInput(fixture, { now, triggerKey: `${fixture.trigger}-after` })), "recent_same_offer");
  } finally {
    await fixture.cleanup();
  }
});

test("forced paid offer test cannot bypass an existing purchase", async () => {
  const owner = uniqueId();
  const fixture = await seedOffer("force-bought");
  const now = new Date("2026-09-30T18:00:00.000Z");
  try {
    const intent = await prisma.paymentIntent.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.userId,
        conversationId: fixture.conversationId,
        offerId: fixture.offerId,
        status: "PAID",
        amount: 180,
        currency: "XTR",
        providerInvoicePayload: `paid-${fixture.userId}`,
        paidAt: now,
      },
    });
    await prisma.payment.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.userId,
        offerId: fixture.offerId,
        intentId: intent.id,
        amount: 180,
        currency: "XTR",
        status: "PAID",
        providerPaymentId: `charge-${fixture.userId}`,
        paidAt: now,
      },
    });
    await show(fixture, fixture.offerId, new Date(now.getTime() - 60 * 60 * 1000));
    const replies: string[] = [];
    await processPaidOfferTestCommand(
      commandUpdate(owner, `/paid_offer_test ${fixture.telegramUserId} ${fixture.slug} --force`),
      owner,
      {
        now,
        sendOwner: async (_chatId, text) => {
          replies.push(text);
        },
        createInvoiceLink: async () => INVOICE,
        sendOffer: async () => ({ telegramMessageId: "should-not-send" }),
      },
    );
    assert.equal(replies[0], "Not sent.\nalready_purchased");
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 1);
    assert.equal(await prisma.paymentIntent.count({ where: { userId: fixture.userId, status: "PENDING" } }), 0);
    assert.equal(await prisma.paidContentDelivery.count({ where: { userId: fixture.userId } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("forced paid offer test does not fake a payment or deliver content", async () => {
  const owner = uniqueId();
  const fixture = await seedOffer("force-unpaid");
  const now = new Date("2026-09-30T18:00:00.000Z");
  const asset = await prisma.mediaAsset.create({
    data: {
      telegramFileId: `file-${fixture.userId}`,
      telegramFileUniqueId: `unique-${fixture.userId}`,
      storagePath: `free/${fixture.userId}.jpg`,
      mediaType: "PHOTO",
      category: "flirty",
      description: "deliverable",
      tags: ["private"],
      mood: "playful",
      flirtLevel: 4,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["private_photos"],
      availability: "LOCKED",
      active: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  await prisma.paymentOfferMedia.create({
    data: { offerId: fixture.offerId, mediaAssetId: asset.id, role: "DELIVERABLE", position: 1, active: true },
  });
  try {
    await show(fixture, fixture.offerId, new Date(now.getTime() - 60 * 60 * 1000));
    let presented = 0;
    await processPaidOfferTestCommand(
      commandUpdate(owner, `/paid_offer_test ${fixture.telegramUserId} ${fixture.slug} --force`),
      owner,
      {
        now,
        sendOwner: async () => undefined,
        createInvoiceLink: invoiceChecker(),
        sendOffer: async () => {
          presented += 1;
          return { telegramMessageId: "card-only" };
        },
      },
    );
    assert.equal(presented, 1);
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: fixture.userId, offerId: fixture.offerId } });
    assert.equal(intent.status, "PENDING");
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await prisma.paidContentDelivery.count({ where: { userId: fixture.userId } }), 0);
    assert.equal(await hasPurchasedOffer(fixture.userId, fixture.offerId), false);
  } finally {
    await fixture.cleanup();
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
  }
});

test("native paid media sends deliverables in order and records one purchase", async () => {
  const fixture = await seedOffer("native420");
  const previewPath = `free/${fixture.userId}-preview.jpg`;
  const secondPath = `free/${fixture.userId}-second.jpg`;
  await prisma.paymentOfferPrice.updateMany({ where: { offerId: fixture.offerId }, data: { amount: 420 } });
  await writeFreePhoto(previewPath, Buffer.from([0xff, 0xd8, 0xff, 0xd8]));
  await writeFreePhoto(secondPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  const preview = await prisma.mediaAsset.create({
    data: {
      telegramFileId: `local-preview-${fixture.userId}`,
      telegramFileUniqueId: `local-preview-${fixture.userId}`,
      storagePath: previewPath,
      mediaType: "PHOTO",
      category: "flirty",
      description: "preview",
      tags: ["private"],
      mood: "playful",
      flirtLevel: 4,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["private_photos"],
      availability: "LOCKED",
      active: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const second = await prisma.mediaAsset.create({
    data: {
      telegramFileId: `local-second-${fixture.userId}`,
      telegramFileUniqueId: `local-second-${fixture.userId}`,
      storagePath: secondPath,
      mediaType: "PHOTO",
      category: "flirty",
      description: "second",
      tags: ["private"],
      mood: "playful",
      flirtLevel: 4,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["private_photos"],
      availability: "LOCKED",
      active: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  await prisma.paymentOfferMedia.create({
    data: { offerId: fixture.offerId, mediaAssetId: preview.id, role: "PREVIEW", position: 1, active: true },
  });
  await prisma.paymentOfferMedia.create({
    data: { offerId: fixture.offerId, mediaAssetId: second.id, role: "DELIVERABLE", position: 2, active: true },
  });
  try {
    let payload = "";
    const outcome = await executePaidOffer(liveInput(fixture, {
      sendOffer: async (delivery) => {
        payload = delivery.payload;
        assert.equal(delivery.chatId, fixture.telegramUserId);
        assert.equal(delivery.businessConnectionId, fixture.connectionId);
        assert.equal(delivery.starCount, 420);
        assert.equal(delivery.caption, "Night set");
        assert.equal(delivery.caption.includes("http"), false);
        const rows = await prisma.paymentOfferMedia.findMany({
          where: { offerId: fixture.offerId, role: "DELIVERABLE", active: true },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: { mediaAssetId: true },
        });
        assert.deepEqual(delivery.media.map((item) => item.assetId), rows.map((row) => row.mediaAssetId));
        assert.equal(delivery.media.some((item) => item.assetId === preview.id), false);
        assert.equal(delivery.media.length, 2);
        return { telegramMessageId: "native-album" };
      },
    }));
    assert.equal(outcome, "sent");
    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { userId: fixture.userId, status: "PENDING" } });
    assert.equal(intent.amount, 420);
    assert.equal(intent.currency, "XTR");
    assert.equal(intent.providerInvoicePayload, payload);
    assert.equal(Buffer.byteLength(payload) <= 128, true);
    assert.equal(await handlePurchasedPaidMedia({ telegramUserId: fixture.telegramUserId, payload }), "recorded");
    assert.equal(await handlePurchasedPaidMedia({ telegramUserId: fixture.telegramUserId, payload }), "duplicate");
    assert.equal(await handlePurchasedPaidMedia({ telegramUserId: "999", payload }), "rejected");
    assert.equal(await handlePurchasedPaidMedia({ telegramUserId: fixture.telegramUserId, payload: "not-a-real-payload" }), "rejected");
    assert.equal(await prisma.payment.count({ where: { userId: fixture.userId, status: "PAID" } }), 1);
    assert.equal(await hasPurchasedOffer(fixture.userId, fixture.offerId), true);
    assert.equal(await prisma.paidContentDelivery.count({ where: { userId: fixture.userId } }), 0);
    const deliverableIds = (await prisma.paymentOfferMedia.findMany({
      where: { offerId: fixture.offerId, role: "DELIVERABLE" },
      select: { mediaAssetId: true },
    })).map((row) => row.mediaAssetId);
    assert.equal(await prisma.mediaAsset.count({ where: freeSelectableAssetWhere({ id: { in: [...deliverableIds, preview.id] } }) }), 0);
    assert.equal(await executePaidOffer(liveInput(fixture, { triggerKey: `${fixture.trigger}-resale`, sendOffer: async () => ({ telegramMessageId: "resale" }) })), "already_purchased");
  } finally {
    await removeFreePhoto(previewPath);
    await removeFreePhoto(secondPath);
    await fixture.cleanup();
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [preview.id, second.id] } } });
  }
});

test("owner test interactions in the database do not block organic sales decisions or execution", async () => {
  const fixture = await seedOffer("owner-test-db-ignore");
  const now = new Date("2026-09-30T18:00:00.000Z");
  try {
    await prisma.userOfferInteraction.create({
      data: {
        userId: fixture.userId,
        offerId: fixture.offerId,
        conversationId: fixture.conversationId,
        type: "SHOWN",
        source: "OWNER_TEST",
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      },
    });
    await prisma.userOfferInteraction.create({
      data: {
        userId: fixture.userId,
        offerId: fixture.offerId,
        conversationId: fixture.conversationId,
        type: "SHOWN",
        source: "OWNER_TEST",
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      },
    });
    const sent = await executePaidOffer(liveInput(fixture, {
      now,
      createInvoiceLink: invoiceChecker(),
      sendOffer: async () => ({ telegramMessageId: "organic-sent" }),
    }));
    assert.equal(sent, "sent");
  } finally {
    await fixture.cleanup();
  }
});

function invoiceChecker(): (request: StarsInvoiceLinkRequest) => Promise<string> {
  return async (request) => {
    const intent = await prisma.paymentIntent.findUnique({ where: { providerInvoicePayload: request.payload } });
    assert.equal(intent?.status, "PENDING");
    assert.equal(intent?.currency, "XTR");
    assert.equal(intent?.amount, request.prices[0]?.amount);
    assert.equal(request.currency, "XTR");
    assert.equal(request.prices.length, 1);
    assert.equal(Number.isInteger(request.prices[0]?.amount), true);
    assert.equal("provider_token" in request, false);
    return INVOICE;
  };
}

function catalogFor(fixture: Fixture, assetId?: string) {
  return {
    assets: assetId
      ? [{
          id: assetId,
          category: "casual",
          tags: ["casual_selfie"],
          mood: "relaxed",
          flirtLevel: 1,
          contexts: ["casual_selfie", "at_home"],
          active: true,
        }]
      : [],
    offers: [{
      id: fixture.offerId,
      slug: fixture.slug,
      tags: ["flirty", "private_photos", "shower"],
      contexts: ["flirty", "private_photos", "shower"],
      flirtLevel: 3,
      active: true,
      hasActivePrice: true, priority: 1,
    }],
    purchasedOfferIds: [] as string[],
    interactions: [],
    priorFreeMediaAt: null,
    mediaDeliveries: [],
    dynamic: "EQUAL" as const,
    dynamicConfidence: 0.9,
  };
}

function liveObserve(fixture: Fixture, sendPaidOffer: PaidOfferSend, assetId?: string) {
  return {
    mode: "shadow" as const,
    paidOfferMode: "live" as const,
    freeMediaMode: "shadow" as const,
    tipMode: "shadow" as const,
    loadCatalog: async () => catalogFor(fixture, assetId),
    createPaidInvoice: async () => INVOICE,
    sendPaidOffer,
    sendFreePhoto: async () => {
      throw new Error("free photo should not send");
    },
  };
}

function liveInput(
  fixture: Fixture,
  extra: Partial<Parameters<typeof executePaidOffer>[0]> = {},
): Parameters<typeof executePaidOffer>[0] {
  return {
    mode: "live",
    userId: fixture.userId,
    conversationId: fixture.conversationId,
    triggerKey: fixture.trigger,
    offerId: fixture.offerId,
    confidence: 0.92,
    emotionalState: "NORMAL",
    declinedNow: false,
    userTexts: ["у тебя есть приватные фото?"],
    source: "SALES_ENGINE",
    createInvoiceLink: async () => INVOICE,
    sendOffer: async () => ({ telegramMessageId: "offer" }),
    ...extra,
  };
}

function turn(fixture: Fixture, text: string) {
  return {
    userId: fixture.userId,
    conversationId: fixture.conversationId,
    triggerMessageId: fixture.messageId,
    userTexts: [text],
    amyTexts: ["just talking"],
  };
}

type Fixture = {
  userId: string;
  telegramUserId: string;
  conversationId: string;
  connectionId: string;
  offerId: string;
  slug: string;
  trigger: string;
  messageId: string;
  cleanup: () => Promise<void>;
};

async function seedOffer(label: string): Promise<Fixture> {
  const telegramUserId = uniqueId();
  const connectionId = `conn-${label}-${telegramUserId}`;
  const slug = `night-${label}-${telegramUserId}`;
  const user = await prisma.user.create({ data: { telegramUserId, firstName: "Test" } });
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
  const storagePath = `free/${user.id}-deliverable.jpg`;
  await writeFreePhoto(storagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const asset = await prisma.mediaAsset.create({
    data: {
      telegramFileId: `local-${user.id}`,
      telegramFileUniqueId: `local-${user.id}`,
      storagePath,
      mediaType: "PHOTO",
      category: "flirty",
      description: "deliverable",
      tags: ["private"],
      mood: "playful",
      flirtLevel: 4,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["private_photos"],
      availability: "LOCKED",
      active: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  await prisma.paymentOfferMedia.create({
    data: { offerId: offer.id, mediaAssetId: asset.id, role: "DELIVERABLE", position: 1, active: true },
  });
  return {
    userId: user.id,
    telegramUserId,
    conversationId: conversation.id,
    connectionId,
    offerId: offer.id,
    slug,
    trigger: `trigger-${user.id}`,
    messageId: message.id,
    cleanup: async () => {
      await prisma.payment.deleteMany({ where: { userId: user.id } });
      await prisma.paidOfferExecution.deleteMany({ where: { userId: user.id } });
      await prisma.paymentIntent.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.paymentOfferPrice.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOffer.delete({ where: { id: offer.id } });
      await prisma.mediaAsset.delete({ where: { id: asset.id } });
      await removeFreePhoto(storagePath);
    },
  };
}

async function extraOffer(label: string): Promise<string> {
  const offer = await prisma.paymentOffer.create({
    data: {
      slug: `${label}-${uniqueId()}`,
      title: label,
      description: "other",
      kind: "PAID_CONTENT",
      tags: ["private"],
      contexts: ["private_photos"],
      flirtLevel: 2,
      active: true,
      prices: { create: { provider: "TELEGRAM_STARS", amount: 50, currency: "XTR", active: true } },
    },
  });
  return offer.id;
}

async function show(fixture: Fixture, offerId: string, createdAt: Date): Promise<void> {
  await prisma.userOfferInteraction.create({
    data: {
      userId: fixture.userId,
      offerId,
      conversationId: fixture.conversationId,
      type: "SHOWN",
      source: "SALES_ENGINE",
      createdAt,
    },
  });
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
  return String(7_200_000_000 + Math.floor(Math.random() * 1_000_000_000));
}
