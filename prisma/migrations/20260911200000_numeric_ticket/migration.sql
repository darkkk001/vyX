-- Numeric ticket numbers for orders and positions (2026-09-11, Futurix live testing: traders
-- were shown cuids like "tnyba8ut"; MT-style desks need a numeric ticket on tables, dialogs,
-- confirmations and reports).
--
-- Design: ONE server-wide sequence (like an MT5 server hosting several white-labels: tickets are
-- unique across the server, each broker simply sees increasing numbers with gaps). A position
-- carries the ticket of the order that opened it (MT5's "position id = opening order ticket"), so
-- the number a trader confirmed on the ticket is the number they see on the position and in
-- history. Assigned by the DATABASE (default + trigger) so every writer -- Next.js routes, the
-- mirror/dealing paths in lib/, the Rust engine -- gets one without code changes; nothing can
-- forget it. Int (not BigInt) on purpose: JSON-safe and 2.1e9 headroom from 100000001.

CREATE SEQUENCE IF NOT EXISTS "order_ticket_seq" AS INTEGER START WITH 100000001 INCREMENT BY 1;

-- Orders: backfill existing rows in creation order, then default for new rows
ALTER TABLE "Order" ADD COLUMN "ticket" INTEGER;
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS n FROM "Order"
)
UPDATE "Order" o SET "ticket" = 100000000 + numbered.n FROM numbered WHERE o.id = numbered.id;
SELECT setval('"order_ticket_seq"', GREATEST((SELECT COALESCE(MAX("ticket"), 100000000) FROM "Order"), 100000000) + 1, false);
ALTER TABLE "Order" ALTER COLUMN "ticket" SET DEFAULT nextval('"order_ticket_seq"');
ALTER TABLE "Order" ALTER COLUMN "ticket" SET NOT NULL;
CREATE UNIQUE INDEX "Order_ticket_key" ON "Order"("ticket");

-- Positions: the opening order's ticket; trigger keeps it that way for every future insert
ALTER TABLE "Position" ADD COLUMN "ticket" INTEGER;
UPDATE "Position" p SET "ticket" = o."ticket" FROM "Order" o WHERE p."originOrderId" = o.id;
-- a position whose origin order is somehow missing still gets a number rather than blocking the migration
UPDATE "Position" SET "ticket" = nextval('"order_ticket_seq"') WHERE "ticket" IS NULL;
ALTER TABLE "Position" ALTER COLUMN "ticket" SET DEFAULT nextval('"order_ticket_seq"');
ALTER TABLE "Position" ALTER COLUMN "ticket" SET NOT NULL;
CREATE UNIQUE INDEX "Position_ticket_key" ON "Position"("ticket");

CREATE OR REPLACE FUNCTION position_ticket_from_origin_order() RETURNS trigger AS $$
BEGIN
  SELECT o."ticket" INTO NEW."ticket" FROM "Order" o WHERE o.id = NEW."originOrderId";
  IF NEW."ticket" IS NULL THEN
    NEW."ticket" := nextval('"order_ticket_seq"');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Position_ticket_from_origin_order" ON "Position";
CREATE TRIGGER "Position_ticket_from_origin_order"
  BEFORE INSERT ON "Position"
  FOR EACH ROW EXECUTE FUNCTION position_ticket_from_origin_order();
