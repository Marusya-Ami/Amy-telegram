CREATE TYPE "MediaAvailability" AS ENUM ('FREE', 'LOCKED');
CREATE TYPE "PaymentOfferMediaRole" AS ENUM ('PREVIEW', 'DELIVERABLE');

ALTER TABLE "MediaAsset" ADD COLUMN "availability" "MediaAvailability" NOT NULL DEFAULT 'FREE';

CREATE TABLE "PaymentOfferMedia" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "role" "PaymentOfferMediaRole" NOT NULL,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOfferMedia_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaidContentDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "paymentOfferMediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "telegramMessageId" TEXT,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mediaAssetId" TEXT NOT NULL,

    CONSTRAINT "PaidContentDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentOfferMedia_offerId_mediaAssetId_role_key" ON "PaymentOfferMedia"("offerId", "mediaAssetId", "role");
CREATE INDEX "PaymentOfferMedia_offerId_role_active_position_idx" ON "PaymentOfferMedia"("offerId", "role", "active", "position");
CREATE INDEX "PaymentOfferMedia_mediaAssetId_role_active_idx" ON "PaymentOfferMedia"("mediaAssetId", "role", "active");

CREATE UNIQUE INDEX "PaidContentDelivery_paymentId_paymentOfferMediaId_key" ON "PaidContentDelivery"("paymentId", "paymentOfferMediaId");
CREATE INDEX "PaidContentDelivery_userId_offerId_deliveredAt_idx" ON "PaidContentDelivery"("userId", "offerId", "deliveredAt");

ALTER TABLE "PaymentOfferMedia" ADD CONSTRAINT "PaymentOfferMedia_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentOfferMedia" ADD CONSTRAINT "PaymentOfferMedia_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaidContentDelivery" ADD CONSTRAINT "PaidContentDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaidContentDelivery" ADD CONSTRAINT "PaidContentDelivery_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaidContentDelivery" ADD CONSTRAINT "PaidContentDelivery_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaidContentDelivery" ADD CONSTRAINT "PaidContentDelivery_paymentOfferMediaId_fkey" FOREIGN KEY ("paymentOfferMediaId") REFERENCES "PaymentOfferMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaidContentDelivery" ADD CONSTRAINT "PaidContentDelivery_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
