-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'discount_code',
ADD COLUMN     "storeCreditAccountId" TEXT,
ADD COLUMN     "storeCreditReversalId" TEXT,
ADD COLUMN     "storeCreditTransactionId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyConfig" ADD COLUMN     "expiryMode" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "membershipMonths" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "membershipProductTag" TEXT NOT NULL DEFAULT 'Membership',
ADD COLUMN     "migrationPointsMultiplier" DECIMAL(6,3) NOT NULL DEFAULT 10,
ADD COLUMN     "redeemMethod" TEXT NOT NULL DEFAULT 'store_credit',
ADD COLUMN     "signupBonusPoints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "storeCreditExpiryMonths" INTEGER,
ALTER COLUMN "redeemPointsPerDollar" SET DEFAULT 100,
ALTER COLUMN "minRedeemPoints" SET DEFAULT 1000,
ALTER COLUMN "redeemStepPoints" SET DEFAULT 1000,
ALTER COLUMN "paidTierMultiplier" SET DEFAULT 10,
ALTER COLUMN "earnRequiresMember" SET DEFAULT false,
ALTER COLUMN "excludeDiscountedItems" SET DEFAULT false,
ALTER COLUMN "redeemAmountIsTaxInclusive" SET DEFAULT false,
ALTER COLUMN "redeemRequiresMember" SET DEFAULT false;

