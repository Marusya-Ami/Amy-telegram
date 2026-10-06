ALTER TYPE "SalesDecisionKind" ADD VALUE 'TIP';
ALTER TYPE "SalesIntent" ADD VALUE 'TIP_DISCUSSION';

CREATE TYPE "TipLinkStatus" AS ENUM ('LINK_SENT', 'PAID');

CREATE TABLE "TipLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "triggerMessageId" TEXT,
    "status" "TipLinkStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipLink_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TipLink_userId_status_createdAt_idx" ON "TipLink"("userId", "status", "createdAt");

ALTER TABLE "TipLink" ADD CONSTRAINT "TipLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TipLink" ADD CONSTRAINT "TipLink_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TipLink" ADD CONSTRAINT "TipLink_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
