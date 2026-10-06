CREATE TYPE "PaidOfferExecutionStatus" AS ENUM ('CLAIMED', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "PaidOfferExecution" (
    "id" TEXT NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "offerId" TEXT,
    "paymentIntentId" TEXT,
    "telegramMessageId" TEXT,
    "status" "PaidOfferExecutionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaidOfferExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaidOfferExecution_triggerKey_key" ON "PaidOfferExecution"("triggerKey");
CREATE UNIQUE INDEX "PaidOfferExecution_paymentIntentId_key" ON "PaidOfferExecution"("paymentIntentId");
CREATE INDEX "PaidOfferExecution_userId_createdAt_idx" ON "PaidOfferExecution"("userId", "createdAt");

ALTER TABLE "PaidOfferExecution" ADD CONSTRAINT "PaidOfferExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaidOfferExecution" ADD CONSTRAINT "PaidOfferExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaidOfferExecution" ADD CONSTRAINT "PaidOfferExecution_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "PaymentOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaidOfferExecution" ADD CONSTRAINT "PaidOfferExecution_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
