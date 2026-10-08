import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { type TipLanguage } from "@/services/sales/tip";
import { createVaultLink, type DroppVaultLinkResult } from "./droppClient";

export class DroppVaultPaymentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DroppVaultPaymentError";
  }
}

/**
 * Feature gate for Dropp / card payment button presentation.
 * Disabled by default. Only enabled when DROPP_CARD_PAYMENT_ENABLED="true".
 */
export function droppCardPaymentEnabled(raw = process.env["DROPP_CARD_PAYMENT_ENABLED"]): boolean {
  return raw?.trim() === "true";
}

const CARD_BUTTON_LABEL: Record<TipLanguage, string> = {
  en: "💳 Pay by card",
  ru: "💳 Оплатить картой",
  es: "💳 Pagar con tarjeta",
};

export function droppCardButtonLabel(language: TipLanguage): string {
  return CARD_BUTTON_LABEL[language] ?? CARD_BUTTON_LABEL.en;
}

export type DroppVaultCheckoutResult = {
  paymentIntentId: string;
  miniAppUrl: string;
  shareUrl: string;
  buttonText: string;
  amount: number;
  currency: string;
  offerSlug: string;
};

/**
 * Initiates the payment intent lifecycle for a Dropp Vault purchase:
 * 1. Resolves user and active PaymentOffer.
 * 2. Resolves active DROPP / USD price.
 * 3. Resolves mapped Dropp linkId.
 * 4. Creates or reuses a PENDING PaymentIntent with provider = DROPP.
 * 5. Calls Dropp API to mint the official Vault Mini App link.
 * 6. Returns the official Mini App URL for Telegram inline button.
 *
 * NOTE: Does NOT mark anything PAID. Does NOT deliver content.
 */
export async function createDroppVaultCheckout(input: {
  userId: string;
  offerSlug: string;
  conversationId?: string | null;
  language?: TipLanguage;
  createVaultLinkFn?: (
    params: Parameters<typeof createVaultLink>[0],
  ) => Promise<DroppVaultLinkResult>;
}): Promise<DroppVaultCheckoutResult> {
  if (!droppCardPaymentEnabled()) {
    throw new DroppVaultPaymentError("Dropp card payment is disabled", "card_payment_disabled");
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, telegramUserId: true },
  });
  if (!user) {
    throw new DroppVaultPaymentError(`User not found: ${input.userId}`, "user_not_found");
  }

  const offer = await prisma.paymentOffer.findUnique({
    where: { slug: input.offerSlug },
    include: {
      prices: { where: { provider: "DROPP", active: true } },
      externalCheckouts: { where: { provider: "DROPP", active: true } },
    },
  });

  if (!offer || !offer.active) {
    throw new DroppVaultPaymentError(`Active offer not found: ${input.offerSlug}`, "offer_not_found");
  }

  const price = offer.prices.find((p) => p.currency === "USD");
  if (!price) {
    throw new DroppVaultPaymentError(`No active DROPP USD price for offer: ${input.offerSlug}`, "missing_price");
  }

  const checkout = offer.externalCheckouts[0];
  if (!checkout?.externalLinkId) {
    throw new DroppVaultPaymentError(
      `No active Dropp external link mapped for offer: ${input.offerSlug}`,
      "missing_link_mapping",
    );
  }

  // Reuse existing PENDING intent if available to prevent intent accumulation
  let intent = await prisma.paymentIntent.findFirst({
    where: {
      userId: user.id,
      offerId: offer.id,
      provider: "DROPP",
      status: "PENDING",
      currency: price.currency,
      amount: price.amount,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!intent) {
    const payload = `dropp:${randomUUID()}`;
    intent = await prisma.paymentIntent.create({
      data: {
        provider: "DROPP",
        userId: user.id,
        conversationId: input.conversationId ?? null,
        offerId: offer.id,
        status: "PENDING",
        amount: price.amount,
        currency: price.currency,
        providerInvoicePayload: payload,
      },
    });
  }

  const minter = input.createVaultLinkFn ?? createVaultLink;
  const vaultLink = await minter({
    linkId: checkout.externalLinkId,
    paymentIntentId: intent.id,
    offerSlug: offer.slug,
    telegramUserId: user.telegramUserId,
  });

  const language = input.language ?? "en";
  const customButtonText = droppCardButtonLabel(language);

  logger.info("dropp.checkout.minted", {
    userId: user.id,
    offerSlug: offer.slug,
    paymentIntentId: intent.id,
    linkId: checkout.externalLinkId,
  });

  return {
    paymentIntentId: intent.id,
    miniAppUrl: vaultLink.miniAppUrl,
    shareUrl: vaultLink.shareUrl,
    buttonText: customButtonText,
    amount: price.amount,
    currency: price.currency,
    offerSlug: offer.slug,
  };
}
