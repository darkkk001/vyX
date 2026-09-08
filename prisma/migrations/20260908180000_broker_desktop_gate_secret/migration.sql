-- AlterTable
-- Per-broker secret proving a /manage/* request came from that broker's
-- own genuine manager-tauri build -- see Broker.desktopGateSecret's own
-- schema comment. Nullable, nothing to backfill (no broker has one yet).
ALTER TABLE "Broker" ADD COLUMN "desktopGateSecret" TEXT;
CREATE UNIQUE INDEX "Broker_desktopGateSecret_key" ON "Broker"("desktopGateSecret");
