-- Order sounds by origin (owner 2026-11-13, option C). Additive only: three nullable columns, no default, no rewrite.
-- Order.clientInstance = the client that placed / last modified the order; Position.openClientInstance = the client that opened it;
-- Position.slTpClientInstance = the client that last set its SL / TP. Null = no client (staff, engine, older rows): events stay silent.
ALTER TABLE "Order" ADD COLUMN "clientInstance" VARCHAR(64);
ALTER TABLE "Position" ADD COLUMN "openClientInstance" VARCHAR(64);
ALTER TABLE "Position" ADD COLUMN "slTpClientInstance" VARCHAR(64);
