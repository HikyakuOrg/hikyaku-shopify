-- Static path of Hikyaku rates (HIK-216): each Hikyaku method definition's
-- name in the shop mapped to its rate code, for recognising static rates on
-- orders.
ALTER TABLE "shopify"."ShippingRates" ADD COLUMN "staticRates" JSONB;
