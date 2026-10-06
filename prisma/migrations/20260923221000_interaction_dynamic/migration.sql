-- CreateEnum
CREATE TYPE "InteractionDynamic" AS ENUM ('UNKNOWN', 'DOMINANT_USER', 'DOMINANT_AMY', 'EQUAL');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "interactionDynamic" "InteractionDynamic" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "User" ADD COLUMN "interactionDynamicConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "interactionDynamicEvidence" VARCHAR(200);
