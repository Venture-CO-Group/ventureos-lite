-- Suspending a member without deleting them (P8/2).
--
-- The user panel could set a password, force a 2FA re-enrolment, unlock an
-- account and sign every session out — but it could not stand somebody down.
-- The only way to stop a person reaching a workspace was to remove their
-- membership, which is not the same act: a removed member takes the authorship
-- of their own history with them, and "who wrote this note" is a question
-- people ask months later.
--
-- Per MEMBERSHIP, not per user: somebody can belong to several workspaces, and
-- being stood down from one says nothing about the others.
-- AlterTable
ALTER TABLE "memberships" ADD COLUMN "suspended_at" TIMESTAMP(3);
ALTER TABLE "memberships" ADD COLUMN "suspended_by" TEXT;
