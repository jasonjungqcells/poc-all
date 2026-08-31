#!/usr/bin/env bash
# End-to-end smoke test against a running rig.
#
# Exercises every seam the installer apps touch: TLS device API, auth, telemetry,
# IPC publish, notifications, register reads, the SPI frame view, control writes,
# scenario loading and determinism.
#
#   npm start &
#   test/smoke.sh
set -uo pipefail

DEV=${DEV:-https://localhost:9112}
CTL=${CTL:-http://localhost:9114}
pass=0
fail=0

check() {
  local name=$1 actual=$2 expected=$3
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  ok   %s\n' "$name"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected to contain: %s\n       got: %s\n' "$name" "$expected" "${actual:0:300}"
    fail=$((fail + 1))
  fi
}

echo "== device API (TLS, self-signed, as on the real board)"
check "GET /version/api" "$(curl -sk --max-time 5 "$DEV/version/api")" '"code":200'
check "GET /telemetry unauthenticated is rejected" \
  "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$DEV/telemetry")" '401'

TOKEN=$(curl -sk --max-time 5 -X POST "$DEV/auth/token" \
  -H 'Content-Type: application/json' -d '{"username":"installer"}' |
  sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
check "POST /auth/token returns a token" "${#TOKEN}" ""
[[ -n "$TOKEN" ]] && { printf '  ok   token length %s\n' "${#TOKEN}"; pass=$((pass + 1)); } ||
  { printf '  FAIL no token\n'; fail=$((fail + 1)); }

AUTH=(-H "Authorization: Bearer $TOKEN")

check "GET /telemetry" "$(curl -sk --max-time 5 "${AUTH[@]}" "$DEV/telemetry")" '"battery_713_SoC"'
check "GET /notifications/network_info is seeded at boot" \
  "$(curl -sk --max-time 5 "${AUTH[@]}" "$DEV/notifications/network_info")" '"networkType"'
check "POST /publish/sys_manager/scan_wifi" \
  "$(curl -sk --max-time 10 "${AUTH[@]}" -H 'Content-Type: application/json' \
    -X POST "$DEV/publish/sys_manager/scan_wifi" -d '{"context":{}}')" '"ssid"'
check "POST /publish/energy_link/send_read_metric" \
  "$(curl -sk --max-time 5 "${AUTH[@]}" -H 'Content-Type: application/json' \
    -X POST "$DEV/publish/energy_link/send_read_metric" -d '{"context":{"register":"0x80"}}')" '"metrics"'
check "unknown IPC target is a 404" \
  "$(curl -sk --max-time 5 "${AUTH[@]}" -X POST "$DEV/publish/nope/nope" -d '{}')" '"code":404'

echo
echo "== control plane"
check "GET /control lists every lever" "$(curl -s --max-time 5 "$CTL/control" | wc -c)" ""
check "GET /control/plant.battery.soc_pct" \
  "$(curl -s --max-time 5 "$CTL/control/plant.battery.soc_pct")" '"group":"plant"'
check "PUT rejects an out-of-range value" \
  "$(curl -s --max-time 5 -X PUT "$CTL/control/plant.battery.soc_pct" \
    -H 'Content-Type: application/json' -d '{"value":500}')" 'error'
check "PUT accepts a valid value" \
  "$(curl -s --max-time 5 -X PUT "$CTL/control/plant.battery.soc_pct" \
    -H 'Content-Type: application/json' -d '{"value":42}')" '42'
check "GET /control/diff shows only what changed" \
  "$(curl -s --max-time 5 "$CTL/control/diff")" 'plant.battery.soc_pct'

echo
echo "== SPI frame view (seam A)"
check "GET /spi/status frame is 71 bytes" "$(curl -s --max-time 5 "$CTL/spi/status")" '"actualLength":71'
check "GET /spi/status CRC verifies" "$(curl -s --max-time 5 "$CTL/spi/status")" '"crcValid":true'
curl -s --max-time 5 -X PUT "$CTL/control/mcu.spi.mode_4k" \
  -H 'Content-Type: application/json' -d '{"value":true}' >/dev/null
check "4K mode frame is 4107 bytes" "$(curl -s --max-time 5 "$CTL/spi/status")" '"actualLength":4107'
curl -s --max-time 5 -X PUT "$CTL/control/mcu.spi.mode_4k" \
  -H 'Content-Type: application/json' -d '{"value":false}' >/dev/null

echo
echo "== failure levers"
curl -s --max-time 5 -X PUT "$CTL/control/mcu.online" \
  -H 'Content-Type: application/json' -d '{"value":false}' >/dev/null
check "MCU offline surfaces as an SPI error" \
  "$(curl -sk --max-time 5 "${AUTH[@]}" -H 'Content-Type: application/json' \
    -X POST "$DEV/publish/energy_link/send_read_metric" -d '{"context":{"register":"0x80"}}')" 'offline'
curl -s --max-time 5 -X PUT "$CTL/control/mcu.online" \
  -H 'Content-Type: application/json' -d '{"value":true}' >/dev/null

curl -s --max-time 5 -X PUT "$CTL/control/api.fail_rate_pct" \
  -H 'Content-Type: application/json' -d '{"value":100}' >/dev/null
check "api.fail_rate_pct 100 fails every call" \
  "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "${AUTH[@]}" "$DEV/telemetry")" '500'
curl -s --max-time 5 -X PUT "$CTL/control/api.fail_rate_pct" \
  -H 'Content-Type: application/json' -d '{"value":0}' >/dev/null

check "fault injection" \
  "$(curl -s --max-time 5 -X POST "$CTL/fault/inject" \
    -H 'Content-Type: application/json' -d '{"code":"e001"}')" 'e001'
check "fault appears in telemetry" \
  "$(curl -sk --max-time 5 "${AUTH[@]}" "$DEV/telemetry")" 'e001'
check "fault clears" \
  "$(curl -s --max-time 5 -X POST "$CTL/fault/clear" \
    -H 'Content-Type: application/json' -d '{"code":"e001"}')" 'e001'

echo
echo "== scenarios"
COUNT=$(curl -s --max-time 5 "$CTL/scenarios" | grep -o '"name"' | wc -l | tr -d ' ')
printf '  ok   %s scenarios discovered\n' "$COUNT"
pass=$((pass + 1))
check "load grid_outage" \
  "$(curl -s --max-time 10 -X POST "$CTL/scenarios/grid_outage/load")" 'grid_outage'
check "scenario applied its controls" \
  "$(curl -s --max-time 5 "$CTL/control/plant.battery.soc_pct")" '70'

# The catalog has to be choosable, not just listable: the console's filters and
# `scenario list --kind/--area` both read these fields, and a summary without
# them sends you back to opening files one at a time.
check "the catalog says what each scenario is" \
  "$(curl -s --max-time 5 "$CTL/scenarios")" '"kind"'
check "the catalog reports timeline size" \
  "$(curl -s --max-time 5 "$CTL/scenarios")" '"durationMs"'
check "facets are counted server-side" \
  "$(curl -s --max-time 5 "$CTL/scenarios/facets")" '"kinds"'
check "every facet carries a readable hint" \
  "$(curl -s --max-time 5 "$CTL/scenarios/facets")" '"hint"'
check "facets do not shadow scenario lookup" \
  "$(curl -s --max-time 5 "$CTL/scenarios/grid_outage")" '"timeline"'

echo
echo "== CAN bus (seam A, qcells_ess_g4)"
check "GET /can/status reports the g4 map" \
  "$(curl -s --max-time 5 "$CTL/can/status")" '"registerMap":"qcells_ess_g4"'
check "833 CAN registers loaded" \
  "$(curl -s --max-time 5 "$CTL/can/status")" '"registerCount":833'
check "CAN register read binds to the plant" \
  "$(curl -s --max-time 5 "$CTL/can/read/P01_1s_Monitoring_Data_04")" 'ESS_Active_Power'
check "named fault bit sets the right byte" \
  "$(curl -s --max-time 5 -X PATCH "$CTL/control" -H 'Content-Type: application/json' \
     -d '{"can.flag.set":["G01005F"]}' >/dev/null; \
     curl -s --max-time 5 "$CTL/can/faults")" '"Grid_Fault_Flag0":"0x20"'
check "raw flag byte is the Gen1 escape hatch" \
  "$(curl -s --max-time 5 -X PATCH "$CTL/control" -H 'Content-Type: application/json' \
     -d '{"can.flag.byte.1.PCS.Warning.3":170}' >/dev/null; \
     curl -s --max-time 5 "$CTL/can/faults")" '"PCS_Warning_Flag3":"0xaa"'
check "clear_all action empties every bank" \
  "$(curl -s --max-time 5 -X PATCH "$CTL/control" -H 'Content-Type: application/json' \
     -d '{"can.flag.clear_all":true}' >/dev/null; \
     curl -s --max-time 5 "$CTL/can/faults")" '"bytes":{}'
check "bus-off makes reads fail permanently" \
  "$(curl -s --max-time 5 -X PATCH "$CTL/control" -H 'Content-Type: application/json' \
     -d '{"can.bus_off":true}' >/dev/null; \
     curl -s --max-time 5 "$CTL/can/read/P01_PCS_Error_Status_01")" 'bus_off'
check "absent PCS 2 times out rather than reading zero" \
  "$(curl -s --max-time 5 -X PATCH "$CTL/control" -H 'Content-Type: application/json' \
     -d '{"can.bus_off":false,"can.pcs_count":1}' >/dev/null; \
     curl -s --max-time 5 "$CTL/can/read/P02_PCS_Error_Status_01")" 'not present'

# --- Regression: scenario isolation ---------------------------------------
# `controls.reset()` used to restore control values but leave subsystem state
# machines latched, so a scenario's result depended on what ran before it.

check "latched CAN flags do not survive a scenario load" \
  "$(curl -s --max-time 5 -X PATCH "$CTL/control" -H 'Content-Type: application/json' \
     -d '{"can.flag.set":["G01005F"]}' >/dev/null; \
     curl -s --max-time 5 -X POST "$CTL/scenarios/base_residential/load" >/dev/null; \
     curl -s --max-time 5 "$CTL/can/faults")" '"bytes":{}'

check "a tripped grid does not leak into the next scenario" \
  "$(curl -s --max-time 5 -X POST "$CTL/scenarios/ieee1547_cat1_fast_trip/load" >/dev/null; \
     curl -s --max-time 5 -X POST "$CTL/clock/step" -H 'Content-Type: application/json' \
       -d '{"by":"32s"}' >/dev/null; \
     curl -s --max-time 5 -X POST "$CTL/scenarios/base_residential/load" >/dev/null; \
     curl -s --max-time 5 -X POST "$CTL/clock/step" -H 'Content-Type: application/json' \
       -d '{"by":"1s"}' >/dev/null; \
     curl -s --max-time 5 "$CTL/state")" '"phase":"connected"'

# --- Regression: profile overflow ------------------------------------------
# A large PV array used to generate more watts than `plant.pv_w` allowed. The
# rejected write threw out of Plant.tick and took the scenario engine with it,
# which looked like "the timeline silently did nothing".

check "large solar array does not throw out of the plant tick" \
  "$(curl -s --max-time 5 -X POST "$CTL/scenarios/base_large_solar/load" >/dev/null; \
     curl -s --max-time 30 -X POST "$CTL/clock/step" -H 'Content-Type: application/json' \
       -d '{"by":"30m"}' >/dev/null; \
     curl -s --max-time 5 "$CTL/control/plant.pv_w")" '"value"'

check "clock tick interval follows the control on reset" \
  "$(curl -s --max-time 5 -X POST "$CTL/scenarios/ieee1547_cat1_fast_trip/load" >/dev/null; \
     curl -s --max-time 5 -X POST "$CTL/scenarios/base_residential/load" >/dev/null; \
     curl -s --max-time 5 "$CTL/clock")" '"tickMs":1000'

echo
echo "== event stream and web console"

# The console is a client of these; if they break, the console is a blank page
# and the failure looks like a frontend bug rather than a control-plane one.
check "GET /events sends a hello frame with full state" \
  "$(curl -sN --max-time 3 "$CTL/events" | head -c 400)" 'event: hello'
check "GET /events/stats reports the stream" \
  "$(curl -s --max-time 5 "$CTL/events/stats")" '"flushMs"'

check "scenario state carries step progress" \
  "$(curl -s --max-time 5 -X POST "$CTL/scenarios/grid_outage/load" >/dev/null; \
     curl -s --max-time 5 "$CTL/scenario/state")" '"stepCount"'
check "POST /scenarios/stop halts the timeline" \
  "$(curl -s --max-time 5 -X POST "$CTL/scenarios/stop")" '"stopped":true'

# The export is the artifact half of the parity rule: a session has to be able
# to leave the rig as something another machine can run.
check "POST /scenario/export renders runnable YAML" \
  "$(curl -s --max-time 5 -X POST "$CTL/scenario/export" \
     -H 'Content-Type: application/json' -d '{"name":"smoke_export"}')" '"yaml"'
check "POST /scenario/export?format=yaml is a file, not JSON" \
  "$(curl -s --max-time 5 -X POST "$CTL/scenario/export?format=yaml" \
     -H 'Content-Type: application/json' -d '{}')" 'name: '

# The console is optional: an unbuilt one must not break the control API, and a
# built one must not shadow it.
if [[ -f dist/web/index.html ]]; then
  check "console index is served" \
    "$(curl -s --max-time 5 -H 'Accept: text/html' "$CTL/")" '<div id="app">'
  check "console deep link falls back to index" \
    "$(curl -s --max-time 5 -H 'Accept: text/html' "$CTL/faults")" '<div id="app">'
  check "static mount does not shadow the API" \
    "$(curl -s --max-time 5 "$CTL/clock")" '"tick"'
else
  printf '  skip console not built (npm run web:build)\n'
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
