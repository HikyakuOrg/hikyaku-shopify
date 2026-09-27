import prisma from "../db.server";

// Hikyaku OAuth access/refresh tokens are stored as Supabase Vault secrets
// (vault.secrets, AEAD-encrypted by Postgres itself) rather than app-level
// ciphertext — HikyakuConnection only ever holds the vault secret UUIDs.
// See https://supabase.com/docs/guides/database/vault.
//
// Requires the `supabase_vault` extension enabled on this Postgres instance
// (on by default for Supabase projects) and a DATABASE_URL role with EXECUTE
// on vault.create_secret/update_secret and SELECT on vault.decrypted_secrets
// — true of Supabase's default `postgres` role used for direct connections.
//
// Secrets are created without a `name` (left null) so re-encrypting a token
// never collides with vault.secrets' unique-name constraint — the UUID
// stored on HikyakuConnection is the only lookup path we need.

interface SecretIdRow {
  id: string;
}

interface DecryptedSecretRow {
  decrypted_secret: string;
}

export async function createSecret(plaintext: string): Promise<string> {
  const [row] = await prisma.$queryRaw<SecretIdRow[]>`
    select vault.create_secret(${plaintext}) as id
  `;
  return row.id;
}

export async function updateSecret(
  id: string,
  plaintext: string,
): Promise<void> {
  await prisma.$executeRaw`
    select vault.update_secret(${id}::uuid, ${plaintext})
  `;
}

export async function readSecret(id: string): Promise<string> {
  const [row] = await prisma.$queryRaw<DecryptedSecretRow[]>`
    select decrypted_secret from vault.decrypted_secrets where id = ${id}::uuid
  `;
  if (!row) throw new Error(`Vault secret ${id} not found`);
  return row.decrypted_secret;
}

export async function deleteSecret(id: string): Promise<void> {
  await prisma.$executeRaw`
    delete from vault.secrets where id = ${id}::uuid
  `;
}

// Updates the existing secret in place when one already exists (so a
// re-connect or token refresh doesn't orphan the previous vault.secrets
// row); creates a new one only the first time a shop connects.
export async function upsertSecret(
  existingId: string | null,
  plaintext: string,
): Promise<string> {
  if (existingId) {
    await updateSecret(existingId, plaintext);
    return existingId;
  }
  return createSecret(plaintext);
}
