-- Public checkout mapping. Does not create a price, intent, or payment.
CREATE TABLE "PaymentOfferExternalCheckout" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "checkoutUrl" TEXT NOT NULL,
    "externalLinkId" TEXT,
    "linkIdEvidence" TEXT NOT NULL DEFAULT 'unknown',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOfferExternalCheckout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentOfferExternalCheckout_offerId_provider_key" ON "PaymentOfferExternalCheckout"("offerId", "provider");
CREATE INDEX "PaymentOfferExternalCheckout_provider_externalLinkId_idx" ON "PaymentOfferExternalCheckout"("provider", "externalLinkId");

ALTER TABLE "PaymentOfferExternalCheckout" ADD CONSTRAINT "PaymentOfferExternalCheckout_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- shower-time only. The link id is Dropp's own /link/{linkId} route parameter from the public redirect.
-- The public code in /s/{code} is not stored as the link id.
INSERT INTO "PaymentOfferExternalCheckout" (
    "id",
    "offerId",
    "provider",
    "checkoutUrl",
    "externalLinkId",
    "linkIdEvidence",
    "active",
    "createdAt",
    "updatedAt"
)
SELECT
    'dropp_checkout_shower_time',
    "id",
    'DROPP',
    'https://app.dropp.fans/s/txURaBko',
    'link_iYLox77NhTpHWtRLODek',
    'public_redirect_route',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "PaymentOffer"
WHERE "slug" = 'shower-time'
ON CONFLICT ("offerId", "provider") DO NOTHING;
