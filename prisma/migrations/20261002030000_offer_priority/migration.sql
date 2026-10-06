-- Lower priority is offered first. Stars sellability is separate from this order.
ALTER TABLE "PaymentOffer" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "PaymentOffer_active_priority_idx" ON "PaymentOffer"("active", "priority");

UPDATE "PaymentOffer" SET "priority" = 1 WHERE "slug" = 'shower-time';
UPDATE "PaymentOffer" SET "priority" = 2 WHERE "slug" = 'keep-it-secret-10';
UPDATE "PaymentOffer" SET "priority" = 3 WHERE "slug" = 'just-between-us';
UPDATE "PaymentOffer" SET "priority" = 4 WHERE "slug" = 'private-mood';
UPDATE "PaymentOffer" SET "priority" = 5 WHERE "slug" = 'icecream';
UPDATE "PaymentOffer" SET "priority" = 6 WHERE "slug" = 'a-little-too-much';
UPDATE "PaymentOffer" SET "priority" = 7 WHERE "slug" = 'for-your-eyes-only';
UPDATE "PaymentOffer" SET "priority" = 8 WHERE "slug" = 'i-shouldnt-send-this';
UPDATE "PaymentOffer" SET "priority" = 9 WHERE "slug" = 'keep-it-secret-25';
UPDATE "PaymentOffer" SET "priority" = 10 WHERE "slug" = 'my-favourite-pack';
