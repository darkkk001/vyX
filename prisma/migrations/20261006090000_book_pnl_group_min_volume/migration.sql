-- Owner 2026-10-06 (approved batch, step 1). Additive only.
-- 1) Position.groupCategoryAtOpen: the account's group category when the position opened (Book P/L rule).
ALTER TABLE "Position" ADD COLUMN "groupCategoryAtOpen" "RoutingCategory";

-- Stamped by the database itself on INSERT, so every open path (client fill, pending trigger, dealer accept,
-- requote accept, desk flush, staff open, copy rules, hedge legs, and any future engine open) records it the same
-- way. An explicit value from the caller is kept.
CREATE OR REPLACE FUNCTION position_stamp_group_category_at_open() RETURNS trigger AS $$
BEGIN
  IF NEW."groupCategoryAtOpen" IS NULL THEN
    SELECT g."category" INTO NEW."groupCategoryAtOpen"
      FROM "Account" a JOIN "Group" g ON g."id" = a."groupId"
     WHERE a."id" = NEW."accountId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER position_stamp_group_category_at_open
  BEFORE INSERT ON "Position"
  FOR EACH ROW EXECUTE FUNCTION position_stamp_group_category_at_open();

-- 2) Group.minLotSize: group minimum volume per order (S3). Null = the symbol's own minimum.
ALTER TABLE "Group" ADD COLUMN "minLotSize" DECIMAL(10,2);
