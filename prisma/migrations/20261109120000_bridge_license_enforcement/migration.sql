-- License enforcement Phase 1.2 (2026-11-09, C:\vyx\handoff\license-enforcement-contract.md): bridge licenses get a
-- reversible SUSPENDED status (still the String "status" column, no type change), their issue facts as real columns
-- (until now only in the BRIDGE_LICENSE_ISSUED audit row), who suspended / revoked them and why, online status, and the
-- one-server-per-license fields. Additive only: nullable columns plus one NOT NULL column with a constant default
-- (metadata-only on PostgreSQL 11+, no table rewrite).
-- Revert: ALTER TABLE "ClientBuild" DROP COLUMN "expiresAt", DROP COLUMN "features", DROP COLUMN "suspendReason",
--   DROP COLUMN "suspendedAt", DROP COLUMN "suspendedBy", DROP COLUMN "revokedBy", DROP COLUMN "revokeReason",
--   DROP COLUMN "lastReportAt", DROP COLUMN "lastReportMachine", DROP COLUMN "boundMachineId",
--   DROP COLUMN "conflictMachine", DROP COLUMN "conflictAt";
ALTER TABLE "ClientBuild"
    ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
    ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "suspendReason" TEXT,
    ADD COLUMN "suspendedAt" TIMESTAMPTZ(3),
    ADD COLUMN "suspendedBy" TEXT,
    ADD COLUMN "revokedBy" TEXT,
    ADD COLUMN "revokeReason" TEXT,
    ADD COLUMN "lastReportAt" TIMESTAMPTZ(3),
    ADD COLUMN "lastReportMachine" TEXT,
    ADD COLUMN "boundMachineId" TEXT,
    ADD COLUMN "conflictMachine" TEXT,
    ADD COLUMN "conflictAt" TIMESTAMPTZ(3);

-- BACKFILL (lib/bridge-license-backfill.test.ts runs exactly the statement below against a scratch DB)
-- Once: every bridge license's expiresAt and features from its (first) BRIDGE_LICENSE_ISSUED audit row. A value that
-- is missing or not of the expected shape is left NULL / empty; the readers fall back to the audit row for those.
UPDATE "ClientBuild" AS cb
SET "expiresAt" = CASE
        WHEN cb."expiresAt" IS NULL AND jsonb_typeof(a."newValue"->'expiresAt') = 'string'
             AND (a."newValue"->>'expiresAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
        THEN (a."newValue"->>'expiresAt')::timestamptz
        ELSE cb."expiresAt"
    END,
    "features" = CASE
        WHEN cardinality(cb."features") = 0 AND jsonb_typeof(a."newValue"->'features') = 'array'
        THEN ARRAY(SELECT f FROM jsonb_array_elements_text(a."newValue"->'features') AS f WHERE f IN ('hedge', 'feed'))
        ELSE cb."features"
    END
FROM (
    SELECT DISTINCT ON ("entityId") "entityId", "newValue"
    FROM "AuditLog"
    WHERE "action" = 'BRIDGE_LICENSE_ISSUED' AND "entityType" = 'ClientBuild' AND jsonb_typeof("newValue") = 'object'
    ORDER BY "entityId", "createdAt" ASC
) AS a
WHERE cb."buildId" = a."entityId" AND cb."app" = 'bridge';
