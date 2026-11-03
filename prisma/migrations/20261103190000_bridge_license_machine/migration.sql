-- Platform API bridge config, A.1.2: a bridge license's full machine hash, so the platform can check the machine on
-- every config fetch (owner decision 2026-11-03). Until now only its first 8 characters were kept (audit row).
-- A nullable column add: metadata-only, no rewrite, no scan. Licenses issued before this have NULL and are refused by
-- /api/bridge/config until re-issued (the 8 characters are not enough to bind a machine).
-- Revert: ALTER TABLE "ClientBuild" DROP COLUMN "machineId";
ALTER TABLE "ClientBuild" ADD COLUMN "machineId" TEXT;
