import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@/lib/db/prisma";
import { starsInvoiceLinkBody } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/types";
import { hasPurchasedOffer } from "@/services/payments/offers";
import {
  classifyStarsAdminCommand,
  createStarsCheckout,
  handlePreCheckoutQuery,
  handleSuccessfulPayment,
  type StarsCheckoutDeps,
} from "@/services/payments/telegramStars";

test("only the numeric owner can start a Stars test", () => {
  const update = commandUpdate("42", "/stars_test 100");
  assert.equal(classifyStarsAdminCommand(update, ""), null);
  assert.equal(classifyStarsAdminCommand(update, "99"), null);
  assert.equal(classifyStarsAdminCommand(commandUpdate("42", "/stars_test_last"), "42")?.last, true);
  assert.equal(classifyStarsAdminCommand({ ...update, business_message: update.message, message: undefined }, "42"), null);
});

test("checkout creates the intent before the business invoice link", async () => {
  const owner = uniqueId();
  const customer = uniqueId();
  const calls: string[] = [];
  let seenPayload = "";
  const fixture = await createBusinessUser(customer, "conn-stars");
  try {
    assert.equal(await hasPurchasedOffer(fixture.userId, fixture.offerId), false);
    const result = await createStarsCheckout({
      ownerTelegramId: owner,
      telegramUserId: customer,
      useLatestBusinessConversation: false,
      deps: deps({
        createInvoiceLink: async (request) => {
          calls.push("link");
          seenPayload = request.payload;
          const intent = await prisma.paymentIntent.findUnique({ where: { providerInvoicePayload: request.payload } });
          assert.ok(intent);
          assert.equal(intent?.status, "PENDING");
          assert.equal(intent?.amount, 420);
          assert.equal(intent?.currency, "XTR");
          assert.equal(intent?.provider, "TELEGRAM_STARS");
          assert.equal(request.currency, "XTR");
          assert.equal(request.prices.length, 1);
          assert.equal(request.prices[0]?.amount, 420);
          assert.equal(request.business_connection_id, "conn-stars");
          assert.equal("provider_token" in request, false);
          assert.equal(request.payload.includes(customer), false);
          const offer = await prisma.paymentOffer.findUniqueOrThrow({ where: { id: intent!.offerId } });
          assert.equal(offer.slug, "shower-time");
          return "https://t.me/invoice/test";
        },
        sendBusinessText: async (chatId, text, businessConnectionId) => {
          calls.push("send");
          assert.equal(chatId, customer);
          assert.equal(businessConnectionId, "conn-stars");
          assert.equal(text, "https://t.me/invoice/test");
        },
      }),
    });
    assert.deepEqual(calls, ["link", "send"]);
    assert.equal(result.payload, seenPayload);
    assert.match(result.adminText, /shower-time/);
    const body = starsInvoiceLinkBody({
      businessConnectionId: "conn-stars",
      title: "Shower time",
      description: "2 private photos",
      payload: seenPayload,
      amount: 420,
    });
    assert.equal(body.currency, "XTR");
    assert.equal("provider_token" in body, false);
  } finally {
    await cleanupUser(customer);
  }
});

test("pre-checkout approves only a matching pending Stars intent", async () => {
  const customer = uniqueId();
  const fixture = await createBusinessUser(customer, "conn-check");
  const payload = `pay${customer.slice(-12)}`;
  const answers: Array<{ ok: boolean; error?: string }> = [];
  try {
    const intent = await prisma.paymentIntent.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.userId,
        conversationId: fixture.conversationId,
        offerId: fixture.offerId,
        amount: 420,
        currency: "XTR",
        providerInvoicePayload: payload,
      },
    });
    const answer = async (_id: string, ok: boolean, errorMessage?: string) => {
      answers.push({ ok, error: errorMessage });
    };
    await handlePreCheckoutQuery(query(customer, payload, 420, "XTR"), { answerPreCheckout: answer });
    await handlePreCheckoutQuery(query(customer, payload, 421, "XTR"), { answerPreCheckout: answer });
    await handlePreCheckoutQuery(query(customer, payload, 420, "USD"), { answerPreCheckout: answer });
    await handlePreCheckoutQuery(query(uniqueId(), payload, 420, "XTR"), { answerPreCheckout: answer });
    await handlePreCheckoutQuery(query(customer, "missing-payload", 420, "XTR"), { answerPreCheckout: answer });
    await prisma.paymentOffer.update({ where: { id: fixture.offerId }, data: { active: false } });
    await handlePreCheckoutQuery(query(customer, payload, 420, "XTR"), { answerPreCheckout: answer });
    await prisma.paymentOffer.update({ where: { id: fixture.offerId }, data: { active: true } });
    await prisma.paymentOfferPrice.update({ where: { id: fixture.priceId }, data: { active: false } });
    await handlePreCheckoutQuery(query(customer, payload, 420, "XTR"), { answerPreCheckout: answer });
    await prisma.paymentOfferPrice.update({ where: { id: fixture.priceId }, data: { active: true } });
    assert.deepEqual(
      answers.map((item) => item.ok),
      [true, false, false, false, false, false, false],
    );
    assert.equal(answers.filter((item) => !item.ok).every((item) => item.error === "This payment can't be completed."), true);
    assert.equal(intent.amount, 420);
  } finally {
    await prisma.paymentOffer.update({ where: { id: fixture.offerId }, data: { active: true } }).catch(() => undefined);
    await prisma.paymentOfferPrice.update({ where: { id: fixture.priceId }, data: { active: true } }).catch(() => undefined);
    await cleanupUser(customer);
  }
});

test("successful payment is stored once and hasPurchasedOffer follows the Payment row", async () => {
  const customer = uniqueId();
  const fixture = await createBusinessUser(customer, "conn-paid");
  const payload = `paid${customer.slice(-12)}`;
  try {
    await prisma.paymentIntent.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.userId,
        conversationId: fixture.conversationId,
        offerId: fixture.offerId,
        amount: 420,
        currency: "XTR",
        providerInvoicePayload: payload,
      },
    });
    assert.equal(await hasPurchasedOffer(fixture.userId, fixture.offerId), false);
    const payment = {
      currency: "XTR",
      total_amount: 420,
      invoice_payload: payload,
      telegram_payment_charge_id: `charge-${customer}`,
    };
    assert.equal(await handleSuccessfulPayment({ payment, telegramUserId: customer }), "recorded");
    assert.equal(await handleSuccessfulPayment({ payment, telegramUserId: customer }), "duplicate");
    const rows = await prisma.payment.findMany({ where: { providerPaymentId: payment.telegram_payment_charge_id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "PAID");
    assert.equal(rows[0]?.amount, 420);
    assert.equal(rows[0]?.currency, "XTR");
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { providerInvoicePayload: payload } });
    assert.equal(intent.status, "PAID");
    assert.ok(intent.paidAt);
    assert.equal(await hasPurchasedOffer(fixture.userId, fixture.offerId), true);
  } finally {
    await cleanupUser(customer);
  }
});

function deps(overrides: Partial<StarsCheckoutDeps>): StarsCheckoutDeps {
  return {
    createInvoiceLink: async () => "https://t.me/invoice/test",
    sendBusinessText: async () => undefined,
    sendAdminText: async () => undefined,
    answerPreCheckout: async () => undefined,
    ...overrides,
  };
}

function commandUpdate(owner: string, text: string): TelegramUpdate {
  const id = Number(owner);
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      chat: { id, type: "private" },
      from: { id, is_bot: false, username: "not-used" },
    },
  };
}

function query(telegramUserId: string, payload: string, amount: number, currency: string) {
  return {
    id: `query-${payload}-${amount}-${currency}-${telegramUserId}`,
    from: { id: Number(telegramUserId), is_bot: false },
    currency,
    total_amount: amount,
    invoice_payload: payload,
  };
}

async function createBusinessUser(telegramUserId: string, businessConnectionId: string) {
  const offer = await prisma.paymentOffer.upsert({
    where: { slug: "shower-time" },
    create: {
      slug: "shower-time",
      title: "Shower time 💋",
      description: "2 private photos",
      kind: "PAID_CONTENT",
      active: true,
    },
    update: { active: true },
  });
  const price = await prisma.paymentOfferPrice.upsert({
    where: { offerId_provider_currency: { offerId: offer.id, provider: "TELEGRAM_STARS", currency: "XTR" } },
    create: { offerId: offer.id, provider: "TELEGRAM_STARS", amount: 420, currency: "XTR", active: true },
    update: { amount: 420, active: true },
  });
  const user = await prisma.user.create({ data: { telegramUserId } });
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId,
    },
  });
  return { userId: user.id, conversationId: conversation.id, offerId: offer.id, priceId: price.id };
}

async function cleanupUser(telegramUserId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { telegramUserId } });
  if (!user) return;
  await prisma.payment.deleteMany({ where: { userId: user.id } });
  await prisma.paymentIntent.deleteMany({ where: { userId: user.id } });
  await prisma.conversation.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
}

function uniqueId(): string {
  return String(6_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
}
