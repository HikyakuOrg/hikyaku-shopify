import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session as SessionRow } from "@prisma/client";
import { Session } from "@shopify/shopify-app-react-router/server";

// VaultSessionStorage over an in-memory Session table and Vault, so this
// covers what reaches each: tokens only ever as secrets, secrets reused on
// refresh and deleted with their session.

const rows = new Map<string, SessionRow>();
const secrets = new Map<string, string>();
let nextSecret = 0;
// How many fake transactions are open at once, to check writes are
// serialized.
let openTransactions = 0;
let maxOpenTransactions = 0;

type Where = { id?: string | { in: string[] }; shop?: string };
function matches(row: SessionRow, where: Where) {
  if (typeof where.id === "string" && row.id !== where.id) return false;
  if (typeof where.id === "object" && !where.id.in.includes(row.id)) {
    return false;
  }
  if (where.shop !== undefined && row.shop !== where.shop) return false;
  return true;
}

const db = {
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    maxOpenTransactions = Math.max(maxOpenTransactions, ++openTransactions);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await fn(db);
    } finally {
      openTransactions--;
    }
  }),
  session: {
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        rows.get(where.id) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      [...rows.values()].filter((row) => matches(row, where)),
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { id: string };
        create: SessionRow;
      }) => rows.set(where.id, { ...create }),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      for (const row of [...rows.values()]) {
        if (matches(row, where)) rows.delete(row.id);
      }
    }),
  },
};

vi.mock("../db.server", () => ({ default: db }));
vi.mock("../lib/vault.server", () => ({
  createSecret: vi.fn(async (plaintext: string) => {
    const id = `secret-${++nextSecret}`;
    secrets.set(id, plaintext);
    return id;
  }),
  updateSecret: vi.fn(async (id: string, plaintext: string) => {
    if (!secrets.has(id)) throw new Error(`Vault secret ${id} not found`);
    secrets.set(id, plaintext);
  }),
  readSecretOrNull: vi.fn(async (id: string) => secrets.get(id) ?? null),
  deleteSecret: vi.fn(async (id: string) => {
    secrets.delete(id);
  }),
}));

const { VaultSessionStorage, deleteShopSessions } =
  await import("../lib/vault-session-storage.server");
const vault = await import("../lib/vault.server");

const SHOP = "example.myshopify.com";

function offlineSession(overrides: Partial<Session> = {}) {
  return new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: "state",
    isOnline: false,
    scope: "read_orders,read_locations",
    expires: new Date("2026-09-28T01:00:00Z"),
    accessToken: "shpat_access",
    refreshToken: "shprt_refresh",
    refreshTokenExpires: new Date("2026-12-27T00:00:00Z"),
    ...overrides,
  });
}

const storage = new VaultSessionStorage();

beforeEach(() => {
  rows.clear();
  secrets.clear();
  nextSecret = 0;
  openTransactions = 0;
  maxOpenTransactions = 0;
  vi.clearAllMocks();
});

describe("VaultSessionStorage", () => {
  it("stores the tokens only as vault secrets", async () => {
    await storage.storeSession(offlineSession());

    const row = rows.get(`offline_${SHOP}`)!;
    expect(
      JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}` : v)),
    ).not.toMatch(/shpat_access|shprt_refresh/);
    expect(secrets.get(row.accessTokenSecretId!)).toBe("shpat_access");
    expect(secrets.get(row.refreshTokenSecretId!)).toBe("shprt_refresh");
    expect(db.$executeRaw).toHaveBeenCalled(); // advisory lock
  });

  it("runs concurrent stores one transaction at a time", async () => {
    // The parent and child route loaders refreshing the same expired session.
    await Promise.all([
      storage.storeSession(offlineSession({ accessToken: "shpat_a" })),
      storage.storeSession(offlineSession({ accessToken: "shpat_b" })),
    ]);

    expect(maxOpenTransactions).toBe(1);
    expect(secrets.size).toBe(2);
    const row = rows.get(`offline_${SHOP}`)!;
    expect(secrets.get(row.accessTokenSecretId!)).toBe("shpat_b");
  });

  it("keeps storing after a failed store", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("connection lost"));

    await expect(storage.storeSession(offlineSession())).rejects.toThrow(
      "connection lost",
    );
    await storage.storeSession(offlineSession());

    expect(rows.size).toBe(1);
  });

  it("loads the session back with its tokens", async () => {
    const session = offlineSession();
    await storage.storeSession(session);

    const loaded = await storage.loadSession(session.id);
    expect(loaded?.toObject()).toEqual(session.toObject());
    expect(loaded?.isActive("read_orders,read_locations")).toBe(false); // expired
  });

  it("returns undefined for an unknown session", async () => {
    expect(await storage.loadSession("offline_other.myshopify.com")).toBe(
      undefined,
    );
  });

  it("updates the existing secrets in place on refresh", async () => {
    await storage.storeSession(offlineSession());
    const before = rows.get(`offline_${SHOP}`)!;

    await storage.storeSession(
      offlineSession({ accessToken: "shpat_new", refreshToken: "shprt_new" }),
    );

    const after = rows.get(`offline_${SHOP}`)!;
    expect(after.accessTokenSecretId).toBe(before.accessTokenSecretId);
    expect(after.refreshTokenSecretId).toBe(before.refreshTokenSecretId);
    expect(secrets.size).toBe(2);
    expect(secrets.get(after.accessTokenSecretId!)).toBe("shpat_new");
  });

  it("deletes the refresh token's secret when the session drops it", async () => {
    await storage.storeSession(offlineSession());
    const { refreshTokenSecretId } = rows.get(`offline_${SHOP}`)!;

    await storage.storeSession(offlineSession({ refreshToken: undefined }));

    expect(rows.get(`offline_${SHOP}`)!.refreshTokenSecretId).toBeNull();
    expect(secrets.has(refreshTokenSecretId!)).toBe(false);
  });

  it("leaves a missing secret's token off instead of throwing", async () => {
    await storage.storeSession(offlineSession());
    secrets.delete(rows.get(`offline_${SHOP}`)!.accessTokenSecretId!);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const loaded = await storage.loadSession(`offline_${SHOP}`);

    expect(loaded?.accessToken).toBeUndefined();
    expect(loaded?.refreshToken).toBe("shprt_refresh");
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("round-trips an online session's user", async () => {
    const session = offlineSession({
      id: `${SHOP}_42`,
      isOnline: true,
      refreshToken: undefined,
      refreshTokenExpires: undefined,
      onlineAccessInfo: {
        expires_in: 86399,
        associated_user_scope: "read_orders",
        associated_user: {
          id: 42,
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
          email_verified: true,
          account_owner: true,
          locale: "en",
          collaborator: false,
        },
      },
    });
    await storage.storeSession(session);

    const loaded = await storage.loadSession(session.id);
    expect(loaded?.onlineAccessInfo?.associated_user).toEqual(
      session.onlineAccessInfo?.associated_user,
    );
  });

  it("finds a shop's sessions with their tokens", async () => {
    await storage.storeSession(offlineSession());
    await storage.storeSession(
      offlineSession({
        id: "offline_other.myshopify.com",
        shop: "other.myshopify.com",
      }),
    );

    const found = await storage.findSessionsByShop(SHOP);
    expect(found.map((s) => [s.id, s.accessToken])).toEqual([
      [`offline_${SHOP}`, "shpat_access"],
    ]);
  });

  it("deletes a session and its secrets", async () => {
    await storage.storeSession(offlineSession());

    expect(await storage.deleteSession(`offline_${SHOP}`)).toBe(true);
    expect(rows.size).toBe(0);
    expect(secrets.size).toBe(0);
  });

  it("deletes nothing for an unknown session", async () => {
    await storage.storeSession(offlineSession());

    expect(await storage.deleteSessions(["offline_other.myshopify.com"])).toBe(
      true,
    );
    expect(rows.size).toBe(1);
    expect(vault.deleteSecret).not.toHaveBeenCalled();
  });

  it("deletes all of a shop's sessions and secrets on uninstall", async () => {
    await storage.storeSession(offlineSession());
    await storage.storeSession(
      offlineSession({ id: `${SHOP}_42`, isOnline: true }),
    );
    await storage.storeSession(
      offlineSession({
        id: "offline_other.myshopify.com",
        shop: "other.myshopify.com",
      }),
    );

    await deleteShopSessions(SHOP);

    expect([...rows.keys()]).toEqual(["offline_other.myshopify.com"]);
    expect(secrets.size).toBe(2);
  });
});
