import { prisma } from "@/lib/db/prisma";

export const SHOWER_TIME_SLUG = "shower-time";
export const SHOWER_TIME_STARS = 420;
export const SHOWER_TIME_CURRENCY = "XTR";

const SHOWER_TIME_TITLE = "Shower time 💋";
const SHOWER_TIME_DESCRIPTION = "2 private photos";

export async function ensureShowerTimeOffer() {
  const offer = await prisma.paymentOffer.upsert({
    where: { slug: SHOWER_TIME_SLUG },
    create: {
      slug: SHOWER_TIME_SLUG,
      title: SHOWER_TIME_TITLE,
      description: SHOWER_TIME_DESCRIPTION,
      kind: "PAID_CONTENT",
      tags: ["private", "shower"],
      contexts: ["flirty", "shower", "private_photos"],
      flirtLevel: 2,
      active: true,
    },
    update: {
      title: SHOWER_TIME_TITLE,
      description: SHOWER_TIME_DESCRIPTION,
      kind: "PAID_CONTENT",
      tags: ["private", "shower"],
      contexts: ["flirty", "shower", "private_photos"],
      flirtLevel: 2,
      active: true,
    },
  });
  const price = await prisma.paymentOfferPrice.upsert({
    where: {
      offerId_provider_currency: {
        offerId: offer.id,
        provider: "TELEGRAM_STARS",
        currency: SHOWER_TIME_CURRENCY,
      },
    },
    create: {
      offerId: offer.id,
      provider: "TELEGRAM_STARS",
      amount: SHOWER_TIME_STARS,
      currency: SHOWER_TIME_CURRENCY,
      active: true,
    },
    update: {
      amount: SHOWER_TIME_STARS,
      active: true,
    },
  });
  return { offer, price };
}

export async function hasPurchasedOffer(userId: string, offerId: string): Promise<boolean> {
  const payment = await prisma.payment.findFirst({
    where: { userId, offerId, status: "PAID" },
    select: { id: true },
  });
  return Boolean(payment);
}

export async function purchaseAwareness(userId: string): Promise<{
  purchasedOfferIds: string[];
  purchasedCount: number;
  latestPurchaseAt: Date | null;
}> {
  const rows = await prisma.payment.findMany({
    where: { userId, status: "PAID" },
    select: { offerId: true, paidAt: true },
    orderBy: { paidAt: "desc" },
  });
  const purchasedOfferIds = [...new Set(rows.map((row) => row.offerId))];
  return {
    purchasedOfferIds,
    purchasedCount: purchasedOfferIds.length,
    latestPurchaseAt: rows[0]?.paidAt ?? null,
  };
}
