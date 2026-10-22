-- QoreBridge M5: the Neon role the broker VPS's QoreBridge service works the hedge tables with (qorebridge.toml
-- [database] url). A STANDING credential on a machine that also talks to an LP, so LEAST PRIVILEGE:
-- - exactly the statements of qorebridge crates/qb-core/src/intake/schema.rs and nothing else:
--     HedgeIntent:      claim (SELECT ... FOR UPDATE SKIP LOCKED + UPDATE status / leasedBy / leaseUntil), renew the
--                       lease, mark ERROR (lastError) or DONE; FOR UPDATE needs UPDATE on a column, which the
--                       column grants below give;
--     HedgeResult:      read its legs, INSERT ROUTED before a send, upsert the outcome (ON CONFLICT DO UPDATE);
--     HedgeRoutingRule: the view the router reads (a view runs with its owner's rights, so LpRoutingRule / Symbol
--                       need no grant);
--     Notification:     INSERT only, for the trigger hedge_result_escalated_notify (migration 20261021140000): it is
--                       not SECURITY DEFINER, so it inserts as this role. It reads HedgeIntent, granted above.
-- - no Account, Position, Deal, Transaction, Broker or client table at all: the bridge never sees a client;
-- - no DELETE anywhere, no sequence, no default privileges: a table added later is NOT reachable until granted here.
--
-- Run ONCE on the LIVE database (ep-morning-glade) as neondb_owner; the password is a psql variable, never typed into
-- this file (so it cannot land in git):
--   psql -v ON_ERROR_STOP=1 -v qb_pw='<strong password>' -f deploy/qorebridge-role.sql -d "<DIRECT_URL of ep-morning-glade>"
-- Then the qorebridge.toml [database] url on the VPS (deploy/qorebridge-vps-runbook.md section 4):
--   postgresql://vyx_qorebridge:<PASSWORD>@ep-morning-glade-b23tui1g-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require
-- Idempotent: re-running resets the password and re-applies exactly these grants.
-- Revert: REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vyx_qorebridge; REVOKE USAGE ON SCHEMA public FROM vyx_qorebridge;
--         REVOKE CONNECT ON DATABASE neondb FROM vyx_qorebridge; DROP ROLE vyx_qorebridge;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vyx_qorebridge') THEN
    CREATE ROLE vyx_qorebridge LOGIN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vyx_qorebridge', current_database());
END
$$;
ALTER ROLE vyx_qorebridge WITH LOGIN PASSWORD :'qb_pw';
-- a runaway statement or an idle transaction holding a claim lock never pins Neon awake
ALTER ROLE vyx_qorebridge SET statement_timeout = '30s';
ALTER ROLE vyx_qorebridge SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO vyx_qorebridge;

-- start from nothing (a re-run never keeps an older, wider grant)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vyx_qorebridge;

GRANT SELECT ON "HedgeIntent" TO vyx_qorebridge;
GRANT UPDATE ("status", "leasedBy", "leaseUntil", "lastError") ON "HedgeIntent" TO vyx_qorebridge;
GRANT SELECT, INSERT ON "HedgeResult" TO vyx_qorebridge;
GRANT UPDATE ("status", "filledVolume", "avgPrice", "attempts", "lpOrderIds", "reason", "updatedAt") ON "HedgeResult" TO vyx_qorebridge;
GRANT SELECT ON "HedgeRoutingRule" TO vyx_qorebridge;
GRANT INSERT ("id", "brokerId", "type", "title", "body", "entityType", "entityId") ON "Notification" TO vyx_qorebridge;

-- self-check: prints the role's table rights; expected exactly the six lines above
SELECT table_name, string_agg(DISTINCT privilege_type, ', ' ORDER BY privilege_type) AS rights
FROM information_schema.role_column_grants WHERE grantee = 'vyx_qorebridge' GROUP BY table_name
UNION ALL
SELECT table_name || ' (table)', string_agg(privilege_type, ', ' ORDER BY privilege_type)
FROM information_schema.role_table_grants WHERE grantee = 'vyx_qorebridge' GROUP BY table_name
ORDER BY 1;
