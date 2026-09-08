-- Read-only client access (P6/6.3).
--
-- A CLIENT sees one company's delivery — its projects, milestones and
-- finalized documents — and nothing else in the workspace.

ALTER TYPE "Role" ADD VALUE 'CLIENT';

ALTER TABLE "memberships" ADD COLUMN "client_company_id" TEXT;
