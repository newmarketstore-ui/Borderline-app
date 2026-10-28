-- Loyalty: memberships, redeem windows, Appstle-derived config defaults, redemption idempotency.
-- Generated offline with:
--   prisma migrate diff --from-schema-datamodel <schema at 20261028120000> --to-schema-datamodel prisma/schema.prisma --script
-- Additive only: new columns (all nullable or defaulted) + two new tables. The two ALTER COLUMN ... SET DEFAULT lines
-- only change defaults for LoyaltyConfig rows created later; existing rows keep their values.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "membershipSyncedAt" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "LoyaltyConfig" ADD COLUMN     "assumedTaxRate" DECIMAL(6,4) NOT NULL DEFAULT 0.13,
ADD COLUMN     "earnRequiresMember" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "excludeDiscountedItems" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "memberTag" TEXT NOT NULL DEFAULT 'gold-membership',
ADD COLUMN     "redeemAmountIsTaxInclusive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "redeemCodePrefix" TEXT NOT NULL DEFAULT 'POINTS',
ADD COLUMN     "redeemExpiryHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "redeemRequiresMember" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "redeemRounding" TEXT NOT NULL DEFAULT 'nearest_cent',
ALTER COLUMN "redeemPointsPerDollar" SET DEFAULT 10,
ALTER COLUMN "excludedTags" SET DEFAULT ARRAY['Gift Card', 'Service']::TEXT[];

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "planName" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "renewsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedeemWindow" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "label" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "startHour" INTEGER,
    "endHour" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "multiplier" DECIMAL(6,3) NOT NULL DEFAULT 2,
    "channels" TEXT[] DEFAULT ARRAY['pos']::TEXT[],
    "memberOnly" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedeemWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Membership_memberId_idx" ON "Membership"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_source_externalId_key" ON "Membership"("source", "externalId");

-- CreateIndex
CREATE INDEX "RedeemWindow_shopDomain_idx" ON "RedeemWindow"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_idempotencyKey_key" ON "Redemption"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

