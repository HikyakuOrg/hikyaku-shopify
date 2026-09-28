import type { Prisma } from "@prisma/client";
import prisma from "../db.server";

// Hikyaku OAuth tokens and Shopify session tokens are stored as Supabase
// Vault secrets (vault.secrets, AEAD-encrypted by Postgres itself) rather
// than app-level ciphertext — HikyakuConnection and Session only ever hold
// the vault secret UUIDs. See https://supabase.com/docs/guides/database/vault.
//
// The runtime role (hikyaku_shopify) has no access to the vault schema. It
// goes through the SECURITY DEFINER wrappers in the shopify schema (see the
// least_privilege_role migration), which tag the app's secrets with the
// description 'hikyaku-shopify' and only touch tagged secrets.
//
// Secrets are created without a `name` (left null) so re-encrypting a token
// never collides with vault.secrets' unique-name constraint — the stored UUID
// is the only lookup path we need.
//
// Every function takes an optional client, so callers can run them inside a
// `prisma.$transaction` alongside the row that holds the UUID.

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

interface SecretIdRow {
  id: string;
}

interface DecryptedSecretRow {
  decrypted_secret: string | null;
}

export async function createSecret(
  plaintext: string,
  db: Db = prisma,
): Promise<string> {
  const [row] = await db.$queryRaw<SecretIdRow[]>`
    select shopify.create_secret(${plaintext}) as id
  `;
  return row.id;
}

export async function updateSecret(
  id: string,
  plaintext: string,
  db: Db = prisma,
): Promise<void> {
  await db.$executeRaw`
    select shopify.update_secret(${id}::uuid, ${plaintext})
  `;
}

// Null when the secret doesn't exist (or isn't one of the app's).
export async function readSecretOrNull(
  id: string,
  db: Db = prisma,
): Promise<string | null> {
  const [row] = await db.$queryRaw<DecryptedSecretRow[]>`
    select shopify.read_secret(${id}::uuid) as decrypted_secret
  `;
  return row?.decrypted_secret ?? null;
}

export async function readSecret(id: string, db: Db = prisma): Promise<string> {
  const secret = await readSecretOrNull(id, db);
  if (!secret) throw new Error(`Vault secret ${id} not found`);
  return secret;
}

export async function deleteSecret(id: string, db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    select shopify.delete_secret(${id}::uuid)
  `;
}

// Updates the existing secret in place when one already exists (so a
// re-connect or token refresh doesn't orphan the previous vault.secrets
// row); creates a new one only the first time a shop connects.
export async function upsertSecret(
  existingId: string | null,
  plaintext: string,
  db: Db = prisma,
): Promise<string> {
  if (existingId) {
    await updateSecret(existingId, plaintext, db);
    return existingId;
  }
  return createSecret(plaintext, db);
}
