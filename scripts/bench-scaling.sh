#!/bin/bash
# Row-count scaling curve. Narrow schema so row count can go very high without
# an enormous file (~30 bytes/row). Generation uses table doubling, which costs
# ~2N total work instead of N recursive-CTE steps.
set -u
DIR=${1:-/private/tmp/claude-501/scale}
mkdir -p "$DIR"

ms() { python3 -c 'import time;print(time.time())'; }
elapsed() { python3 -c "print(f'{($2-$1)*1000:.1f}')"; }

# Measure one query, warm (second run), print ms only.
timeq() {
  local db="$1" sql="$2"
  sqlite3 "$db" "$sql" > /dev/null 2>&1
  local t0 t1
  t0=$(ms); sqlite3 "$db" "$sql" > /dev/null 2>&1; t1=$(ms)
  elapsed "$t0" "$t1"
}

# Baseline: cost of spawning sqlite3 and opening the db at all.
baseline() {
  local db="$1" t0 t1
  sqlite3 "$db" "SELECT 1;" > /dev/null 2>&1
  t0=$(ms); sqlite3 "$db" "SELECT 1;" > /dev/null 2>&1; t1=$(ms)
  elapsed "$t0" "$t1"
}

gen() {
  local db="$1" target="$2"
  [ -f "$db" ] && return 0
  sqlite3 "$db" <<SQL
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, s TEXT);
INSERT INTO t(n,s) VALUES(1,'row0000001');
SQL
  local have=1
  while [ "$have" -lt "$target" ]; do
    sqlite3 "$db" "INSERT INTO t(n,s) SELECT n + $have, printf('row%07d', n + $have) FROM t LIMIT $((target - have));"
    have=$(sqlite3 "$db" "SELECT count(*) FROM t;")
  done
}

printf '%12s %10s %8s %9s %9s %9s %10s %11s\n' \
  ROWS SIZE OPEN FIRST "OFFSET" KEYSET "COUNT(*)" "SCAN"
for n in 10000 100000 1000000 10000000 100000000; do
  db="$DIR/scale-$n.sqlite"
  gen "$db" "$n" >/dev/null 2>&1
  actual=$(sqlite3 "$db" "SELECT count(*) FROM t;")
  size=$(ls -lh "$db" | awk '{print $5}')
  b=$(baseline "$db")
  sub() { python3 -c "print(f'{max(0.0, $1 - $b):.1f}')"; }

  first=$(timeq "$db" "SELECT id,n,s FROM t ORDER BY id LIMIT 500;")
  off=$(timeq "$db" "SELECT id,n,s FROM t ORDER BY id LIMIT 500 OFFSET $((actual>500 ? actual-500 : 0));")
  keyset=$(timeq "$db" "SELECT id,n,s FROM t ORDER BY id DESC LIMIT 500;")
  cnt=$(timeq "$db" "SELECT count(*) FROM t;")
  scan=$(timeq "$db" "SELECT count(*) FROM t WHERE s = 'no-such-value';")

  printf '%12s %10s %8s %9s %9s %9s %10s %11s\n' \
    "$actual" "$size" "${b}" "$(sub "$first")" "$(sub "$off")" "$(sub "$keyset")" "$(sub "$cnt")" "$(sub "$scan")"
done
echo
echo "all times ms; OPEN = sqlite3 spawn+open (subtracted from the rest)"
