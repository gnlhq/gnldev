#!/usr/bin/env bash
# S16 driver: process 1 on the BASE tree, process 2 on the BASE (A0) or the CANDIDATE (D). Same store each time.
# usage: mig.sh <base-root> <candidate-root> <out-file>
set -u
BASE=$1; CAND=$2; OUT=$3; : > "$OUT"
TSX="$CAND/node_modules/.bin/tsx"; MIG="$CAND/packages/durable/test/k3d-migration/mig.ts"
PGBASE=${GNL_PG_URL:-postgres://postgres:postgres@127.0.0.1:56100/postgres}
WORK=$(mktemp -d)
for backend in sqlite pg; do
  for scen in approve-raw-key crash-then-approve; do
    for second in base cand; do
      name="k3d_mig_${backend}_${scen//-/_}_${second}"
      if [ $backend = pg ]; then
        docker exec rel0171-pg psql -U postgres -c "DROP DATABASE IF EXISTS $name WITH (FORCE)" -c "CREATE DATABASE $name" >/dev/null 2>&1
        DB="${PGBASE%/*}/$name"
      else DB="$WORK/$name.db"; fi
      EFF="$WORK/$name.eff"; rm -f "$EFF"
      E="BACKEND=$backend DB=$DB EFFECTS=$EFF"
      if [ $scen = approve-raw-key ]; then R1=pend; R2=answer; else R1=crash; R2=resume; fi
      root2=$([ $second = base ] && echo "$BASE" || echo "$CAND")
      echo "=== $backend / $scen / process2=$second" >> "$OUT"
      env $E ROOT="$BASE" ROLE=$R1 "$TSX" "$MIG" 2>&1 | grep -E "^P1" >> "$OUT"
      [ $scen = crash-then-approve ] && sleep 7   # past the dead process's liveness grace
      env $E ROOT="$root2" ROLE=$R2 APPROVE_KEY=call_0 "$TSX" "$MIG" 2>&1 | grep -E "^R[12]" >> "$OUT"
      echo "FINAL effects=$(wc -l < "$EFF" 2>/dev/null || echo 0)" >> "$OUT"
      [ $backend = pg ] && docker exec rel0171-pg psql -U postgres -c "DROP DATABASE IF EXISTS $name WITH (FORCE)" >/dev/null 2>&1
    done
  done
done
rm -rf "$WORK"
