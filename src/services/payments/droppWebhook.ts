import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { isUniqueConstraintError } from "@/lib/db/errors";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  inspectDroppRequest,
  persistDroppCapture,
  type DroppCaptureDraft,
} from "./droppCapture";
import { fulfillPaidContent, type PaidDeliverySend } from "./fulfillPaidContent";

export type SignatureVerificationResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "missing_secret"
        | "missing_timestamp"
        | "malformed_timestamp"
        | "timestamp_expired"
        | "timestamp_future"
        | "missing_signature"
        | "malformed_signature"
        | "invalid_signature";
    };

const SIGNATURE_REGEX = /^sha256=([0-9a-f]{64})$/i;
const MAX_SKEW_SECONDS = 300; // 5 minutes

/**
 * Verifies Dropp webhook HMAC-SHA256 signature using the exact RAW request body.
 *
 * Expected signature format:
 * sha256=HMAC_SHA256_HEX(secret, `${X-Dropp-Timestamp}.${rawBody}`)
 *
 * Enforces constant-time comparison and absolute timestamp skew <= 300 seconds.
 */
export function verifyDroppWebhookSignature(input: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret: string;
  now?: Date;
  maxSkewSeconds?: number;
}): SignatureVerificationResult {
  const secret = input.secret?.trim();
  if (!secret) {
    return { valid: false, reason: "missing_secret" };
  }

  const rawTimestamp = input.timestampHeader?.trim();
  if (!rawTimestamp) {
    return { valid: false, reason: "missing_timestamp" };
  }

  const timestampSec = Number(rawTimestamp);
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) {
    return { valid: false, reason: "malformed_timestamp" };
  }

  const now = input.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const maxSkew = input.maxSkewSeconds ?? MAX_SKEW_SECONDS;
  const skew = nowSec - timestampSec;

  if (skew > maxSkew) {
    return { valid: false, reason: "timestamp_expired" };
  }
  if (skew < -maxSkew) {
    return { valid: false, reason: "timestamp_future" };
  }

  const rawSignature = input.signatureHeader?.trim();
  if (!rawSignature) {
    return { valid: false, reason: "missing_signature" };
  }

  const match = rawSignature.match(SIGNATURE_REGEX);
  if (!match || !match[1]) {
    return { valid: false, reason: "malformed_signature" };
  }

  const receivedHex = match[1].toLowerCase();
  const payloadToSign = `${rawTimestamp}.${input.rawBody}`;
  const expectedHex = createHmac("sha256", secret).update(payloadToSign).digest("hex");

  const receivedBuf = Buffer.from(receivedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");

  if (receivedBuf.length !== expectedBuf.length || !timingSafeEqual(receivedBuf, expectedBuf)) {
    return { valid: false, reason: "invalid_signature" };
  }

  return { valid: true };
}

const STRICT_DECIMAL_REGEX = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const STRICT_INTEGER_STRING_REGEX = /^(0|[1-9]\d*)$/;
const LINK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function droppOrderPaymentId(orderId: string): string {
  return `dropp_order:${orderId}`;
}

function asDroppId(value: unknown): { ok: true; id: string } | { ok: false; reason: "missing" | "malformed" } {
  if (value === undefined || value === null) return { ok: false, reason: "missing" };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, reason: "malformed" };
    return { ok: true, id: String(value) };
  }
  if (typeof value !== "string") return { ok: false, reason: "malformed" };
  const id = value.trim();
  if (!id) return { ok: false, reason: "missing" };
  if (!LINK_ID_REGEX.test(id)) return { ok: false, reason: "malformed" };
  return { ok: true, id };
}

/**
 * Minor-unit integer parsing (e.g. amount_cents, total_cents, subtotal_cents).
 * Accepts ONLY a finite non-negative safe integer.
 * Rejects negative values, fractions, scientific notation, NaN, Infinity, and non-integer representations.
 */
export function parseMinorUnitsToCents(amount: unknown): number | null {
  if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount) || amount < 0 || Object.is(amount, -0)) {
      return null;
    }
    return amount;
  }

  if (typeof amount === "string") {
    const trimmed = amount.trim();
    if (!STRICT_INTEGER_STRING_REGEX.test(trimmed)) {
      return null;
    }
    const val = Number(trimmed);
    if (!Number.isSafeInteger(val) || val < 0) {
      return null;
    }
    return val;
  }

  return null;
}

function parseDecimalStringToCents(str: string): number | null {
  const match = str.match(STRICT_DECIMAL_REGEX);
  if (!match) {
    return null;
  }

  const wholeStr = match[1];
  const fracStr = match[2] ? match[2].slice(1) : "";

  const whole = Number(wholeStr);
  if (!Number.isSafeInteger(whole)) {
    return null;
  }

  let fracCents = 0;
  if (fracStr.length === 1) {
    fracCents = Number(fracStr) * 10;
  } else if (fracStr.length === 2) {
    fracCents = Number(fracStr);
  }

  const totalCents = whole * 100 + fracCents;
  if (!Number.isSafeInteger(totalCents)) {
    return null;
  }

  return totalCents;
}

/**
 * Decimal-safe money normalization for major currency units (e.g. USD).
 * Converts an exact decimal string or safe finite number (with at most 2 fractional digits)
 * into integer cents. Fails closed (returns null) on any ambiguity, truncation, scientific notation,
 * negative amounts, or malformed input.
 */
export function parseDecimalToCents(amount: unknown): number | null {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0 || Object.is(amount, -0)) {
      return null;
    }
    const str = amount.toString();
    return parseDecimalStringToCents(str);
  }

  if (typeof amount === "string") {
    const trimmed = amount.trim();
    if (!trimmed) {
      return null;
    }
    return parseDecimalStringToCents(trimmed);
  }

  return null;
}

/**
 * Validates paid amount matching without floating-point comparisons.
 *
 * Fails closed:
 * 1. expectedAmount is parsed strictly as a major-unit decimal value into integer cents.
 * 2. If droppAmount is an object with an explicitly identified *_cents field (total_cents, amount_cents, subtotal_cents),
 *    it is parsed via parseMinorUnitsToCents.
 * 3. If droppAmount is an object with a major-unit decimal field (total, amount), it is parsed via parseDecimalToCents.
 * 4. Otherwise, droppAmount is parsed as a major-unit decimal value via parseDecimalToCents.
 *
 * NOTE: 1500 only equals $15.00 when reading an explicitly identified *_cents field.
 * A bare 15 represents $15.00, not 15 cents.
 */
export function verifyDroppAmount(input: {
  droppAmount: unknown;
  expectedAmount: number | string;
}): boolean {
  const expectedCents = parseDecimalToCents(input.expectedAmount);
  if (expectedCents === null) {
    return false;
  }

  let droppCents: number | null = null;

  if (input.droppAmount && typeof input.droppAmount === "object") {
    const obj = input.droppAmount as Record<string, unknown>;
    const centsKey = ["total_cents", "amount_cents", "subtotal_cents"].find((k) => obj[k] !== undefined);
    if (centsKey !== undefined) {
      droppCents = parseMinorUnitsToCents(obj[centsKey]);
    } else {
      const decimalKey = ["total", "amount"].find((k) => obj[k] !== undefined);
      if (decimalKey !== undefined) {
        droppCents = parseDecimalToCents(obj[decimalKey]);
      } else {
        return false;
      }
    }
  } else {
    droppCents = parseDecimalToCents(input.droppAmount);
  }

  if (droppCents === null) {
    return false;
  }

  return droppCents === expectedCents;
}

export type DroppWebhookValidationResult =
  | { valid: true; intentId: string; orderId: string; paymentId?: string }
  | {
      valid: false;
      reason:
        | "invalid_json"
        | "invalid_metadata"
        | "unknown_payment_intent"
        | "wrong_provider"
        | "invalid_intent_status"
        | "user_mismatch"
        | "missing_buyer_telegram_id"
        | "buyer_mismatch"
        | "offer_mismatch"
        | "missing_link_id"
        | "malformed_link_id"
        | "link_mismatch"
        | "missing_order_id"
        | "currency_mismatch"
        | "amount_mismatch"
        | "order_not_paid";
    };

export type DroppWebhookDeps = {
  webhookSecret?: string;
  now?: Date;
  persistDraft?: (draft: DroppCaptureDraft) => Promise<{ seenBefore: boolean }>;
  sendPhoto?: PaidDeliverySend;
};

/**
 * Core processor for Dropp webhooks.
 * - Enforces HMAC-SHA256 signature verification over raw body.
 * - Rejects stale (>5min) or future events.
 * - Filters for `order.paid` before monetization actions.
 * - Executes strict validation chain against PaymentIntent, buyer Telegram ID, offer, link, and price.
 * - Idempotently creates exactly one Payment row and fulfills paid content via existing non-native engine.
 */
export async function processDroppWebhook(
  input: {
    rawBody: string;
    headers: Headers | Record<string, string | null | undefined>;
  },
  deps: DroppWebhookDeps = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const getHeader = (name: string): string | null => {
    if ("get" in input.headers && typeof input.headers.get === "function") {
      return input.headers.get(name);
    }
    const record = input.headers as Record<string, string | null | undefined>;
    return record[name] ?? record[name.toLowerCase()] ?? null;
  };

  const timestampHeader = getHeader("x-dropp-timestamp");
  const signatureHeader = getHeader("x-dropp-signature");
  const eventTypeHeader = getHeader("x-dropp-event-type");
  const eventIdHeader = getHeader("x-dropp-event-id");

  let secret = deps.webhookSecret;
  if (!secret) {
    try {
      secret = getEnv().DROPP_WEBHOOK_SECRET;
    } catch {
      secret = process.env["DROPP_WEBHOOK_SECRET"] ?? "";
    }
  }

  const verification = verifyDroppWebhookSignature({
    rawBody: input.rawBody,
    timestampHeader,
    signatureHeader,
    secret: secret || "",
    now: deps.now,
  });

  if (!verification.valid) {
    logger.warn("dropp.webhook.signature_failed", {
      reason: verification.reason,
      hasTimestamp: Boolean(timestampHeader),
      hasSignature: Boolean(signatureHeader),
    });
    const httpStatus = verification.reason.startsWith("missing_") || verification.reason.startsWith("malformed_")
      ? 400
      : 401;
    return {
      status: httpStatus,
      body: { ok: false, error: "signature_verification_failed", reason: verification.reason },
    };
  }

  let eventPayload: Record<string, unknown>;
  try {
    eventPayload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: { ok: false, error: "invalid_json" },
    };
  }

  const headerEntries: Array<[string, string]> = [];
  if ("entries" in input.headers && typeof (input.headers as Headers).entries === "function") {
    for (const [k, v] of (input.headers as Headers).entries()) {
      headerEntries.push([k, v]);
    }
  } else {
    for (const [k, v] of Object.entries(input.headers)) {
      if (typeof v === "string") headerEntries.push([k, v]);
    }
  }

  const draft = inspectDroppRequest({
    method: "POST",
    contentType: getHeader("content-type"),
    headers: headerEntries,
    rawBody: input.rawBody,
  });
  (draft as { authentication: string }).authentication = "VERIFIED";

  const persister = deps.persistDraft ?? persistDroppCapture;
  let seenBefore = false;
  try {
    const res = await persister(draft);
    seenBefore = res.seenBefore;
  } catch (err) {
    logger.warn("dropp.webhook.persist_failed", {
      name: err instanceof Error ? err.name : "PersistError",
    });
  }

  const eventType = (eventPayload["event"] ?? eventTypeHeader ?? "") as string;
  const eventId = (eventIdHeader ?? eventPayload["id"] ?? "") as string;

  // Only `order.paid` triggers paid content fulfillment
  if (eventType !== "order.paid") {
    logger.info("dropp.webhook.event_ignored", {
      eventType,
      eventId,
      seenBefore,
    });
    return {
      status: 200,
      body: { ok: true, ignored: true, eventType },
    };
  }

  const orderData = (eventPayload["data"] as Record<string, unknown> | undefined) ?? {};
  const parsedOrderId = asDroppId(orderData["id"]);
  const orderId = parsedOrderId.ok ? parsedOrderId.id : "";
  const orderStatus = String(orderData["status"] ?? "").trim().toLowerCase();
  const metadata = (orderData["metadata"] as Record<string, unknown> | undefined) ?? {};

  const paymentIntentId = String(metadata["paymentIntentId"] ?? "").trim();
  const offerSlug = String(metadata["offerSlug"] ?? "").trim();
  const telegramUserId = String(metadata["telegramUserId"] ?? "").trim();

  const buyerObj = (orderData["buyer"] as Record<string, unknown> | undefined) ?? {};
  const buyerTelegram = (buyerObj["telegram"] as Record<string, unknown> | undefined) ?? {};
  const buyerTelegramId = String(buyerTelegram["id"] ?? "").trim();

  const linkObj = (orderData["link"] as Record<string, unknown> | undefined) ?? {};
  const parsedLinkId = asDroppId(linkObj["id"]);

  // Step A: Metadata presence
  if (!paymentIntentId || !offerSlug || !telegramUserId) {
    logger.warn("dropp.webhook.invalid_metadata", {
      orderId,
      hasIntentId: Boolean(paymentIntentId),
      hasOfferSlug: Boolean(offerSlug),
      hasTelegramUserId: Boolean(telegramUserId),
    });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "invalid_metadata" },
    };
  }

  // Step B: Load PaymentIntent
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    include: {
      user: { select: { id: true, telegramUserId: true } },
      offer: {
        include: {
          prices: { where: { provider: "DROPP", active: true } },
          externalCheckouts: { where: { provider: "DROPP", active: true } },
        },
      },
    },
  });

  if (!parsedOrderId.ok) {
    logger.warn("dropp.webhook.missing_order_id", { paymentIntentId, reason: parsedOrderId.reason });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "missing_order_id" },
    };
  }

  if (!intent) {
    logger.warn("dropp.webhook.unknown_payment_intent", { paymentIntentId, orderId });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "unknown_payment_intent" },
    };
  }

  // Step C: Provider check
  if (intent.provider !== "DROPP") {
    logger.warn("dropp.webhook.wrong_provider", { paymentIntentId, provider: intent.provider });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "wrong_provider" },
    };
  }

  if (intent.status === "CANCELLED" || (intent.status !== "PENDING" && intent.status !== "PAID")) {
    logger.warn("dropp.webhook.invalid_intent_status", { paymentIntentId, status: intent.status });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "invalid_intent_status" },
    };
  }

  // Step D: Authoritative user check (metadata vs DB intent user)
  if (intent.user.telegramUserId !== telegramUserId) {
    logger.warn("dropp.webhook.user_mismatch", {
      paymentIntentId,
      expected: intent.user.telegramUserId,
      received: telegramUserId,
    });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "user_mismatch" },
    };
  }

  // Step E & F: Telegram buyer verification (Security check: A cannot buy for B)
  if (!buyerTelegramId) {
    logger.warn("dropp.webhook.missing_buyer_telegram_id", { orderId, paymentIntentId });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "missing_buyer_telegram_id" },
    };
  }

  if (buyerTelegramId !== intent.user.telegramUserId) {
    logger.warn("dropp.webhook.buyer_mismatch", {
      orderId,
      paymentIntentId,
      expectedTelegramUserId: intent.user.telegramUserId,
      buyerTelegramId,
    });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "buyer_mismatch" },
    };
  }

  // Step G: Offer slug check
  if (intent.offer.slug !== offerSlug) {
    logger.warn("dropp.webhook.offer_mismatch", {
      paymentIntentId,
      expected: intent.offer.slug,
      received: offerSlug,
    });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "offer_mismatch" },
    };
  }

  // Step H: Dropp link mapping check — nonempty, well-formed, and exact match.
  if (!parsedLinkId.ok) {
    logger.warn("dropp.webhook.link_id_invalid", { paymentIntentId, reason: parsedLinkId.reason });
    return {
      status: 400,
      body: {
        ok: false,
        error: "validation_failed",
        reason: parsedLinkId.reason === "malformed" ? "malformed_link_id" : "missing_link_id",
      },
    };
  }
  const expectedLinkId = intent.offer.externalCheckouts[0]?.externalLinkId?.trim() ?? "";
  if (!expectedLinkId || expectedLinkId !== parsedLinkId.id) {
    logger.warn("dropp.webhook.link_mismatch", {
      paymentIntentId,
      expected: expectedLinkId || null,
      received: parsedLinkId.id,
    });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "link_mismatch" },
    };
  }

  // Step I: Currency & Amount check
  const amountObj = (orderData["amount"] as Record<string, unknown> | undefined) ?? {};
  const droppCurrency = String(amountObj["currency_code"] ?? orderData["currency"] ?? "USD").trim().toUpperCase();

  if (droppCurrency !== intent.currency.toUpperCase()) {
    logger.warn("dropp.webhook.currency_mismatch", {
      paymentIntentId,
      expected: intent.currency,
      received: droppCurrency,
    });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "currency_mismatch" },
    };
  }

  const isAmountValid = verifyDroppAmount({
    droppAmount:
      typeof orderData["amount"] === "object" && orderData["amount"] !== null
        ? orderData["amount"]
        : (orderData["amount"] ?? (orderData["total_cents"] !== undefined ? { total_cents: orderData["total_cents"] } : undefined)),
    expectedAmount: intent.amount,
  });

  if (!isAmountValid) {
    logger.warn("dropp.webhook.amount_mismatch", {
      paymentIntentId,
      expected: intent.amount,
      receivedAmount: amountObj,
    });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "amount_mismatch" },
    };
  }

  // Step K: Order status check
  if (orderStatus !== "paid") {
    logger.warn("dropp.webhook.order_not_paid", { orderId, status: orderStatus });
    return {
      status: 400,
      body: { ok: false, error: "validation_failed", reason: "order_not_paid" },
    };
  }

  const providerPaymentId = droppOrderPaymentId(orderId);
  const now = deps.now ?? new Date();
  const claim = await claimDroppIntentPayment({
    intentId: intent.id,
    userId: intent.userId,
    offerId: intent.offerId,
    amount: intent.amount,
    currency: intent.currency,
    orderId,
    providerPaymentId,
    now,
  });

  if (claim.kind === "conflict") {
    logger.warn("dropp.webhook.conflicting_order", {
      paymentIntentId: intent.id,
      existingPaymentId: claim.payment.id,
      existingOrderId: claim.payment.providerOrderId,
      receivedOrderId: orderId,
    });
    return {
      status: 200,
      body: {
        ok: true,
        conflict: true,
        paymentId: claim.payment.id,
        existingOrderId: claim.payment.providerOrderId,
        receivedOrderId: orderId,
      },
    };
  }

  if (claim.kind === "created") {
    logger.info("dropp.payment.created", {
      paymentId: claim.payment.id,
      paymentIntentId: intent.id,
      userId: intent.userId,
      offerSlug: intent.offer.slug,
      amount: claim.payment.amount,
      currency: claim.payment.currency,
    });
  } else {
    logger.info("dropp.webhook.already_paid_idempotent", {
      paymentIntentId: intent.id,
      paymentId: claim.payment.id,
    });
  }

  const fulfillment = await fulfillPaidContent({
    paymentId: claim.payment.id,
    sendPhoto: deps.sendPhoto,
  });

  logger.info("dropp.fulfillment.completed", {
    paymentId: claim.payment.id,
    status: fulfillment.status,
    delivered: fulfillment.delivered,
    pending: fulfillment.pending,
  });

  return {
    status: 200,
    body: {
      ok: true,
      duplicate: claim.kind === "replay",
      paymentId: claim.payment.id,
      fulfillmentStatus: fulfillment.status,
      delivered: fulfillment.delivered,
    },
  };
}

type DroppPaymentRow = {
  id: string;
  providerOrderId: string | null;
  providerPaymentId: string;
  amount: number;
  currency: string;
};

async function claimDroppIntentPayment(input: {
  intentId: string;
  userId: string;
  offerId: string;
  amount: number;
  currency: string;
  orderId: string;
  providerPaymentId: string;
  now: Date;
}): Promise<
  | { kind: "created" | "replay"; payment: DroppPaymentRow }
  | { kind: "conflict"; payment: DroppPaymentRow }
> {
  try {
    const claimed = await prisma.$transaction(async (tx) => {
      const updated = await tx.paymentIntent.updateMany({
        where: { id: input.intentId, status: "PENDING" },
        data: {
          status: "PAID",
          paidAt: input.now,
          providerOrderId: input.orderId,
        },
      });
      if (updated.count === 0) return null;
      return tx.payment.upsert({
        where: { providerPaymentId: input.providerPaymentId },
        create: {
          provider: "DROPP",
          userId: input.userId,
          offerId: input.offerId,
          intentId: input.intentId,
          amount: input.amount,
          currency: input.currency,
          status: "PAID",
          providerPaymentId: input.providerPaymentId,
          providerOrderId: input.orderId,
          paidAt: input.now,
        },
        update: {},
      });
    });
    if (claimed) return { kind: "created", payment: claimed };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const existing =
    (await prisma.payment.findFirst({
      where: { intentId: input.intentId, status: "PAID" },
      orderBy: { createdAt: "asc" },
    })) ??
    (await prisma.payment.findUnique({
      where: { providerPaymentId: input.providerPaymentId },
    }));

  if (!existing) {
    throw new Error("dropp_payment_claim_lost");
  }

  const sameOrder =
    existing.providerPaymentId === input.providerPaymentId || existing.providerOrderId === input.orderId;
  if (sameOrder && existing.intentId === input.intentId) {
    return { kind: "replay", payment: existing };
  }

  return { kind: "conflict", payment: existing };
}

/**
 * Next.js route handler adapter for Dropp webhook.
 * Ensures the exact raw text body is read from the request.
 */
export async function handleDroppWebhookRequest(request: Request, deps: DroppWebhookDeps = {}): Promise<Response> {
  try {
    const rawBody = await request.text();
    const result = await processDroppWebhook(
      {
        rawBody,
        headers: request.headers,
      },
      deps,
    );
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    logger.error("dropp.webhook.unhandled_error", {
      name: err instanceof Error ? err.name : "UnhandledError",
    });
    return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
