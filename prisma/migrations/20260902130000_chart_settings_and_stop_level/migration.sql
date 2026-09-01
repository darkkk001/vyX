-- Chart interaction pack groundwork. Additive only: two new nullable/
-- defaulted columns, no existing data touched, zero behavior change until
-- a broker admin sets a real stopLevel or a trader saves chart settings.

-- AlterTable
ALTER TABLE "BrokerSymbol" ADD COLUMN     "stopLevel" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "chartSettings" JSONB;
