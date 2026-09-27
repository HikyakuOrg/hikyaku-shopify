-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "shopify";

-- CreateTable
CREATE TABLE "shopify"."Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify"."HikyakuConnection" (
    "shop" TEXT NOT NULL,
    "hikyakuUserId" TEXT NOT NULL,
    "hikyakuEmail" TEXT NOT NULL,
    "organisationId" TEXT,
    "organisationSlug" TEXT,
    "organisationName" TEXT,
    "accessTokenSecretId" UUID NOT NULL,
    "refreshTokenSecretId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HikyakuConnection_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "shopify"."HikyakuOAuthState" (
    "state" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HikyakuOAuthState_pkey" PRIMARY KEY ("state")
);

