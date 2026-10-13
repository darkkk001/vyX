-- QoreTrader demo: one broker-level flag that marks a sandbox tenant (the public demo). Additive: one nullable-free column with a constant
-- default, no data rewrite (Postgres 11+ stores the default in the catalog). Every cross-tenant job, report and the Rust engine skip a broker with it set.
ALTER TABLE "Broker" ADD COLUMN "isDemoSandbox" BOOLEAN NOT NULL DEFAULT false;
