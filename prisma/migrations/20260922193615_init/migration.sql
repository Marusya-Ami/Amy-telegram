-- CreateEnum
CREATE TYPE "RelationshipStage" AS ENUM ('NEW', 'ACQUAINTANCE', 'ENGAGED', 'CLOSE', 'VIP', 'DORMANT');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('USER', 'AMY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'PAYMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TelegramUpdateStatus" AS ENUM ('PROCESSING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "languageCode" TEXT,
    "relationshipStage" "RelationshipStage" NOT NULL DEFAULT 'NEW',
    "conversationSummary" TEXT,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "proactiveEnabled" BOOLEAN NOT NULL DEFAULT true,
    "messagesCount" INTEGER NOT NULL DEFAULT 0,
    "totalStarsSpent" INTEGER NOT NULL DEFAULT 0,
    "lastUserMessageAt" TIMESTAMP(3),
    "lastAmyMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "platformConversationId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "sender" "MessageSender" NOT NULL,
    "type" "MessageType" NOT NULL,
    "text" TEXT,
    "telegramMessageId" TEXT,
    "replyToMessageId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramUpdate" (
    "id" TEXT NOT NULL,
    "updateId" TEXT NOT NULL,
    "status" "TelegramUpdateStatus" NOT NULL DEFAULT 'PROCESSING',
    "inboundMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");

-- CreateIndex
CREATE INDEX "User_lastUserMessageAt_idx" ON "User"("lastUserMessageAt");

-- CreateIndex
CREATE INDEX "User_relationshipStage_idx" ON "User"("relationshipStage");

-- CreateIndex
CREATE INDEX "Conversation_userId_idx" ON "Conversation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_platform_platformConversationId_key" ON "Conversation"("platform", "platformConversationId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_userId_createdAt_idx" ON "Message"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_direction_createdAt_idx" ON "Message"("direction", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_telegramMessageId_key" ON "Message"("conversationId", "telegramMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUpdate_updateId_key" ON "TelegramUpdate"("updateId");

-- CreateIndex
CREATE INDEX "TelegramUpdate_status_updatedAt_idx" ON "TelegramUpdate"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
