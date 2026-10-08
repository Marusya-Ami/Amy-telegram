import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "@/lib/db/prisma";
import {
  createDroppVaultCheckout,
  DroppVaultPaymentError,
  droppCardPaymentEnabled,
} from "./droppVaultPayment";
import { processDroppWebhook } from "./droppWebhook";

const MOCK_WEBHOOK_SECRET = "whsec_supersecretfortesting123";
const MOCK_LINK_ID = "link_test_e2e_vault_link_1";

function sign(body: string, timestampSec: number, secret = MOCK_WEBHOOK_SECRET): string {
  const hash = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `sha256=${hash}`;
}

function withCardPaymentsEnabled<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DROPP_CARD_PAYMENT_ENABLED;
  process.env.DROPP_CARD_PAYMENT_ENABLED = "true";
  return run().finally(() => {
    if (previous === undefined) delete process.env.DROPP_CARD_PAYMENT_ENABLED;
    else process.env.DROPP_CARD_PAYMENT_ENABLED = previous;
  });
}

type E2EFixture = {
  user: { id: string; telegramUserId: string };
  conversation: { id: string; businessConnectionId: string | null };
  offer: { id: string; slug: string };
  asset: { id: string };
  cleanup: () => Promise<void>;
};

async function setupFixture(options?: { includeDroppPrice?: boolean; includeDroppLink?: boolean }): Promise<E2EFixture> {
  const includeDroppPrice = options?.includeDroppPrice ?? true;
  const includeDroppLink = options?.includeDroppLink ?? true;
  const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const telegramUserId = `dropp-e2e-${uniqueSuffix}`;

  const user = await prisma.user.create({
    data: {
      telegramUserId,
      firstName: "E2E Buyer",
      relationshipStage: "NEW",
    },
  });

  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      platform: "telegram-business",
      platformConversationId: telegramUserId,
      businessConnectionId: `biz_conn_${user.id}`,
      active: true,
    },
  });

  const offer = await prisma.paymentOffer.create({
    data: {
      slug: `vault-test-${uniqueSuffix}`,
      title: "Dropp Vault E2E Pack",
      description: "Exclusive photoshoot",
      kind: "PAID_CONTENT",
      active: true,
      ...(includeDroppPrice
        ? {
            prices: {
              create: {
                provider: "DROPP",
                amount: 10,
                currency: "USD",
                active: true,
              },
            },
          }
        : {}),
      ...(includeDroppLink
        ? {
            externalCheckouts: {
              create: {
                provider: "DROPP",
                checkoutUrl: "https://app.dropp.fans/s/test_e2e",
                externalLinkId: MOCK_LINK_ID,
                active: true,
              },
            },
          }
        : {}),
    },
  });

  const asset = await prisma.mediaAsset.create({
    data: {
      telegramFileId: `tg-file-${uniqueSuffix}`,
      telegramFileUniqueId: `tg-unique-${uniqueSuffix}`,
      storagePath: `paid/test-${uniqueSuffix}/01.jpg`,
      mediaType: "PHOTO",
      category: "selfie",
      description: "Test deliverable",
      tags: ["casual_selfie"],
      mood: "happy",
      flirtLevel: 1,
      peopleCount: 1,
      hasAmy: true,
      hasLuna: false,
      contexts: ["casual_selfie"],
      active: true,
      availability: "LOCKED",
    },
  });

  await prisma.paymentOfferMedia.create({
    data: {
      offerId: offer.id,
      mediaAssetId: asset.id,
      role: "DELIVERABLE",
      position: 1,
      active: true,
    },
  });

  return {
    user,
    conversation,
    offer,
    asset,
    cleanup: async () => {
      await prisma.paidContentDelivery.deleteMany({ where: { offerId: offer.id } });
      await prisma.payment.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentIntent.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOfferMedia.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOfferPrice.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOfferExternalCheckout.deleteMany({ where: { offerId: offer.id } });
      await prisma.paymentOffer.delete({ where: { id: offer.id } }).catch(() => undefined);
      await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
      await prisma.conversation.delete({ where: { id: conversation.id } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    },
  };
}

function mockVaultLink() {
  return {
    linkId: MOCK_LINK_ID,
    shareUrl: "https://app.dropp.fans/v/test_slug",
    miniAppUrl: "https://t.me/droppbot/vault?startapp=token_123",
    buttonText: "💳 Pay by card",
    photoUrl: null,
    coverUrl: null,
    caption: null,
    expiresAt: null,
  };
}

async function mintCheckout(fixture: E2EFixture) {
  return withCardPaymentsEnabled(() =>
    createDroppVaultCheckout({
      userId: fixture.user.id,
      offerSlug: fixture.offer.slug,
      conversationId: fixture.conversation.id,
      createVaultLinkFn: async () => mockVaultLink(),
    }),
  );
}

function paidPayload(input: {
  orderId: string;
  intentId: string;
  offerSlug: string;
  telegramUserId: string;
  now: Date;
  extra?: Record<string, unknown>;
}) {
  return JSON.stringify({
    event: "order.paid",
    occurred_at: input.now.toISOString(),
    object: "order",
    data: {
      id: input.orderId,
      status: "paid",
      type: "purchase",
      amount: {
        subtotal_cents: 1000,
        total_cents: 1000,
        currency_code: "USD",
      },
      buyer: {
        telegram: {
          id: input.telegramUserId,
          username: "amy_buyer",
        },
      },
      link: {
        id: MOCK_LINK_ID,
        name: "Test Dropp Link",
      },
      metadata: {
        paymentIntentId: input.intentId,
        offerSlug: input.offerSlug,
        telegramUserId: input.telegramUserId,
      },
      ...input.extra,
    },
  });
}

async function postPaid(input: {
  payload: string;
  now: Date;
  sendPhoto?: (args: { mediaAssetId: string }) => Promise<{ telegramMessageId: string }>;
}) {
  const nowSec = Math.floor(input.now.getTime() / 1000);
  return processDroppWebhook(
    {
      rawBody: input.payload,
      headers: {
        "x-dropp-timestamp": String(nowSec),
        "x-dropp-signature": sign(input.payload, nowSec),
        "x-dropp-event-type": "order.paid",
        "content-type": "application/json",
      },
    },
    {
      webhookSecret: MOCK_WEBHOOK_SECRET,
      now: input.now,
      persistDraft: async () => ({ seenBefore: false }),
      sendPhoto: input.sendPhoto,
    },
  );
}

test("Dropp Vault Payment E2E flow: checkout -> signed order.paid -> Payment created -> fulfillment -> idempotent replay", async () => {
  const fixture = await setupFixture();
  const deliveredMediaIds: string[] = [];

  try {
    assert.equal(droppCardPaymentEnabled("false"), false);
    assert.equal(droppCardPaymentEnabled(undefined), false);

    const checkoutResult = await mintCheckout(fixture);
    assert.equal(checkoutResult.miniAppUrl, "https://t.me/droppbot/vault?startapp=token_123");
    assert.equal(checkoutResult.amount, 10);
    assert.equal(checkoutResult.currency, "USD");

    const intent = await prisma.paymentIntent.findUniqueOrThrow({
      where: { id: checkoutResult.paymentIntentId },
    });
    assert.equal(intent.status, "PENDING");
    assert.equal(intent.provider, "DROPP");
    assert.equal(intent.paidAt, null);
    assert.equal(await prisma.payment.count({ where: { intentId: intent.id } }), 0);
    assert.equal(await prisma.paidContentDelivery.count({ where: { offerId: fixture.offer.id } }), 0);

    const now = new Date("2026-10-05T21:00:00.000Z");
    const orderId = `ord_e2e_${fixture.user.id}`;
    const payload = paidPayload({
      orderId,
      intentId: intent.id,
      offerSlug: fixture.offer.slug,
      telegramUserId: fixture.user.telegramUserId,
      now,
    });
    const mockSendPhoto = async (input: { mediaAssetId: string }) => {
      deliveredMediaIds.push(input.mediaAssetId);
      return { telegramMessageId: `msg-${deliveredMediaIds.length}` };
    };

    const webhookResult = await postPaid({ payload, now, sendPhoto: mockSendPhoto });
    assert.equal(webhookResult.status, 200);
    assert.equal(webhookResult.body["ok"], true);
    const paymentId = webhookResult.body["paymentId"] as string;
    assert.ok(paymentId);

    const updatedIntent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    assert.equal(updatedIntent.status, "PAID");
    assert.equal(updatedIntent.providerOrderId, orderId);

    const payments = await prisma.payment.findMany({ where: { intentId: intent.id } });
    assert.equal(payments.length, 1);
    assert.equal(payments[0]?.providerPaymentId, `dropp_order:${orderId}`);
    assert.deepEqual(deliveredMediaIds, [fixture.asset.id]);
    assert.equal(await prisma.paidContentDelivery.count({ where: { paymentId } }), 1);

    const duplicateResult = await postPaid({ payload, now, sendPhoto: mockSendPhoto });
    assert.equal(duplicateResult.status, 200);
    assert.equal(duplicateResult.body["ok"], true);
    assert.equal(duplicateResult.body["duplicate"], true);
    assert.equal(await prisma.payment.count({ where: { intentId: intent.id } }), 1);
    assert.equal(deliveredMediaIds.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("Two different Dropp order IDs for one intent do not fulfill twice", async () => {
  const fixture = await setupFixture();
  const deliveredMediaIds: string[] = [];
  try {
    const checkout = await mintCheckout(fixture);
    const now = new Date("2026-10-05T21:00:00.000Z");
    const mockSendPhoto = async (input: { mediaAssetId: string }) => {
      deliveredMediaIds.push(input.mediaAssetId);
      return { telegramMessageId: `msg-${deliveredMediaIds.length}` };
    };
    const first = await postPaid({
      payload: paidPayload({
        orderId: `ord_first_${fixture.user.id}`,
        intentId: checkout.paymentIntentId,
        offerSlug: fixture.offer.slug,
        telegramUserId: fixture.user.telegramUserId,
        now,
      }),
      now,
      sendPhoto: mockSendPhoto,
    });
    const second = await postPaid({
      payload: paidPayload({
        orderId: `ord_second_${fixture.user.id}`,
        intentId: checkout.paymentIntentId,
        offerSlug: fixture.offer.slug,
        telegramUserId: fixture.user.telegramUserId,
        now,
      }),
      now,
      sendPhoto: mockSendPhoto,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body["ok"], true);
    assert.equal(second.status, 200);
    assert.equal(second.body["conflict"], true);
    assert.equal(second.body["receivedOrderId"], `ord_second_${fixture.user.id}`);
    assert.equal(await prisma.payment.count({ where: { intentId: checkout.paymentIntentId } }), 1);
    assert.equal(deliveredMediaIds.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("Concurrent Promise.all webhooks fulfill paid media once", async () => {
  const fixture = await setupFixture();
  const deliveredMediaIds: string[] = [];
  try {
    const checkout = await mintCheckout(fixture);
    const now = new Date("2026-10-05T21:00:00.000Z");
    const payload = paidPayload({
      orderId: `ord_concurrent_${fixture.user.id}`,
      intentId: checkout.paymentIntentId,
      offerSlug: fixture.offer.slug,
      telegramUserId: fixture.user.telegramUserId,
      now,
    });
    const mockSendPhoto = async (input: { mediaAssetId: string }) => {
      deliveredMediaIds.push(input.mediaAssetId);
      return { telegramMessageId: `msg-${deliveredMediaIds.length}` };
    };
    const [first, second] = await Promise.all([
      postPaid({ payload, now, sendPhoto: mockSendPhoto }),
      postPaid({ payload, now, sendPhoto: mockSendPhoto }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal([first.body["ok"], second.body["ok"]].every(Boolean), true);
    assert.equal(await prisma.payment.count({ where: { intentId: checkout.paymentIntentId } }), 1);
    assert.equal(deliveredMediaIds.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("BUYER MISMATCH SECURITY: User B pays for User A intent -> rejected, no payment, no delivery", async () => {
  const fixture = await setupFixture();
  let deliveryAttempted = false;
  try {
    const checkoutResult = await mintCheckout(fixture);
    const now = new Date("2026-10-05T21:00:00.000Z");
    const payload = paidPayload({
      orderId: "ord_mismatch_123",
      intentId: checkoutResult.paymentIntentId,
      offerSlug: fixture.offer.slug,
      telegramUserId: fixture.user.telegramUserId,
      now,
      extra: { buyer: { telegram: { id: "999888777", username: "attacker_user" } } },
    });
    const res = await postPaid({
      payload,
      now,
      sendPhoto: async () => {
        deliveryAttempted = true;
        return { telegramMessageId: "nope" };
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body["reason"], "buyer_mismatch");
    assert.equal((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkoutResult.paymentIntentId } })).status, "PENDING");
    assert.equal(await prisma.payment.count({ where: { intentId: checkoutResult.paymentIntentId } }), 0);
    assert.equal(deliveryAttempted, false);
  } finally {
    await fixture.cleanup();
  }
});

test("Missing and wrong Dropp link IDs are rejected", async () => {
  const fixture = await setupFixture();
  try {
    const checkout = await mintCheckout(fixture);
    const now = new Date("2026-10-05T21:00:00.000Z");
    const missing = await postPaid({
      payload: paidPayload({
        orderId: "ord_missing_link",
        intentId: checkout.paymentIntentId,
        offerSlug: fixture.offer.slug,
        telegramUserId: fixture.user.telegramUserId,
        now,
        extra: { link: {} },
      }),
      now,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body["reason"], "missing_link_id");

    const malformed = await postPaid({
      payload: paidPayload({
        orderId: "ord_malformed_link",
        intentId: checkout.paymentIntentId,
        offerSlug: fixture.offer.slug,
        telegramUserId: fixture.user.telegramUserId,
        now,
        extra: { link: { id: { nested: true } } },
      }),
      now,
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body["reason"], "malformed_link_id");

    const wrong = await postPaid({
      payload: paidPayload({
        orderId: "ord_wrong_link",
        intentId: checkout.paymentIntentId,
        offerSlug: fixture.offer.slug,
        telegramUserId: fixture.user.telegramUserId,
        now,
        extra: { link: { id: "link_unmapped_other_999" } },
      }),
      now,
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body["reason"], "link_mismatch");
    assert.equal((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkout.paymentIntentId } })).status, "PENDING");
  } finally {
    await fixture.cleanup();
  }
});

test("Stars intents, cancelled intents, and non-paid order status are rejected", async () => {
  const fixture = await setupFixture();
  try {
    const now = new Date("2026-10-05T21:00:00.000Z");
    const starsIntent = await prisma.paymentIntent.create({
      data: {
        provider: "TELEGRAM_STARS",
        userId: fixture.user.id,
        conversationId: fixture.conversation.id,
        offerId: fixture.offer.id,
        status: "PENDING",
        amount: 180,
        currency: "XTR",
        providerInvoicePayload: `stars:${randomUUID()}`,
      },
    });
    const starsRes = await postPaid({
      payload: paidPayload({
        orderId: "ord_stars_reject",
        intentId: starsIntent.id,
        offerSlug: fixture.offer.slug,
        telegramUserId: fixture.user.telegramUserId,
        now,
      }),
      now,
    });
    assert.equal(starsRes.status, 400);
    assert.equal(starsRes.body["reason"], "wrong_provider");

    const cancelled = await prisma.paymentIntent.create({
      data: {
        provider: "DROPP",
        userId: fixture.user.id,
        conversationId: fixture.conversation.id,
        offerId: fixture.offer.id,
        status: "CANCELLED",
        amount: 10,
        currency: "USD",
        providerInvoicePayload: `dropp:${randomUUID()}`,
      },
    });
    const cancelledRes = await postPaid({
      payload: paidPayload({
        orderId: "ord_cancelled_reject",
        intentId: cancelled.id,
        offerSlug: fixture.offer.slug,
        telegramUserId: fixture.user.telegramUserId,
        now,
      }),
      now,
    });
    assert.equal(cancelledRes.status, 400);
    assert.equal(cancelledRes.body["reason"], "invalid_intent_status");

    const pendingCheckout = await mintCheckout(fixture);
    const unpaid = await postPaid({
      payload: JSON.stringify({
        event: "order.paid",
        data: {
          id: "ord_not_paid_status",
          status: "open",
          amount: { total_cents: 1000, currency_code: "USD" },
          buyer: { telegram: { id: fixture.user.telegramUserId } },
          link: { id: MOCK_LINK_ID },
          metadata: {
            paymentIntentId: pendingCheckout.paymentIntentId,
            offerSlug: fixture.offer.slug,
            telegramUserId: fixture.user.telegramUserId,
          },
        },
      }),
      now,
    });
    assert.equal(unpaid.status, 400);
    assert.equal(unpaid.body["reason"], "order_not_paid");
    assert.equal(await prisma.payment.count({ where: { offerId: fixture.offer.id } }), 0);
  } finally {
    await fixture.cleanup();
  }
});

test("Checkout refuses missing DROPP price and missing link mapping", async () => {
  const missingPrice = await setupFixture({ includeDroppPrice: false });
  const missingLink = await setupFixture({ includeDroppLink: false });
  try {
    await withCardPaymentsEnabled(async () => {
      await assert.rejects(
        () =>
          createDroppVaultCheckout({
            userId: missingPrice.user.id,
            offerSlug: missingPrice.offer.slug,
            createVaultLinkFn: async () => mockVaultLink(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof DroppVaultPaymentError);
          assert.equal(err.code, "missing_price");
          return true;
        },
      );
      await assert.rejects(
        () =>
          createDroppVaultCheckout({
            userId: missingLink.user.id,
            offerSlug: missingLink.offer.slug,
            createVaultLinkFn: async () => mockVaultLink(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof DroppVaultPaymentError);
          assert.equal(err.code, "missing_link_mapping");
          return true;
        },
      );
    });
  } finally {
    await missingPrice.cleanup();
    await missingLink.cleanup();
  }
});

test("TAMPERING & WRONG OFFER: Webhook validations reject all anomalous scenarios", async () => {
  const fixture = await setupFixture();
  try {
    const checkout = await mintCheckout(fixture);
    const now = new Date("2026-10-05T21:00:00.000Z");
    const base = {
      orderId: "ord_tamper_test",
      intentId: checkout.paymentIntentId,
      offerSlug: fixture.offer.slug,
      telegramUserId: fixture.user.telegramUserId,
      now,
    };

    const wrongOffer = await postPaid({
      payload: paidPayload({
        ...base,
        extra: {
          metadata: {
            paymentIntentId: checkout.paymentIntentId,
            offerSlug: "wrong-slug-123",
            telegramUserId: fixture.user.telegramUserId,
          },
        },
      }),
      now,
    });
    assert.equal(wrongOffer.body["reason"], "offer_mismatch");

    const wrongUser = await postPaid({
      payload: paidPayload({
        ...base,
        extra: {
          metadata: {
            paymentIntentId: checkout.paymentIntentId,
            offerSlug: fixture.offer.slug,
            telegramUserId: "999999999",
          },
        },
      }),
      now,
    });
    assert.equal(wrongUser.body["reason"], "user_mismatch");

    const wrongAmount = await postPaid({
      payload: paidPayload({ ...base, extra: { amount: { total_cents: 500, currency_code: "USD" } } }),
      now,
    });
    assert.equal(wrongAmount.body["reason"], "amount_mismatch");

    const wrongCurrency = await postPaid({
      payload: paidPayload({ ...base, extra: { amount: { total_cents: 1000, currency_code: "EUR" } } }),
      now,
    });
    assert.equal(wrongCurrency.body["reason"], "currency_mismatch");

    const unknownIntent = await postPaid({
      payload: paidPayload({
        ...base,
        extra: {
          metadata: {
            paymentIntentId: "cmut_nonexistent_intent_id",
            offerSlug: fixture.offer.slug,
            telegramUserId: fixture.user.telegramUserId,
          },
        },
      }),
      now,
    });
    assert.equal(unknownIntent.body["reason"], "unknown_payment_intent");

    const missingBuyer = await postPaid({
      payload: paidPayload({ ...base, extra: { buyer: { telegram: null } } }),
      now,
    });
    assert.equal(missingBuyer.body["reason"], "missing_buyer_telegram_id");
  } finally {
    await fixture.cleanup();
  }
});
