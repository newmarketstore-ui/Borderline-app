-- AlterTable
ALTER TABLE "LoyaltyConfig" ADD COLUMN     "cartDiscountExpiryMinutes" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "posAllowCartDiscount" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "posAllowStoreCredit" BOOLEAN NOT NULL DEFAULT true;

