-- Shopify session tokens move to Supabase Vault, like the Hikyaku tokens:
-- Session keeps only the vault secret UUIDs (see
-- app/lib/vault-session-storage.server.ts).
ALTER TABLE "shopify"."Session"
  ADD COLUMN "accessTokenSecretId" UUID,
  ADD COLUMN "refreshTokenSecretId" UUID;

-- Existing tokens become secrets tagged 'hikyaku-shopify', so the runtime
-- role reaches them through the shopify.*_secret wrappers. This runs as the
-- migrating role, which can call Vault directly.
UPDATE "shopify"."Session"
SET "accessTokenSecretId" = vault.create_secret("accessToken", NULL, 'hikyaku-shopify')
WHERE "accessToken" <> '';

UPDATE "shopify"."Session"
SET "refreshTokenSecretId" = vault.create_secret("refreshToken", NULL, 'hikyaku-shopify')
WHERE "refreshToken" IS NOT NULL AND "refreshToken" <> '';

ALTER TABLE "shopify"."Session"
  DROP COLUMN "accessToken",
  DROP COLUMN "refreshToken";
