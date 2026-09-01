-- Group-level dealing-mode override (forward-compatible subset of the
-- Auto Dealing design in REALTIME-SYNC-AND-DEALING-BRIEF §9). Additive
-- only: new enum + a new NOT NULL column with a default, so every
-- existing group's routing behavior is unchanged until a broker
-- explicitly sets AUTO or MANUAL on a group.

-- CreateEnum
CREATE TYPE "GroupDealingMode" AS ENUM ('INHERIT', 'AUTO', 'MANUAL');

-- AlterTable
ALTER TABLE "Group" ADD COLUMN "dealingMode" "GroupDealingMode" NOT NULL DEFAULT 'INHERIT';
