-- Commission and swap tracking on the Rust-owned positions table. Both
-- are cumulative running totals (mirroring Prisma's legacy Position.swap/
-- commission columns' display role, per docs/execution.md's
-- commission/swap section) -- the ledger_entries rows recorded alongside
-- every change are the authoritative money movement, these columns are a
-- fast per-position read for the UI instead of summing ledger_entries by
-- related_position_id on every request.

ALTER TABLE positions ADD COLUMN commission DECIMAL(18, 4) NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN swap DECIMAL(18, 4) NOT NULL DEFAULT 0;

-- Last time swap was applied to this position, so the daily rollover job
-- (order_management::swap) can select "every OPEN position not yet
-- charged for today" without a separate tracking table. Null = never
-- charged (a freshly opened position, or one opened before this column
-- existed).
ALTER TABLE positions ADD COLUMN last_swap_at TIMESTAMPTZ;
