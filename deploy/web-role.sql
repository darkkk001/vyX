-- The Neon role the Vercel web app works with (owner 2026-10-28, infra audit): its own role so the web gets a 10 s
-- statement_timeout WITHOUT touching neondb_owner, which the engine (its stop-out lane can run a long evaluation),
-- migrations, backfills and seed --reset-trading keep using unchanged. Never ALTER ROLE neondb_owner for this.
-- - Rights: what the web does today with neondb_owner, minus ownership: read / write rows of every table and view in
--   public, and use every sequence. No DDL (the web runs none at runtime; migrations stay on DIRECT_URL = neondb_owner).
-- - Default privileges FOR ROLE neondb_owner: a table or sequence a later migration creates is reachable at once, so a
--   migration never 503s the web.
-- - statement_timeout 10 s on this role only.
--
-- Run ONCE on the LIVE database as neondb_owner; the password is a psql variable, never typed into this file:
--   psql -v ON_ERROR_STOP=1 -v web_pw='<strong password>' -f deploy/web-role.sql -d "<DIRECT_URL>"
-- Then Vercel Production DATABASE_URL (the pooled URL) uses this role:
--   postgresql://vyx_web:<PASSWORD>@<the same -pooler host>/neondb?sslmode=require&channel_binding=require
-- DIRECT_URL stays neondb_owner (migrations only; no runtime code reads it).
-- Idempotent: re-running resets the password and re-applies exactly these rights.
-- Revert: point Vercel DATABASE_URL back at neondb_owner, redeploy, then
--   ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public REVOKE ALL ON TABLES FROM vyx_web;
--   ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM vyx_web;
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vyx_web; REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM vyx_web;
--   REVOKE USAGE ON SCHEMA public FROM vyx_web; REVOKE CONNECT ON DATABASE neondb FROM vyx_web; DROP ROLE vyx_web;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vyx_web') THEN
    CREATE ROLE vyx_web LOGIN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vyx_web', current_database());
END
$$;
ALTER ROLE vyx_web WITH LOGIN PASSWORD :'web_pw';
ALTER ROLE vyx_web SET statement_timeout = '10s';
GRANT USAGE ON SCHEMA public TO vyx_web;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vyx_web;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO vyx_web;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vyx_web;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vyx_web;

-- self-check: every table / view / sequence in public, with the rights missing (expected: no rows)
SELECT c.relname AS object, c.relkind AS kind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
  AND NOT (has_table_privilege('vyx_web', c.oid, 'SELECT') AND (c.relkind IN ('v', 'm') OR (has_table_privilege('vyx_web', c.oid, 'INSERT')
       AND has_table_privilege('vyx_web', c.oid, 'UPDATE') AND has_table_privilege('vyx_web', c.oid, 'DELETE'))))
UNION ALL
SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND CASE WHEN c.relkind = 'S' THEN NOT has_sequence_privilege('vyx_web', c.oid, 'USAGE, SELECT, UPDATE') ELSE false END;
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'vyx_web';
