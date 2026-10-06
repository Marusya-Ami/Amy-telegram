-- CreateTable
CREATE TABLE "DroppWebhookCapture" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "httpMethod" VARCHAR(16) NOT NULL,
    "contentType" VARCHAR(200),
    "bodyKind" VARCHAR(32) NOT NULL,
    "bodySha256" VARCHAR(64) NOT NULL,
    "bodyBytes" INTEGER NOT NULL,
    "headerNames" JSONB NOT NULL,
    "signatureHeaders" JSONB NOT NULL,
    "authorizationScheme" VARCHAR(32),
    "cookieHeaderPresent" BOOLEAN NOT NULL DEFAULT false,
    "authentication" VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED',
    "topLevelKeys" JSONB NOT NULL,
    "observedFields" JSONB NOT NULL,
    "structure" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "seenBefore" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DroppWebhookCapture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DroppWebhookCapture_bodySha256_receivedAt_idx" ON "DroppWebhookCapture"("bodySha256", "receivedAt");

-- CreateIndex
CREATE INDEX "DroppWebhookCapture_receivedAt_idx" ON "DroppWebhookCapture"("receivedAt");
