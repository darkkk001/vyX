-- AlterTable
-- KycRecord has zero existing rows (nothing has ever created one -- see
-- docs/architecture.md's Phase 6 log) so this rename/add is a safe,
-- data-free change.
ALTER TABLE "KycRecord" RENAME COLUMN "documentUrl" TO "documentFrontUrl";
ALTER TABLE "KycRecord" ADD COLUMN "documentBackUrl" TEXT;
