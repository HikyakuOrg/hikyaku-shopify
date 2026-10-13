import type { Prisma, Session as SessionRow } from "../generated/prisma/client";
import { Session } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  createSecret,
  deleteSecret,
  readSecretOrNull,
  updateSecret,
} from "./vault.server";

// Shopify session storage that keeps the access and refresh tokens in
// Supabase Vault, like the Hikyaku tokens (see vault.server.ts). The Session
// row holds only the vault secret UUIDs; everything else is stored the same
// way PrismaSessionStorage stored it.
//
// Writes run in one transaction with the row, so a failed store never leaves
// a secret behind. Offline token refreshes can store the same session
// concurrently (the parent `app` and child route loaders both authenticate,
// in parallel), and two stores both creating a secret would orphan one, so
// writes are serialized twice over:
// - within an instance, by `serialized`: each write starts its transaction
//   only once the previous one is done. Otherwise, with one pooled connection
//   (connection_limit=1 on Vercel), the next transaction's start timeout runs
//   out while it queues for the connection.
// - across instances, by a per-session advisory lock inside the transaction.

type Tx = Prisma.TransactionClient;
type SessionFields = Omit<
  SessionRow,
  "accessTokenSecretId" | "refreshTokenSecretId"
>;

interface Tokens {
  accessToken: string | null;
  refreshToken: string | null;
}

export class VaultSessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    await serialized(() =>
      prisma.$transaction(async (tx) => {
        await lockSessions(tx, [session.id]);
        const existing = await tx.session.findUnique({
          where: { id: session.id },
          select: { accessTokenSecretId: true, refreshTokenSecretId: true },
        });
        const data = {
          ...sessionToRow(session),
          accessTokenSecretId: await putSecret(
            tx,
            existing?.accessTokenSecretId ?? null,
            session.accessToken,
          ),
          refreshTokenSecretId: await putSecret(
            tx,
            existing?.refreshTokenSecretId ?? null,
            session.refreshToken,
          ),
        };
        await tx.session.upsert({
          where: { id: session.id },
          create: data,
          update: data,
        });
      }),
    );
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const row = await prisma.session.findUnique({ where: { id } });
    return row ? rowToSession(row, await readTokens(row)) : undefined;
  }

  async deleteSession(id: string): Promise<boolean> {
    await deleteSessionsWhere({ id });
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await deleteSessionsWhere({ id: { in: ids } });
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const rows = await prisma.session.findMany({
      where: { shop },
      take: 25,
      orderBy: [{ expires: "desc" }],
    });
    return Promise.all(
      rows.map(async (row) => rowToSession(row, await readTokens(row))),
    );
  }
}

// For the app/uninstalled webhook: deletes the shop's sessions and their
// secrets.
export async function deleteShopSessions(shop: string): Promise<void> {
  await deleteSessionsWhere({ shop });
}

async function deleteSessionsWhere(where: Prisma.SessionWhereInput) {
  await serialized(() =>
    prisma.$transaction(async (tx) => {
      const ids = (
        await tx.session.findMany({ where, select: { id: true } })
      ).map((row) => row.id);
      if (ids.length === 0) return;
      // Re-read under the locks, so a concurrent store can't swap in a secret
      // between reading the ids and deleting the row.
      await lockSessions(tx, ids);
      const rows = await tx.session.findMany({
        where: { id: { in: ids } },
        select: { accessTokenSecretId: true, refreshTokenSecretId: true },
      });
      await tx.session.deleteMany({ where: { id: { in: ids } } });
      for (const row of rows) {
        if (row.accessTokenSecretId) {
          await deleteSecret(row.accessTokenSecretId, tx);
        }
        if (row.refreshTokenSecretId) {
          await deleteSecret(row.refreshTokenSecretId, tx);
        }
      }
    }),
  );
}

// This instance's session writes, one at a time. A failed write doesn't stop
// the ones queued after it.
let writes: Promise<unknown> = Promise.resolve();

function serialized<T>(write: () => Promise<T>): Promise<T> {
  const result = writes.then(write);
  writes = result.catch(() => {});
  return result;
}

// Transaction-scoped, so they're released on commit or rollback. Sorted so
// two transactions locking overlapping sets can't deadlock.
async function lockSessions(tx: Tx, ids: string[]) {
  for (const id of [...ids].sort()) {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`shopify.Session:${id}`}))`;
  }
}

// Updates the secret in place, creates one, or deletes it when the session
// no longer has that token. Returns the UUID to store.
async function putSecret(
  tx: Tx,
  existingId: string | null,
  plaintext: string | undefined,
): Promise<string | null> {
  if (!plaintext) {
    if (existingId) await deleteSecret(existingId, tx);
    return null;
  }
  if (existingId) {
    await updateSecret(existingId, plaintext, tx);
    return existingId;
  }
  return createSecret(plaintext, tx);
}

// A secret that's gone is logged and the token left off, rather than thrown:
// a session without an access token is inactive, so Shopify's auth gets a
// new one instead of every request failing.
async function readTokens(row: SessionRow): Promise<Tokens> {
  const [accessToken, refreshToken] = await Promise.all([
    readToken(row.id, "access", row.accessTokenSecretId),
    readToken(row.id, "refresh", row.refreshTokenSecretId),
  ]);
  return { accessToken, refreshToken };
}

async function readToken(
  sessionId: string,
  kind: "access" | "refresh",
  secretId: string | null,
): Promise<string | null> {
  if (!secretId) return null;
  const token = await readSecretOrNull(secretId);
  if (!token) {
    console.error(
      `Vault secret ${secretId} (${kind} token of session ${sessionId}) not found`,
    );
  }
  return token;
}

// The mappings below are PrismaSessionStorage's (v9), minus the tokens.

export function sessionToRow(session: Session): SessionFields {
  const user = session.toObject().onlineAccessInfo?.associated_user;
  return {
    id: session.id,
    shop: session.shop,
    state: session.state,
    isOnline: session.isOnline,
    scope: session.scope || null,
    expires: session.expires || null,
    userId: user?.id ? BigInt(user.id) : null,
    firstName: user?.first_name || null,
    lastName: user?.last_name || null,
    email: user?.email || null,
    accountOwner: user?.account_owner || false,
    locale: user?.locale || null,
    collaborator: user?.collaborator || false,
    emailVerified: user?.email_verified || false,
    refreshTokenExpires: session.refreshTokenExpires || null,
  };
}

export function rowToSession(row: SessionFields, tokens: Tokens): Session {
  const params: Record<string, string | number | boolean> = {
    id: row.id,
    shop: row.shop,
    state: row.state,
    isOnline: row.isOnline,
    // String(null) is "null", as in PrismaSessionStorage; fromPropertyArray
    // only builds user info from these for online sessions.
    userId: String(row.userId),
    firstName: String(row.firstName),
    lastName: String(row.lastName),
    email: String(row.email),
    locale: String(row.locale),
  };
  if (row.accountOwner !== null) params.accountOwner = row.accountOwner;
  if (row.collaborator !== null) params.collaborator = row.collaborator;
  if (row.emailVerified !== null) params.emailVerified = row.emailVerified;
  if (row.expires) params.expires = row.expires.getTime();
  if (row.scope) params.scope = row.scope;
  if (tokens.accessToken) params.accessToken = tokens.accessToken;
  if (tokens.refreshToken) params.refreshToken = tokens.refreshToken;
  if (row.refreshTokenExpires) {
    params.refreshTokenExpires = row.refreshTokenExpires.getTime();
  }
  return Session.fromPropertyArray(Object.entries(params), true);
}
