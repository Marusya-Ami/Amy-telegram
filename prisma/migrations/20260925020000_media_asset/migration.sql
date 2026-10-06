-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('PHOTO', 'STICKER');

-- CreateEnum
CREATE TYPE "MediaCategory" AS ENUM ('selfie', 'home', 'work', 'luna', 'cosplay', 'morning', 'night', 'cute', 'flirty', 'casual', 'other');

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "telegramFileId" TEXT NOT NULL,
    "telegramFileUniqueId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "category" "MediaCategory" NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "tags" TEXT[],
    "mood" VARCHAR(40) NOT NULL,
    "flirtLevel" INTEGER NOT NULL,
    "peopleCount" INTEGER NOT NULL,
    "hasAmy" BOOLEAN NOT NULL,
    "hasLuna" BOOLEAN NOT NULL,
    "contexts" TEXT[],
    "notes" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivationRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_telegramFileUniqueId_key" ON "MediaAsset"("telegramFileUniqueId");

-- CreateIndex
CREATE INDEX "MediaAsset_active_createdAt_idx" ON "MediaAsset"("active", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_category_active_idx" ON "MediaAsset"("category", "active");
