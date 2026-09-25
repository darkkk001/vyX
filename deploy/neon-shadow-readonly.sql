-- Rust cutover Stage 5, guard 1: the read-only Neon role the shadow monitor + reconciler read the book with
-- (engine env VYX_SHADOW_DATABASE_URL). The engine verifies at startup that this role cannot INSERT / UPDATE / DELETE
-- any money table and refuses SHADOW otherwise (engine/order-management/src/shadow.rs connect_read_only_book).
--
-- Run ONCE on the LIVE database (ep-morning-glade) as neondb_owner, with a strong password in place of <PASSWORD>:
--   psql "<DIRECT_URL of ep-morning-glade>" -v ON_ERROR_STOP=1 -f deploy/neon-shadow-readonly.sql
-- Then on the VPS, in start-engine.cmd (above the engine launch line):
--   set VYX_SHADOW_DATABASE_URL=postgresql://vyx_shadow_ro:<PASSWORD>@ep-morning-glade-b23tui1g-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require
-- Idempotent except the password line (re-running it just resets the password).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vyx_shadow_ro') THEN
    CREATE ROLE vyx_shadow_ro LOGIN;
  END IF;
END
$$;
ALTER ROLE vyx_shadow_ro WITH LOGIN PASSWORD '<PASSWORD>';
ALTER ROLE vyx_shadow_ro SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE neondb TO vyx_shadow_ro;
GRANT USAGE ON SCHEMA public TO vyx_shadow_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vyx_shadow_ro;
-- tables added by later migrations (created by neondb_owner) are readable too
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT ON TABLES TO vyx_shadow_ro;
-- and never anything else
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM vyx_shadow_ro;
