-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('PERSONAL_FACT', 'PREFERENCE', 'INTEREST', 'RELATIONSHIP', 'WORK', 'LOCATION', 'PET', 'ROUTINE', 'OTHER');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('UPCOMING', 'PAST', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PromiseAuthor" AS ENUM ('USER', 'AMY');

-- CreateEnum
CREATE TYPE "PromiseStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FollowUpReasonType" AS ENUM ('EVENT', 'PROMISE', 'OTHER');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'SENT', 'CANCELLED', 'SKIPPED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "conversationSummaryThroughCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deleteRequestedAt" TIMESTAMP(3),
ADD COLUMN     "timezone" TEXT;

-- CreateTable
CREATE TABLE "UserMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "MemoryType" NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL,
    "sourceMessageId" TEXT,
    "firstLearnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportantEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "eventAt" TIMESTAMP(3),
    "timeKnown" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT,
    "status" "EventStatus" NOT NULL DEFAULT 'UNKNOWN',
    "emotionalContext" TEXT,
    "sourceMessageId" TEXT,
    "followUpEligible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportantEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPromise" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "madeBy" "PromiseAuthor" NOT NULL,
    "text" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "status" "PromiseStatus" NOT NULL DEFAULT 'OPEN',
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPromise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reasonType" "FollowUpReasonType" NOT NULL,
    "eventId" TEXT,
    "promiseId" TEXT,
    "context" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserMemory_userId_active_importance_idx" ON "UserMemory"("userId", "active", "importance");

-- CreateIndex
CREATE INDEX "UserMemory_userId_key_active_idx" ON "UserMemory"("userId", "key", "active");

-- CreateIndex
CREATE INDEX "ImportantEvent_userId_status_idx" ON "ImportantEvent"("userId", "status");

-- CreateIndex
CREATE INDEX "ImportantEvent_userId_eventAt_idx" ON "ImportantEvent"("userId", "eventAt");

-- CreateIndex
CREATE INDEX "UserPromise_userId_status_idx" ON "UserPromise"("userId", "status");

-- CreateIndex
CREATE INDEX "FollowUp_status_scheduledAt_idx" ON "FollowUp"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "FollowUp_userId_status_scheduledAt_idx" ON "FollowUp"("userId", "status", "scheduledAt");

-- AddForeignKey
ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportantEvent" ADD CONSTRAINT "ImportantEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPromise" ADD CONSTRAINT "UserPromise_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ImportantEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_promiseId_fkey" FOREIGN KEY ("promiseId") REFERENCES "UserPromise"("id") ON DELETE CASCADE ON UPDATE CASCADE;
