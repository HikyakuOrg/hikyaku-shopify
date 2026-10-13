-- The plan and currency Hikyaku rates were last set up for (HIK-217), so
-- shop/update re-checks the path only when one of them changed.
ALTER TABLE "shopify"."ShippingRates"
  ADD COLUMN "shopPlan" TEXT,
  ADD COLUMN "shopCurrency" TEXT;
