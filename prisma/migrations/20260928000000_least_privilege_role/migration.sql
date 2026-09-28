-- Least-privilege runtime role. DATABASE_URL connects as hikyaku_shopify,
-- which can only touch this app's tables in the "shopify" schema and its own
-- Vault secrets (through the wrapper functions below). DIRECT_URL keeps the
-- privileged role, for `prisma migrate` only.
--
-- The role is created NOLOGIN: its password must never be committed. Enable
-- it once per database, out of band:
--   ALTER ROLE hikyaku_shopify WITH LOGIN PASSWORD '<generated>';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hikyaku_shopify') THEN
    CREATE ROLE hikyaku_shopify NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA "shopify" TO hikyaku_shopify;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "shopify"."Session", "shopify"."HikyakuConnection", "shopify"."HikyakuOAuthState"
  TO hikyaku_shopify;

-- Tables and sequences created by later migrations (run as the migrating
-- role) get the same grants. _prisma_migrations already exists, so it isn't
-- covered.
ALTER DEFAULT PRIVILEGES IN SCHEMA "shopify"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hikyaku_shopify;
ALTER DEFAULT PRIVILEGES IN SCHEMA "shopify"
  GRANT USAGE, SELECT ON SEQUENCES TO hikyaku_shopify;

-- Vault wrappers. The app's secrets are tagged with the description
-- 'hikyaku-shopify', and these functions only create, read, update or delete
-- tagged secrets, so the runtime role never sees anything else in
-- vault.secrets. SECURITY DEFINER runs them as their owner (the migrating
-- role), which already has access to Vault.

CREATE FUNCTION "shopify"."create_secret"(plaintext text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT vault.create_secret(plaintext, NULL, 'hikyaku-shopify');
$$;

CREATE FUNCTION "shopify"."read_secret"(secret_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE id = secret_id AND description = 'hikyaku-shopify';
$$;

-- vault.update_secret defaults the description to '', so it's passed
-- explicitly to keep the tag.
CREATE FUNCTION "shopify"."update_secret"(secret_id uuid, plaintext text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets
    WHERE id = secret_id AND description = 'hikyaku-shopify'
  ) THEN
    RAISE EXCEPTION 'Vault secret % not found', secret_id;
  END IF;
  PERFORM vault.update_secret(secret_id, plaintext, NULL, 'hikyaku-shopify');
END
$$;

CREATE FUNCTION "shopify"."delete_secret"(secret_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM vault.secrets
  WHERE id = secret_id AND description = 'hikyaku-shopify';
$$;

-- Functions are executable by PUBLIC by default; only the app role may call
-- these.
REVOKE ALL ON FUNCTION
  "shopify"."create_secret"(text),
  "shopify"."read_secret"(uuid),
  "shopify"."update_secret"(uuid, text),
  "shopify"."delete_secret"(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  "shopify"."create_secret"(text),
  "shopify"."read_secret"(uuid),
  "shopify"."update_secret"(uuid, text),
  "shopify"."delete_secret"(uuid)
  TO hikyaku_shopify;

-- Tag the secrets of existing connections. The description is part of the
-- encrypted secret's associated data, so it's changed through
-- vault.update_secret (which re-encrypts), never by updating vault.secrets.
SELECT vault.update_secret(d.id, d.decrypted_secret, NULL, 'hikyaku-shopify')
FROM vault.decrypted_secrets d
WHERE d.id IN (
  SELECT "accessTokenSecretId" FROM "shopify"."HikyakuConnection"
  UNION
  SELECT "refreshTokenSecretId" FROM "shopify"."HikyakuConnection"
);
