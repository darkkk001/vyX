-- Per-group dealing-mode override -- independent of Broker.dealingModeAt,
-- either alone is enough to route a group's MARKET orders to the dealing
-- queue. See Group.forceDealingMode's own schema comment.
ALTER TABLE "Group" ADD COLUMN "forceDealingMode" BOOLEAN NOT NULL DEFAULT false;
