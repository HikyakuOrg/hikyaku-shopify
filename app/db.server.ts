import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

declare global {
  var prismaGlobal: PrismaClient;
}

// Prisma 7 connects through node-postgres (the pg driver adapter), which
// ignores the URL parameters Prisma's own engine read, so they're applied
// here to keep DATABASE_URL as it was (see .env.example):
// - `connection_limit` becomes the pool size (1 on Vercel).
// - With no `sslmode`, Prisma used TLS without verifying the certificate
//   (`prefer`), but node-postgres wouldn't use TLS at all. Supabase's
//   certificates are signed by its own CA, so the default stays encrypted and
//   unverified; an explicit `sslmode` is left to node-postgres.
// - The wait for a connection is bounded, like Prisma's pool_timeout (10 s),
//   where node-postgres would wait forever.
// `schema` and `pgbouncer` need no replacement: every model names its schema,
// and node-postgres uses unnamed prepared statements, which the transaction
// pooler supports.
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL ?? "";
  const url = new URL(connectionString);
  const max = Number(url.searchParams.get("connection_limit")) || undefined;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const ssl =
    url.searchParams.has("sslmode") || local
      ? undefined
      : { rejectUnauthorized: false };

  const adapter = new PrismaPg({
    connectionString,
    max,
    ssl,
    connectionTimeoutMillis: 10_000,
  });
  return new PrismaClient({ adapter });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createPrismaClient();
  }
}

const prisma = global.prismaGlobal ?? createPrismaClient();

export default prisma;
