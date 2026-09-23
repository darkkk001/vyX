-- Rust cutover Stage 3 (2026-09-24): the post-close transactional outbox, see the PostCloseEffect model.
--
-- Additive: a new, empty table. Nothing writes it until the engine's monitor runs
-- (ENGINE_ORDER_MANAGEMENT, off in production), so deploying this changes no behaviour.
CREATE TABLE IF NOT EXISTS "PostCloseEffect" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "brokerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "positionId" TEXT,
    "reason" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "doneSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingEvents" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMPTZ(3),
    CONSTRAINT "PostCloseEffect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PostCloseEffect_dedupeKey_key" ON "PostCloseEffect"("dedupeKey");
CREATE INDEX IF NOT EXISTS "PostCloseEffect_status_nextAttemptAt_idx" ON "PostCloseEffect"("status", "nextAttemptAt");
