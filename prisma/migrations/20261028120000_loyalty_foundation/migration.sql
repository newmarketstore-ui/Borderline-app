-- Loyalty foundation (Member / PointsLedger / Redemption / LoyaltyConfig / MigrationSnapshot / WebhookEvent).
-- Generated offline with:
--   prisma migrate diff --from-schema-datamodel <schema before this change> --to-schema-datamodel prisma/schema.prisma --script
-- Additive only: creates new tables, touches no existing table.
-- Applied in production by `npm run setup` (prisma migrate deploy).
--
-- Idempotency note: "PointsLedger_type_referenceId_key" is a plain UNIQUE index on (type, referenceId).
-- Postgres treats NULLs as distinct (default NULLS DISTINCT), so rows with referenceId IS NULL never collide;
-- every ledger row that must be idempotent (earn / refund_reverse / redeem / migrate / staff adjust) carries a referenceId.

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "paidUntil" TIMESTAMP(3),
    "balanceCached" INTEGER NOT NULL DEFAULT 0,
    "pendingCached" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsLedger" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "orderId" TEXT,
    "orderName" TEXT,
    "note" TEXT,
    "meta" JSONB,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "discountCodeId" TEXT,
    "discountCode" TEXT,
    "orderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "channel" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyConfig" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "pointsPerDollar" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "redeemPointsPerDollar" INTEGER NOT NULL DEFAULT 100,
    "minRedeemPoints" INTEGER NOT NULL DEFAULT 500,
    "redeemStepPoints" INTEGER NOT NULL DEFAULT 100,
    "excludedProductTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "earnOnShipping" BOOLEAN NOT NULL DEFAULT false,
    "earnOnTax" BOOLEAN NOT NULL DEFAULT false,
    "pendingDays" INTEGER NOT NULL DEFAULT 0,
    "expiryMonths" INTEGER,
    "paidTierMultiplier" DECIMAL(6,3) NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationSnapshot" (
    "id" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'appstle_loyalty',
    "raw" JSONB NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ledgerId" TEXT,

    CONSTRAINT "MigrationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_shopifyCustomerId_key" ON "Member"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "Member_shopDomain_email_idx" ON "Member"("shopDomain", "email");

-- CreateIndex
CREATE INDEX "Member_shopDomain_phone_idx" ON "Member"("shopDomain", "phone");

-- CreateIndex
CREATE INDEX "Member_shopDomain_lastName_firstName_idx" ON "Member"("shopDomain", "lastName", "firstName");

-- CreateIndex
CREATE INDEX "PointsLedger_memberId_createdAt_idx" ON "PointsLedger"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "PointsLedger_orderId_idx" ON "PointsLedger"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PointsLedger_type_referenceId_key" ON "PointsLedger"("type", "referenceId");

-- CreateIndex
CREATE INDEX "Redemption_memberId_createdAt_idx" ON "Redemption"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "Redemption_discountCode_idx" ON "Redemption"("discountCode");

-- CreateIndex
CREATE INDEX "Redemption_status_expiresAt_idx" ON "Redemption"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyConfig_shopDomain_key" ON "LoyaltyConfig"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationSnapshot_source_shopifyCustomerId_key" ON "MigrationSnapshot"("source", "shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_topic_receivedAt_idx" ON "WebhookEvent"("shopDomain", "topic", "receivedAt");

-- AddForeignKey
ALTER TABLE "PointsLedger" ADD CONSTRAINT "PointsLedger_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

