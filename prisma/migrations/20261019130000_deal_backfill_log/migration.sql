-- Deal model, Migration B (docs/POSITION-DEAL-MODEL.md section 3.3 item 5): the old values the step-7 correction
-- replaces, one row per field, so it can be restored row by row. Additive only. Revert: DROP TABLE "DealBackfillLog";
CREATE TABLE "DealBackfillLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMPTZ(3),

    CONSTRAINT "DealBackfillLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DealBackfillLog_runId_idx" ON "DealBackfillLog"("runId");
CREATE INDEX "DealBackfillLog_positionId_idx" ON "DealBackfillLog"("positionId");
