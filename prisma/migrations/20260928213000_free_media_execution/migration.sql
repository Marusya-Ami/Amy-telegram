CREATE TYPE "FreeMediaExecutionStatus" AS ENUM ('CLAIMED', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "FreeMediaExecution" (
    "id" TEXT NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "mediaAssetId" TEXT,
    "telegramMessageId" TEXT,
    "status" "FreeMediaExecutionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeMediaExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FreeMediaExecution_triggerKey_key" ON "FreeMediaExecution"("triggerKey");
CREATE INDEX "FreeMediaExecution_userId_createdAt_idx" ON "FreeMediaExecution"("userId", "createdAt");

ALTER TABLE "FreeMediaExecution" ADD CONSTRAINT "FreeMediaExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FreeMediaExecution" ADD CONSTRAINT "FreeMediaExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
