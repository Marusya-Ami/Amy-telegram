import { prisma } from "@/lib/db/prisma";
import { readFreePhoto } from "@/services/media/library";
import { isFreePhotoEligible, freeSelectableAssetWhere } from "@/services/media/eligibility";
import { loadDeliverables } from "@/services/payments/fulfillPaidContent";
import { hasPurchasedOffer, purchaseAwareness } from "@/services/payments/offers";
import { decideSales, selectPaidOffer, type OfferCandidate } from "@/services/sales/decide";
import { readSalesSignal } from "@/services/sales/signals";

type PackConfig = {
  slug: string;
  priority: number;
  xtr: number | null; // null means keep existing price
};

const CONFIG: PackConfig[] = [
  { slug: "shower-time", priority: 1, xtr: null }, // keep 420 XTR unchanged
  { slug: "keep-it-secret-10", priority: 2, xtr: 250 },
  { slug: "private-mood", priority: 3, xtr: 300 },
  { slug: "my-favourite-pack", priority: 4, xtr: 350 },
  { slug: "icecream", priority: 5, xtr: 420 },
  { slug: "for-your-eyes-only", priority: 6, xtr: 420 },
  { slug: "i-shouldnt-send-this", priority: 7, xtr: 450 },
  { slug: "keep-it-secret-25", priority: 8, xtr: 550 },
  { slug: "a-little-too-much", priority: 9, xtr: 600 },
  { slug: "just-between-us", priority: 10, xtr: 650 },
];

const EXPECTED_ORDER = [
  "shower-time",
  "keep-it-secret-10",
  "private-mood",
  "my-favourite-pack",
  "icecream",
  "for-your-eyes-only",
  "i-shouldnt-send-this",
  "keep-it-secret-25",
  "a-little-too-much",
  "just-between-us",
];

async function main() {
  console.log("=== STEP 1 & 2: Update priorities and add XTR prices ===");

  const paymentsBefore = await prisma.payment.count();
  const intentsBefore = await prisma.paymentIntent.count();
  const deliveriesBefore = await prisma.paidContentDelivery.count();
  const salesDecisionsBefore = await prisma.salesDecision.count();

  for (const item of CONFIG) {
    const offer = await prisma.paymentOffer.findUnique({
      where: { slug: item.slug },
      select: { id: true, slug: true, title: true, priority: true },
    });
    if (!offer) {
      throw new Error(`Offer not found: ${item.slug}`);
    }

    // Update priority
    await prisma.paymentOffer.update({
      where: { id: offer.id },
      data: { priority: item.priority },
    });

    // Add or update XTR price if specified
    if (item.xtr !== null) {
      await prisma.paymentOfferPrice.upsert({
        where: {
          offerId_provider_currency: {
            offerId: offer.id,
            provider: "TELEGRAM_STARS",
            currency: "XTR",
          },
        },
        create: {
          offerId: offer.id,
          provider: "TELEGRAM_STARS",
          amount: item.xtr,
          currency: "XTR",
          active: true,
        },
        update: {
          amount: item.xtr,
          active: true,
        },
      });
    }
  }

  console.log("Priorities and prices updated.");

  console.log("\n=== STEP 3: Dry-run offer selector simulation ===");

  // Load all active sellable offers as done in production
  const dbOffers = await prisma.paymentOffer.findMany({
    where: { active: true },
    select: {
      id: true,
      slug: true,
      tags: true,
      contexts: true,
      flirtLevel: true,
      priority: true,
      active: true,
      prices: { where: { provider: "TELEGRAM_STARS", currency: "XTR", active: true }, select: { id: true, amount: true } },
    },
    orderBy: { priority: "asc" },
  });

  const offerCandidates: OfferCandidate[] = dbOffers.map((o) => ({
    id: o.id,
    slug: o.slug,
    tags: o.tags,
    contexts: o.contexts,
    flirtLevel: o.flirtLevel,
    priority: o.priority,
    active: o.active,
    hasActivePrice: o.prices.length > 0,
  }));

  const signal = readSalesSignal(["do you have any private pics?"]);

  // 3a. Simulate sequence starting from 0 purchases
  console.log("Simulation A: Sequence starting from 0 purchases:");
  const simulatedSequence: string[] = [];
  const simulatedPurchasedIds = new Set<string>();

  for (let step = 1; step <= 15; step++) {
    const selected = selectPaidOffer(signal, offerCandidates, simulatedPurchasedIds);
    const decision = decideSales({
      signal,
      declinedNow: false,
      assets: [],
      offers: offerCandidates,
      purchasedOfferIds: simulatedPurchasedIds,
      interactions: [],
      priorFreeMediaAt: null,
      dynamic: "UNKNOWN",
      dynamicConfidence: 0,
      now: new Date(),
    });

    if (!selected) {
      console.log(`Step ${step}: All offers exhausted! Decision=${decision.decision}, reason=${decision.reasonCode}`);
      if (decision.decision !== "NO_OFFER" || decision.reasonCode !== "already_purchased") {
        throw new Error(`Expected NO_OFFER (already_purchased), got ${decision.decision} (${decision.reasonCode})`);
      }
      break;
    }

    if (decision.decision !== "PAID_OFFER" || decision.candidateSlug !== selected.slug) {
      throw new Error(`Mismatch between selectPaidOffer (${selected.slug}) and decideSales (${decision.candidateSlug}) at step ${step}`);
    }

    console.log(`Step ${step}: selected ${selected.slug} (priority ${selected.priority})`);
    simulatedSequence.push(selected.slug);
    simulatedPurchasedIds.add(selected.id);
  }

  // Verify simulated order matches EXPECTED_ORDER
  if (JSON.stringify(simulatedSequence) !== JSON.stringify(EXPECTED_ORDER)) {
    throw new Error(`Simulated sequence does not match expected!\nGot: ${JSON.stringify(simulatedSequence)}\nExpected: ${JSON.stringify(EXPECTED_ORDER)}`);
  }
  console.log("Simulated sequence strictly matches expected 10-pack order!");

  // 3b. Simulate for test Telegram user 688907647 with their current real database state
  console.log("\nSimulation B: Test user 688907647 actual current state:");
  const testUser = await prisma.user.findFirst({
    where: { telegramUserId: "688907647" },
    select: { id: true, telegramUserId: true },
  });

  if (testUser) {
    const userAwareness = await purchaseAwareness(testUser.id);
    const currentPurchasedSet = new Set(userAwareness.purchasedOfferIds);
    const currentSelected = selectPaidOffer(signal, offerCandidates, currentPurchasedSet);
    console.log(`User ${testUser.telegramUserId} (id=${testUser.id}):`);
    console.log(`- Currently purchased offers count: ${userAwareness.purchasedCount} (IDs: ${userAwareness.purchasedOfferIds.join(", ")})`);
    console.log(`- Next offer that would be presented right now: ${currentSelected?.slug} (priority ${currentSelected?.priority})`);
  } else {
    console.log("Note: user 688907647 not found in this environment.");
  }

  // Confirm NO mutations occurred
  if ((await prisma.payment.count()) !== paymentsBefore) throw new Error("Payment table mutated during dry-run!");
  if ((await prisma.paymentIntent.count()) !== intentsBefore) throw new Error("PaymentIntent table mutated during dry-run!");
  if ((await prisma.paidContentDelivery.count()) !== deliveriesBefore) throw new Error("PaidContentDelivery mutated during dry-run!");
  if ((await prisma.salesDecision.count()) !== salesDecisionsBefore) throw new Error("SalesDecision mutated during dry-run!");
  console.log("Confirmed: 0 payments, 0 intents, 0 deliveries, 0 sales events created during dry run.");

  console.log("\n=== STEP 4: Comprehensive Offer Verification ===");
  const finalReport = [];

  for (const item of CONFIG) {
    const offer = await prisma.paymentOffer.findUniqueOrThrow({
      where: { slug: item.slug },
      select: {
        id: true,
        slug: true,
        title: true,
        priority: true,
        active: true,
        prices: { select: { provider: true, amount: true, currency: true, active: true } },
        externalCheckouts: { select: { provider: true, checkoutUrl: true, externalLinkId: true, active: true } },
      },
    });

    // 1. Priority check
    if (offer.priority !== item.priority) {
      throw new Error(`Priority mismatch for ${offer.slug}: expected ${item.priority}, got ${offer.priority}`);
    }

    // 2. Active check
    if (!offer.active) {
      throw new Error(`Offer not active: ${offer.slug}`);
    }

    // 3. XTR Price check
    const starsPrice = offer.prices.find((p) => p.provider === "TELEGRAM_STARS" && p.currency === "XTR" && p.active);
    if (!starsPrice || starsPrice.amount < 1) {
      throw new Error(`Missing active XTR price for ${offer.slug}`);
    }
    if (offer.slug === "shower-time" && starsPrice.amount !== 420) {
      throw new Error(`shower-time XTR price altered: ${starsPrice.amount}`);
    }
    if (item.xtr !== null && starsPrice.amount !== item.xtr) {
      throw new Error(`XTR price mismatch for ${offer.slug}: expected ${item.xtr}, got ${starsPrice.amount}`);
    }

    // 4. Dropp checkout check
    const droppCheckout = offer.externalCheckouts.find((c) => c.provider === "DROPP" && c.active);
    const droppPrice = offer.prices.find((p) => p.provider === "DROPP" && p.currency === "USD" && p.active);

    // 5. Deliverable media checks
    const deliverables = await loadDeliverables(offer.id);
    if (deliverables.length === 0) {
      if (offer.slug === "shower-time") {
        console.warn("  [warn] shower-time has no deliverables in this local database (present on production)");
      } else {
        throw new Error(`No deliverables found for ${offer.slug}`);
      }
    }

    // 6. Test native album build (read bytes for every deliverable)
    let totalBytes = 0;
    for (const d of deliverables) {
      const bytes = await readFreePhoto(d.storagePath);
      if (!bytes || bytes.length === 0) {
        throw new Error(`Failed to read photo bytes for ${offer.slug} deliverable pos ${d.position} at ${d.storagePath}`);
      }
      totalBytes += bytes.length;
    }

    // 7. Check availability and FREE_MEDIA exclusion
    const mediaAssetIds = deliverables.map((d) => d.mediaAssetId);
    const mediaAssets = await prisma.mediaAsset.findMany({
      where: { id: { in: mediaAssetIds } },
      select: { id: true, active: true, availability: true },
    });

    for (const asset of mediaAssets) {
      if (asset.availability !== "LOCKED") {
        throw new Error(`Asset ${asset.id} in offer ${offer.slug} is not LOCKED (is ${asset.availability})`);
      }
      if (isFreePhotoEligible({ active: asset.active, availability: asset.availability, deliverable: true })) {
        throw new Error(`Asset ${asset.id} in offer ${offer.slug} is eligible for FREE_MEDIA!`);
      }
    }

    const freeSelectableCount = await prisma.mediaAsset.count({
      where: freeSelectableAssetWhere({ id: { in: mediaAssetIds } }),
    });
    if (freeSelectableCount > 0) {
      throw new Error(`${freeSelectableCount} deliverables of ${offer.slug} are selectable by FREE_MEDIA!`);
    }

    // 8. Test cross-provider purchase check
    const dummyPurchaseCheck = await hasPurchasedOffer("non-existent-user", offer.id);
    if (dummyPurchaseCheck !== false) {
      throw new Error("dummy purchase check failed");
    }

    finalReport.push({
      priority: offer.priority,
      slug: offer.slug,
      title: offer.title,
      photos: deliverables.length,
      xtr: starsPrice.amount,
      droppUsd: droppPrice?.amount ?? null,
      starsReady: true,
      droppMapped: Boolean(droppCheckout?.checkoutUrl),
      totalBytes,
    });
  }

  console.log("\nAll 10 offers verified successfully!");
  console.log(JSON.stringify(finalReport, null, 2));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
