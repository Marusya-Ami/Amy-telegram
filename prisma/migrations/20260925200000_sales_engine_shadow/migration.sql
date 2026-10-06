-- AlterTable
ALTER TABLE "PaymentOffer" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PaymentOffer" ADD COLUMN "contexts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PaymentOffer" ADD COLUMN "flirtLevel" INTEGER;

-- Conservative retrieval metadata for the existing test offer. No new content claims.
UPDATE "PaymentOffer"
SET
    "contexts" = ARRAY['flirty', 'shower', 'private_photos']::TEXT[],
    "tags" = ARRAY['private', 'shower']::TEXT[],
    "flirtLevel" = 2
WHERE "slug" = 'shower-time';

-- CreateEnum
CREATE TYPE "SalesEngineMode" AS ENUM ('SHADOW', 'LIVE');

-- CreateEnum
CREATE TYPE "SalesDecisionKind" AS ENUM ('NO_OFFER', 'FREE_MEDIA', 'PAID_OFFER', 'SUPPRESS');

-- CreateEnum
CREATE TYPE "SalesIntent" AS ENUM ('NONE', 'MEDIA_REQUEST', 'PREMIUM_MEDIA_REQUEST', 'FLIRT', 'REACTION_TO_MEDIA', 'PURCHASE_DISCUSSION');

-- CreateEnum
CREATE TYPE "CommercialReadiness" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SalesEmotionalState" AS ENUM ('NORMAL', 'SENSITIVE', 'DISTRESSED');

-- CreateEnum
CREATE TYPE "UserOfferInteractionType" AS ENUM ('SHOWN', 'OPENED', 'PURCHASED', 'DECLINED');

-- CreateEnum
CREATE TYPE "UserOfferInteractionSource" AS ENUM ('SALES_ENGINE', 'OWNER_TEST', 'PAYMENT');

-- CreateTable
CREATE TABLE "SalesDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "triggerMessageId" TEXT,
    "mode" "SalesEngineMode" NOT NULL,
    "decision" "SalesDecisionKind" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "intent" "SalesIntent" NOT NULL,
    "flirtLevel" INTEGER NOT NULL,
    "commercialReadiness" "CommercialReadiness" NOT NULL,
    "emotionalState" "SalesEmotionalState" NOT NULL,
    "desiredContexts" JSONB NOT NULL,
    "candidateMediaAssetId" TEXT,
    "candidateOfferId" TEXT,
    "reasonCode" VARCHAR(64),
    "reasonSummary" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserOfferInteraction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "conversationId" TEXT,
    "type" "UserOfferInteractionType" NOT NULL,
    "source" "UserOfferInteractionSource" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserOfferInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesDecision_createdAt_idx" ON "SalesDecision"("createdAt");

-- CreateIndex
CREATE INDEX "SalesDecision_userId_createdAt_idx" ON "SalesDecision"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesDecision_decision_createdAt_idx" ON "SalesDecision"("decision", "createdAt");

-- CreateIndex
CREATE INDEX "UserOfferInteraction_userId_offerId_type_createdAt_idx" ON "UserOfferInteraction"("userId", "offerId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "UserOfferInteraction_userId_type_createdAt_idx" ON "UserOfferInteraction"("userId", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "SalesDecision" ADD CONSTRAINT "SalesDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDecision" ADD CONSTRAINT "SalesDecision_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDecision" ADD CONSTRAINT "SalesDecision_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDecision" ADD CONSTRAINT "SalesDecision_candidateMediaAssetId_fkey" FOREIGN KEY ("candidateMediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDecision" ADD CONSTRAINT "SalesDecision_candidateOfferId_fkey" FOREIGN KEY ("candidateOfferId") REFERENCES "PaymentOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOfferInteraction" ADD CONSTRAINT "UserOfferInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOfferInteraction" ADD CONSTRAINT "UserOfferInteraction_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOfferInteraction" ADD CONSTRAINT "UserOfferInteraction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
