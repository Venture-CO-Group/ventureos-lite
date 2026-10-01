-- Outbound motor, phase F1 (playbook-v6, spec §4.43.1-2): products, their
-- reference companies, the segment taxonomy and ICP profiles.

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('OWN_SERVICE', 'PARTNER_SOLUTION');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'PAUSED', 'RETIRED');

-- CreateEnum
CREATE TYPE "SourcingHint" AS ENUM ('NAME_HARVEST_STRONG', 'NAME_HARVEST_WEAK', 'SEED_LIST', 'PLACES');

-- CreateEnum
CREATE TYPE "ContactRequirement" AS ENUM ('NAMED_CONTACT', 'GENERIC_OK');

-- CreateEnum
CREATE TYPE "CampaignMode" AS ENUM ('VOLUME', 'ACCOUNT');

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL DEFAULT 'OWN_SERVICE',
    "partner" TEXT,
    "problem_solved" TEXT NOT NULL,
    "value_props" JSONB NOT NULL DEFAULT '[]',
    "proof_points" JSONB NOT NULL DEFAULT '[]',
    "price_band" TEXT,
    "assets" JSONB NOT NULL DEFAULT '[]',
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "language" "Lang" NOT NULL DEFAULT 'HU',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_references" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "tax_number" TEXT,
    "is_client" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "teaor_include" JSONB NOT NULL DEFAULT '[]',
    "teaor_exclude" JSONB NOT NULL DEFAULT '[]',
    "fragments" JSONB NOT NULL DEFAULT '[]',
    "seed_list" JSONB NOT NULL DEFAULT '[]',
    "sourcing_hint" "SourcingHint" NOT NULL DEFAULT 'NAME_HARVEST_STRONG',
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "icp_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment_keys" JSONB NOT NULL DEFAULT '[]',
    "size_bands" JSONB NOT NULL DEFAULT '[]',
    "include_unknown_size" BOOLEAN NOT NULL DEFAULT false,
    "revenue_min" BIGINT,
    "revenue_max" BIGINT,
    "counties" JSONB NOT NULL DEFAULT '[]',
    "cities" JSONB NOT NULL DEFAULT '[]',
    "legal_forms" JSONB NOT NULL DEFAULT '[]',
    "founded_after" INTEGER,
    "founded_before" INTEGER,
    "status_required" TEXT NOT NULL DEFAULT 'Aktív',
    "requires_website" BOOLEAN NOT NULL DEFAULT false,
    "audit_score_min" INTEGER,
    "audit_score_max" INTEGER,
    "required_signals" JSONB NOT NULL DEFAULT '[]',
    "contact_requirement" "ContactRequirement" NOT NULL DEFAULT 'GENERIC_OK',
    "exclude_existing_clients" BOOLEAN NOT NULL DEFAULT true,
    "mode" "CampaignMode" NOT NULL DEFAULT 'VOLUME',
    "daily_quota" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "icp_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_workspace_id_idx" ON "products"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_workspace_id_slug_key" ON "products"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "product_references_workspace_id_idx" ON "product_references"("workspace_id");

-- CreateIndex
CREATE INDEX "product_references_product_id_idx" ON "product_references"("product_id");

-- CreateIndex
CREATE INDEX "segments_workspace_id_idx" ON "segments"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "segments_workspace_id_key_key" ON "segments"("workspace_id", "key");

-- CreateIndex
CREATE INDEX "icp_profiles_workspace_id_idx" ON "icp_profiles"("workspace_id");

-- CreateIndex
CREATE INDEX "icp_profiles_product_id_idx" ON "icp_profiles"("product_id");

-- AddForeignKey
ALTER TABLE "product_references" ADD CONSTRAINT "product_references_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "icp_profiles" ADD CONSTRAINT "icp_profiles_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
