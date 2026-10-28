-- RedeemWindow.minSpendEqualsDiscount: Appstle Wednesday rule (minimum order value = discount amount).
-- Additive column with a default: safe on a live table.
ALTER TABLE "RedeemWindow" ADD COLUMN "minSpendEqualsDiscount" BOOLEAN NOT NULL DEFAULT false;
