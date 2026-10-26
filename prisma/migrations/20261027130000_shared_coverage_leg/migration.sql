-- Dealing redesign D8 (owner 2026-10-26): Hedge nets per symbol and side, so several client positions share one hedge
-- leg. Position.coveragePositionId is no longer unique; a plain index keeps the leg -> clients lookup fast.
-- Revert (only while no leg is shared): DROP INDEX "Position_coveragePositionId_idx";
--   CREATE UNIQUE INDEX "Position_coveragePositionId_key" ON "Position"("coveragePositionId");
DROP INDEX "Position_coveragePositionId_key";
CREATE INDEX "Position_coveragePositionId_idx" ON "Position"("coveragePositionId");
