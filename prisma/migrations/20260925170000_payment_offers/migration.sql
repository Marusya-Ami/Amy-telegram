-- CreateEnum
CREATE TYPE "PaymentOfferKind" AS ENUM ('PAID_CONTENT', 'TIP', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('TELEGRAM_STARS', 'DROPP');

-- CreateEnum
CREATE TYPE "PaymentRecordStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateTable
CREATE TABLE "PaymentOffer" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PaymentOfferKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOfferPrice" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOfferPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "offerId" TEXT NOT NULL,
    "status" "PaymentRecordStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "providerInvoicePayload" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "userId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentRecordStatus" NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOffer_slug_key" ON "PaymentOffer"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOfferPrice_offerId_provider_currency_key" ON "PaymentOfferPrice"("offerId", "provider", "currency");

-- CreateIndex
CREATE INDEX "PaymentOfferPrice_offerId_provider_active_idx" ON "PaymentOfferPrice"("offerId", "provider", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_providerInvoicePayload_key" ON "PaymentIntent"("providerInvoicePayload");

-- CreateIndex
CREATE INDEX "PaymentIntent_userId_offerId_status_idx" ON "PaymentIntent"("userId", "offerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "Payment_userId_offerId_status_idx" ON "Payment"("userId", "offerId", "status");

-- AddForeignKey
ALTER TABLE "PaymentOfferPrice" ADD CONSTRAINT "PaymentOfferPrice_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Idempotent test offer. No Dropp price.
INSERT INTO "PaymentOffer" ("id", "slug", "title", "description", "kind", "active", "createdAt", "updatedAt")
VALUES ('seed_shower_time', 'shower-time', 'Shower time 💋', '2 private photos', 'PAID_CONTENT', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO UPDATE SET
    "title" = EXCLUDED."title",
    "description" = EXCLUDED."description",
    "kind" = EXCLUDED."kind",
    "active" = true,
    "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "PaymentOfferPrice" ("id", "offerId", "provider", "amount", "currency", "active", "createdAt", "updatedAt")
SELECT 'seed_shower_time_xtr', "id", 'TELEGRAM_STARS', 420, 'XTR', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "PaymentOffer"
WHERE "slug" = 'shower-time'
ON CONFLICT ("offerId", "provider", "currency") DO UPDATE SET
    "amount" = EXCLUDED."amount",
    "active" = true,
    "updatedAt" = CURRENT_TIMESTAMP;
