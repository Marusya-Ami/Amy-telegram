-- Durable follow-up send attempt count. Retry state must survive process restarts.
ALTER TABLE "FollowUp" ADD COLUMN "sendAttempts" INTEGER NOT NULL DEFAULT 0;
