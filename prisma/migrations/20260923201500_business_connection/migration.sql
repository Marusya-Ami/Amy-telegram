-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "businessConnectionId" TEXT;

-- CreateTable
CREATE TABLE "BusinessConnection" (
    "connectionId" TEXT NOT NULL,
    "businessUserId" TEXT NOT NULL,
    "userChatId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL,
    "canReply" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessConnection_pkey" PRIMARY KEY ("connectionId")
);
