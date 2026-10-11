-- neon-usage-queries.sql  (2026-09-26, READ-ONLY)
-- Attribute Neon usage on the LIVE project (ep-morning-glade) once the quota block lifts.
-- Every statement below is a SELECT against statistics views. Nothing writes, resets or changes settings.
-- Do NOT run pg_stat_statements_reset() before the numbers are copied out: the counters are the evidence.
--
-- Run with psql against the DIRECT (non -pooler) host so the session is not multiplexed, e.g.
--   psql "$LIVE_DIRECT_URL" -X -v ON_ERROR_STOP=0 -f docs/audit/2026-09-24/neon-usage-queries.sql > neon-usage-$(date -u +%Y%m%dT%H%MZ).txt
-- (creds: vyX/.env.live; NOT .env, which still points at a dead project)
--
-- Note: counters in pg_stat_statements / pg_stat_* survive compute suspend on Neon only while the endpoint's
-- compute has not been restarted; if the numbers look tiny, the compute was restarted after the quota block
-- and the history is gone -- say so in the report rather than treating it as "low usage".

\pset pager off
\timing off

-- 0. Context: when were the counters last reset, and is the extension there?
SELECT now() AS captured_at, pg_postmaster_start_time() AS compute_started_at,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS db_stats_reset;
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
-- if absent: nothing to read in sections 1-3 (creating the extension is a write; do it only with the owner's go)

-- 1. Top 20 statements by CALLS
SELECT calls,
       round(total_exec_time::numeric, 0)            AS total_ms,
       round(mean_exec_time::numeric, 2)             AS mean_ms,
       rows,
       round(rows::numeric / NULLIF(calls, 0), 1)    AS rows_per_call,
       shared_blks_hit + shared_blks_read            AS blks,
       r.rolname                                     AS role,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) AS query
FROM pg_stat_statements s
LEFT JOIN pg_roles r ON r.oid = s.userid
ORDER BY calls DESC
LIMIT 20;

-- 2. Top 20 statements by TOTAL EXECUTION TIME (what kept the compute busy / scaled it up)
SELECT round(total_exec_time::numeric, 0)            AS total_ms,
       calls,
       round(mean_exec_time::numeric, 2)             AS mean_ms,
       round(max_exec_time::numeric, 2)              AS max_ms,
       rows,
       shared_blks_read                              AS blks_read_from_storage,
       r.rolname                                     AS role,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) AS query
FROM pg_stat_statements s
LEFT JOIN pg_roles r ON r.oid = s.userid
ORDER BY total_exec_time DESC
LIMIT 20;

-- 3. Top 20 statements by ROWS returned/affected (egress proxy: rows shipped to Vercel / engine / gateway)
SELECT rows,
       calls,
       round(rows::numeric / NULLIF(calls, 0), 1)    AS rows_per_call,
       round(total_exec_time::numeric, 0)            AS total_ms,
       r.rolname                                     AS role,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) AS query
FROM pg_stat_statements s
LEFT JOIN pg_roles r ON r.oid = s.userid
ORDER BY rows DESC
LIMIT 20;

-- 3b. Transactions per role (engine vs web vs gateway vs shadow usually use different roles)
SELECT r.rolname AS role, sum(calls) AS calls, round(sum(total_exec_time)::numeric, 0) AS total_ms, sum(rows) AS rows
FROM pg_stat_statements s LEFT JOIN pg_roles r ON r.oid = s.userid
GROUP BY r.rolname ORDER BY calls DESC;

-- 3c. Statement families: the known hot paths, grouped by table touched
SELECT CASE
         WHEN query ILIKE '%"LivePrice"%'           THEN 'LivePrice'
         WHEN query ILIKE '%"PostCloseEffect"%'     THEN 'PostCloseEffect (outbox)'
         WHEN query ILIKE '%"Position"%'            THEN 'Position'
         WHEN query ILIKE '%"Order"%'               THEN 'Order'
         WHEN query ILIKE '%"Account"%'             THEN 'Account'
         WHEN query ILIKE '%"BrokerSymbol"%'        THEN 'BrokerSymbol'
         WHEN query ILIKE '%"Broker"%'              THEN 'Broker'
         WHEN query ILIKE '%"AuditLog"%'            THEN 'AuditLog'
         WHEN query ILIKE '%"Candle"%' OR query ILIKE '%"Tick"%' THEN 'market data (should be VPS-local!)'
         WHEN query ILIKE 'SELECT 1%' OR query ILIKE 'select $1%' THEN 'health-check SELECT 1'
         WHEN query ILIKE 'BEGIN%' OR query ILIKE 'COMMIT%' OR query ILIKE 'ROLLBACK%' OR query ILIKE 'DEALLOCATE%' THEN 'txn control'
         ELSE 'other'
       END AS family,
       sum(calls) AS calls, round(sum(total_exec_time)::numeric, 0) AS total_ms, sum(rows) AS rows
FROM pg_stat_statements
GROUP BY 1 ORDER BY calls DESC;

-- 4. Database-wide counters (xact rate, rows returned = egress proxy, block reads)
SELECT datname, numbackends, xact_commit, xact_rollback,
       tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
       blks_read, blks_hit,
       round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       temp_bytes, stats_reset,
       round(xact_commit / GREATEST(EXTRACT(EPOCH FROM now() - COALESCE(stats_reset, pg_postmaster_start_time())) / 60, 1), 1) AS commits_per_min
FROM pg_stat_database
WHERE datname = current_database();

-- 5. Who is connected RIGHT NOW (engine / gateway / Vercel / shadow / psql)
SELECT application_name, client_addr, usename, state, count(*) AS conns,
       max(now() - backend_start) AS oldest_conn, max(now() - state_change) AS longest_in_state
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
GROUP BY application_name, client_addr, usename, state
ORDER BY conns DESC;

-- 5b. What the active ones are running
SELECT pid, usename, application_name, client_addr, state, now() - query_start AS running_for,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
ORDER BY query_start;

-- 6. Hot tables: scans vs index scans, churn, dead tuples (write amplification => WAL + storage)
SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
       n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del, n_live_tup, n_dead_tup,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('Position','Order','Account','LivePrice','PostCloseEffect','BrokerSymbol','Broker','AuditLog',
                  'Symbol','Group','TradingSession','Deal','DealerActivity','ShadowResult','Candle','Tick')
   OR n_tup_upd + n_tup_ins > 10000 OR seq_scan > 10000
ORDER BY seq_scan + COALESCE(idx_scan, 0) DESC
LIMIT 30;

-- 7. Storage: biggest relations (storage is billed; check nothing market-data-sized crept back into Neon)
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size, c.reltuples::bigint AS approx_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 15;
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;

-- 8. WAL generated since compute start (write volume; history/PITR storage grows with it)
SELECT pg_current_wal_lsn(), pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')) AS wal_total_since_timeline_start;
