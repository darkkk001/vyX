#!/usr/bin/env python3
"""Counts the SEQUENTIAL DATABASE ROUND TRIPS one engine market fill costs, from the server log.

Why a log and not the source: a `pool.begin()`, a `SET TRANSACTION`, a `ROLLBACK` and a `COMMIT` are
each a full round trip and none of them looks like a query where it is written. The latency model the
L2 work validated is `app_ms ~= compute + sequential_round_trips x RTT`, so the count IS the latency on
a 5 ms link -- it has to be measured.

  1. the scratch cluster logs every statement:
       ALTER SYSTEM SET log_statement='all'; SELECT pg_reload_conf();
  2. run the bracketed fill:
       cargo test -p order-management --test open_position_depth_db measure_the_fill_paths_round_trips
  3. this script reads the window between `VYXMARK fill-begin` and `VYXMARK fill-end`:
       python scripts/measure-fill-round-trips.py <path to server.log>

Prints every statement in order, with the count. Statements are listed in full (shortened) so the
report can say WHICH trips were removed, not just how many.
"""

import re
import sys

LOG = sys.argv[1] if len(sys.argv) > 1 else None
if not LOG:
    sys.exit("usage: measure-fill-round-trips.py <server.log>")

text = open(LOG, encoding="utf-8", errors="replace").read()

# the LAST window in the file: a re-run appends, and the newest measurement is the one wanted
begin = text.rfind("VYXMARK fill-begin")
end = text.rfind("VYXMARK fill-end")
if begin < 0 or end < 0 or end < begin:
    sys.exit("no complete VYXMARK fill-begin .. fill-end window in %s" % LOG)

window = text[begin:end]

# log_line_prefix '%m [%p] ' then `statement: <sql>` / `execute <name>: <sql>`
stmt = re.compile(r"^(?P<when>\S+ \S+ \S+) \[(?P<pid>\d+)\] (?:LOG:  )?(?:statement|execute [^:]*): (?P<sql>.*)$", re.M)

rows = []
for m in stmt.finditer(window):
    sql = m.group("sql").strip()
    # the window is cut at the marker TEXT, so the closing marker's own statement contributes its
    # prefix `SELECT '` -- both markers are dropped here, never counted as the fill's work
    if sql.startswith("SELECT '"):
        continue
    # a multi-line statement continues on following indented lines; the first line identifies it
    rows.append((m.group("when"), m.group("pid"), " ".join(sql.split())))

print("=== %d sequential round trips ===" % len(rows))
width = max((len(r[2]) for r in rows), default=0)
for n, (when, pid, sql) in enumerate(rows, 1):
    short = sql if len(sql) <= 110 else sql[:107] + "..."
    print("%3d  pid=%s  %s" % (n, pid, short))
print("=== %d sequential round trips ===" % len(rows))
_ = width
