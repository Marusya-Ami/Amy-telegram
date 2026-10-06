-- CreateEnum
CREATE TYPE "FollowUpPhase" AS ENUM ('BEFORE_EVENT', 'AFTER_EVENT');

-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "phase" "FollowUpPhase";
