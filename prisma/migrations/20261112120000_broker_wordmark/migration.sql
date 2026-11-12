-- Broker.wordmark (owner 2026-11-12): how the broker name is drawn as a wordmark. Nullable, no default: every
-- existing broker keeps the old look until it is set.
ALTER TABLE "Broker" ADD COLUMN "wordmark" JSONB;
