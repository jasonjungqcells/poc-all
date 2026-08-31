#!/usr/bin/env bash
# Determinism proof.
#
# The rig's central claim is that a scenario name plus a seed fully determines a
# run. This starts the same scenario twice with the same seed, captures the
# telemetry sequence from each, and diffs them. Anything that differs is a
# non-determinism bug and makes every bug report from a developer unreproducible.
set -euo pipefail

cd "$(dirname "$0")/.."

SCENARIO=${1:-chaos_monkey}
SEED=${2:-20260101}
SAMPLES=${3:-25}
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

capture() {
  local label=$1 port=$2 ctlport=$3
  npx tsx src/cli.ts serve \
    --scenario "$SCENARIO" --seed "$SEED" \
    --port "$port" --control-port "$ctlport" --paused --no-tls >"$OUT/$label.log" 2>&1 &
  local pid=$!

  for _ in $(seq 1 40); do
    curl -s --max-time 1 "http://localhost:$ctlport/control/sim.seed" >/dev/null 2>&1 && break
    sleep 0.5
  done

  local token
  token=$(curl -s --max-time 5 -X POST "http://localhost:$port/auth/token" \
    -H 'Content-Type: application/json' -d '{"username":"det"}' |
    sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

  : >"$OUT/$label.txt"
  for _ in $(seq 1 "$SAMPLES"); do
    # Step the clock explicitly rather than sleeping, so the sequence depends on
    # virtual time alone and never on how fast this machine happens to be.
    curl -s --max-time 5 -X POST "http://localhost:$ctlport/clock/step" \
      -H 'Content-Type: application/json' -d '{"duration":"1m"}' >/dev/null
    curl -s --max-time 5 "http://localhost:$port/telemetry" \
      -H "Authorization: Bearer $token" >>"$OUT/$label.txt"
    printf '\n' >>"$OUT/$label.txt"
  done

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

echo "scenario=$SCENARIO seed=$SEED samples=$SAMPLES"
echo "run A..."
capture a 19112 19114
echo "run B..."
capture b 19122 19124

if diff -q "$OUT/a.txt" "$OUT/b.txt" >/dev/null; then
  echo "PASS: identical telemetry sequences across both runs"
  wc -l <"$OUT/a.txt" | xargs printf '      %s samples compared\n'
else
  echo "FAIL: runs diverged"
  diff "$OUT/a.txt" "$OUT/b.txt" | head -40
  exit 1
fi
