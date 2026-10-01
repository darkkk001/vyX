-- markup-leak fix (owner 2026-10-01: traders must never see the broker's markup). Additive: one nullable column.
-- NULL for every broker = today's wire, unchanged. Setting it (a separate, owner-approved data step, once the web and
-- the price-stream gateway with this change are both deployed) switches that broker's traders to ready-made asks on
-- the stream and on GET /api/trade/prices at once.
ALTER TABLE "Broker" ADD COLUMN IF NOT EXISTS "clientAskServerSideAt" TIMESTAMPTZ(3);
