-- Order-origin tracking (order-source-tracking pass): which surface
-- actually placed an order (WEB/DESKTOP_NATIVE/MOBILE/API/EA/ADMIN),
-- MT5-parity ("placed manually" / "via mobile" / by an EA a real MT5
-- position tooltip shows). Hand-picked from `prisma migrate diff`
-- against the live DB -- NOT applied verbatim, since that diff also
-- contained a pile of unrelated pre-existing drift (the Rust engine's
-- own snake_case tables reading as droppable, column-type nits
-- elsewhere) -- see this project's own migrate-dev gotcha: never trust
-- the raw diff wholesale on this DB.

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('WEB', 'DESKTOP_NATIVE', 'MOBILE', 'API', 'EA', 'ADMIN');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "source" "OrderSource" NOT NULL DEFAULT 'WEB';
