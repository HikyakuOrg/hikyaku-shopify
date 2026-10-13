-- The Shopify side of Hikyaku rates at checkout (HIK-206): whether rates are
-- on, which path the shop is on, and the GIDs of what the app created in the
-- shop. hikyaku_shopify gets read/write through the schema's default
-- privileges (least_privilege_role migration).
CREATE TABLE "shopify"."ShippingRates" (
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "path" TEXT,
    "carrierServiceId" TEXT,
    "deliveryCustomizationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingRates_pkey" PRIMARY KEY ("shop")
);
