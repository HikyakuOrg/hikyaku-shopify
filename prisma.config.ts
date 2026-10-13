import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env itself. On Vercel there's no .env file: the
// variables come from the project settings.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Only the CLI uses this (`prisma migrate`), so it's the direct connection
  // as the privileged role; the app connects with DATABASE_URL through the
  // driver adapter (app/db.server.ts). DIRECT_URL isn't set on Vercel, where
  // only `prisma generate` runs, which needs no database: `env()` would throw
  // there, so it's read from process.env instead.
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
