-- Backoffice light/dark theme (Manager + Super Admin), per-admin persisted
-- -- see AdminUser.theme's schema comment. Hand-picked from `prisma
-- migrate diff` against the live DB, same as every other migration here:
-- the raw diff also contained unrelated pre-existing drift (timestamptz
-- column-type nits on GroupSymbol/GroupSymbolConfig/MirrorRule/
-- Transaction) that is NOT part of this change and is intentionally left
-- out.

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "theme" TEXT NOT NULL DEFAULT 'light';
