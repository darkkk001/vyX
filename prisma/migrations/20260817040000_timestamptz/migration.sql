-- Every DateTime column was `timestamp without time zone` (Prisma's
-- default when no @db.Timestamptz is given) -- see docs/database.md #6
-- for the real bug this caused (a value round-tripped through a Node
-- driver gets interpreted in the CLIENT machine's timezone, not UTC).
--
-- `col AT TIME ZONE 'UTC'` on a naive timestamp reinterprets its literal
-- digits as UTC wall-clock time and promotes it to timestamptz -- safe
-- here specifically because every existing row was written with the
-- Postgres session timezone set to GMT (confirmed via `SHOW timezone`),
-- so the naive value's digits already ARE the correct UTC instant; this
-- is not a generic "assume UTC" hack, it matches how the data was
-- actually produced.

ALTER TABLE "Broker" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "Broker" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "AdminUser" ALTER COLUMN "lastLoginAt" TYPE TIMESTAMPTZ(3) USING "lastLoginAt" AT TIME ZONE 'UTC';
ALTER TABLE "AdminUser" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "AdminUser" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Account" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "Account" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "KycRecord" ALTER COLUMN "reviewedAt" TYPE TIMESTAMPTZ(3) USING "reviewedAt" AT TIME ZONE 'UTC';
ALTER TABLE "KycRecord" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "KycRecord" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Transaction" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "Symbol" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "Symbol" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "LivePrice" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- bucketStart is part of Candle's composite primary key -- changing its
-- type in place preserves the underlying instant (and therefore
-- uniqueness), just changes the representation.
ALTER TABLE "Candle" ALTER COLUMN "bucketStart" TYPE TIMESTAMPTZ(3) USING "bucketStart" AT TIME ZONE 'UTC';
ALTER TABLE "Candle" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "BrokerSymbol" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "BrokerSymbol" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Order" ALTER COLUMN "filledAt" TYPE TIMESTAMPTZ(3) USING "filledAt" AT TIME ZONE 'UTC';
ALTER TABLE "Order" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "Order" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Position" ALTER COLUMN "openedAt" TYPE TIMESTAMPTZ(3) USING "openedAt" AT TIME ZONE 'UTC';
ALTER TABLE "Position" ALTER COLUMN "closedAt" TYPE TIMESTAMPTZ(3) USING "closedAt" AT TIME ZONE 'UTC';

ALTER TABLE "IbRelationship" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "IbRelationship" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "AuditLog" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
