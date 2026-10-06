CREATE TYPE "MediaSentSource" AS ENUM ('FREE_MEDIA', 'PAID_CONTENT', 'MANUAL', 'PROACTIVE');

CREATE TABLE "MediaSent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "source" "MediaSentSource" NOT NULL,
    "telegramMessageId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaSent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MediaSent_userId_sentAt_idx" ON "MediaSent"("userId", "sentAt");
CREATE INDEX "MediaSent_userId_mediaAssetId_idx" ON "MediaSent"("userId", "mediaAssetId");
CREATE INDEX "MediaSent_mediaAssetId_idx" ON "MediaSent"("mediaAssetId");
CREATE INDEX "MediaSent_conversationId_idx" ON "MediaSent"("conversationId");

ALTER TABLE "MediaSent" ADD CONSTRAINT "MediaSent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaSent" ADD CONSTRAINT "MediaSent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaSent" ADD CONSTRAINT "MediaSent_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
