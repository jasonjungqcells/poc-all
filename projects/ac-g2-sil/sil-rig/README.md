# AC Gen2 SIL Rig

A software-in-the-loop simulator for the **EMS+ Gen2** board, built for app and
mobile developers.

It serves **the real local device API on `:9112`** — the exact HTTP and WebSocket
surface the iOS installer, the Android installer and the Vue Web HMI already
speak. Those clients run **unmodified** against it. iOS, which has no simulator
today, gets one for free.

Everything the simulated device does is a **control**: a named, validated,
inspectable lever. Nothing is hidden behind a code path you cannot reach from
outside the process.

---

## Why this exists

Simulating below the app (in-process mocks, fake repositories) can never validate
the wire protocol, the response envelope, timeouts, TLS behaviour or transport
faults — because none of those exist inside the process. Simulating above the app
(the cloud simulator) cannot help a mobile client at all, because a phone talks to
the *board*, not to Azure IoT Core.

The device API is the only seam where a real client can be exercised end to end
without touching hardware.

Related design documents live one directory up:

| Document | What it covers |
|---|---|
| `../AC-GEN2-MPU-MCU-SIL-PLAN.md` | The plan. §11.1 is the contract this implements |
| `../AC-GEN2-SIL-CONTROL-PLANE.md` | Control taxonomy and the scenario catalog |
| `../AC-GEN2-FAILURE-CASE-CATALOG.md` | Where the failure data comes from |
| `../AC-GEN2-DIGITAL-TWIN-PLAN.md` | The site digital-twin web app |

---

## Quickstart

```bash
npm install
npm start                       # device API on :9112, control API on :9114
```

```bash
# The board is self-signed TLS in production, so it is here too. -k is expected.
curl -k https://localhost:9112/version/api

TOKEN=$(curl -sk -X POST https://localhost:9112/auth/token \
  -H 'Content-Type: application/json' -d '{"username":"installer"}' |
  sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

curl -sk https://localhost:9112/telemetry -H "Authorization: Bearer $TOKEN"
```

Load a scenario:

```bash
curl -s http://localhost:9114/scenarios | jq -r '.scenarios[].name'
curl -s -X POST http://localhost:9114/scenarios/grid_outage_with_low_battery/load
```

### Pointing an app at the rig

The apps target `https://192.168.100.1:9112` over Wi-Fi Direct. Point them at the
rig instead:

- **Android emulator** — the host is `10.0.2.2`, so the base URL is
  `https://10.0.2.2:9112`.
- **iOS simulator** — `https://localhost:9112` works directly.
- **Physical device** — use your Mac's LAN address and start the rig with
  `--host 0.0.0.0` (the default).

Both installer apps already ship a trust-all OkHttp client for the board's
self-signed certificate, so no certificate work is needed. This is also why the
rig serves HTTPS by default: dropping to plain HTTP would break the "unmodified
client" property.

---

## The control plane

Every lever is a control. There are ~155 of them across twelve groups:

| Group | What it controls |
|---|---|
| `sim.*` | Seed, clock, timezone, locale, boot delay, string stress |
| `site.*` | Topology: EMS type, device counts, backup type, CTs, commissioning |
| `plant.*` | Physics: PV, load, battery, grid, energy control mode |
| `net.*` | Wi-Fi, Ethernet, cellular, cloud reachability, DNS, TLS |
| `api.*` | Latency, failure rates, auth, malformed bodies, per-route faults |
| `mcu.*` | SPI link, register values, boundary modes, firmware state |
| `fw.*` | Update transfer rate, stall points, failure modes |
| `mi.*` | Microinverter discovery and health |
| `ble.*` | BLE pairing and wire errors (published for the client's own BLE mock) |
| `fault.*` | Injection, clearing, random chaos, codebook sweeps |
| `cloud.*` | Northbound traffic, SSE behaviour, cloud error codes |
| `db.*` | `edge_storage.db` contents and integrity faults |

```bash
curl -s http://localhost:9114/control                       # everything
curl -s http://localhost:9114/control?group=plant           # one group
curl -s http://localhost:9114/control/plant.battery.soc_pct # one lever

curl -s -X PUT http://localhost:9114/control/plant.battery.soc_pct \
  -H 'Content-Type: application/json' -d '{"value":12}'
```

Writes are validated. Out-of-range values, unknown enum members and unknown ids
are rejected rather than silently coerced, and a multi-control `patch` either
applies completely or not at all.

### The `diff` → scenario workflow

This is the point of the whole design. A developer fiddles with controls until
they reproduce a bug, then asks the rig what they changed:

```bash
curl -s http://localhost:9114/control/diff
```

`diff` returns only what an operator set, never values the physics model wrote as
a side effect. Paste it into a YAML file under `scenarios/` and the bug is now a
regression test that anyone can run by name.

---

## Scenarios

157 scenarios ship in `scenarios/`. They compose with `extends`, so a failure case
only has to describe the failure:

```yaml
name: grid_outage_with_low_battery
extends: base_backup_primary
description: Outage at 15 percent SoC. The battery drains and load is eventually shed.
tags: [grid, backup, battery, failure]
clock:
  start: "2026-06-21T18:00:00-07:00"
  rate: 60
controls:
  plant.pv_profile: sunrise_sunset
  plant.load_profile: evening_peak
  plant.battery.soc_pct: 15
timeline:
  - at: 5m
    set: { plant.grid.status: 1 }
    note: outage begins at dusk
expect:
  - at: 6m
    that: telemetry.Grid_Status
    equals: 1
```

Coverage by area:

- **Baselines** (8) — minimal, solar, residential, backup, multi-battery, no-CT
- **Happy paths** (10) — commissioning, normal day/night, self-consumption, export
- **Energy flow** (6) — deadband boundaries, all-zero, PV exactly equals load
- **Grid** (9) — outage, flapping, sag, swell, frequency excursion, black start
- **Battery** (8) — SoC extremes, degraded SoH, thermal derate, BMS fault, forced modes
- **Network** (17) — offline, flapping, latency, packet loss, Wi-Fi and cellular failures, captive portal, expired TLS, the 5-minute offline threshold
- **API and transport** (15) — 500s, expired tokens, hangs, malformed and truncated bodies, rate limits, WebSocket drops, duplicate and out-of-order responses, SSE stalls
- **Firmware** (11) — the classic stall at 47 percent, CRC failure, erase failure, power loss mid-transfer, rollback, incompatible image
- **Commissioning** (10) — reversed CTs, missing CTs, serial mismatch, already commissioned, interrupted, partial discovery
- **SPI and MCU** (11) — CRC errors, NACK storms, desync, short frames, 4K mode, reboot loops, the full register boundary sweep
- **Faults** (7) — codebook sweeps, faults that never clear, fault storms, unknown codes
- **Microinverters** (6), **BLE** (7), **time and locale** (9), **scale and soak** (6)

Named high-value cases worth running first: `fw_update_stall_47`,
`commissioning_ct_reversed`, `cloud_unreachable_local_ok`,
`grid_outage_with_low_battery`, `api_timeout_hang`, `sse_never_first_event`,
`register_boundary_sweep`, `fault_sweep_ems`, `tz_asia_seoul`, `chaos_monkey`.

---

## Determinism

A scenario name plus a seed fully determines a run. Random draws come from a
seeded `mulberry32` generator, and each subsystem uses a **derived substream**, so
enabling chaos in one subsystem does not shift the numbers any other subsystem
sees. Virtual time is explicit and steppable, so a run never depends on how fast
the host happens to be.

```bash
test/determinism.sh                       # defaults to chaos_monkey
test/determinism.sh normal_day 42 50
```

The script starts the same scenario twice on separate ports, steps both clocks
identically, and diffs the telemetry sequences.

---

## The seams

| Seam | What it is | Status |
|---|---|---|
| **D** | Local device API on `:9112` | Implemented — 11 endpoints, WebSocket bridge |
| **B** | MQTT-shaped IPC, 7 targets and 23 services | Implemented — in-process broker |
| **A** | Virtual MCU over SPI | Implemented — register map, framing, CRC |
| **C** | Cloud stub | Levers only; not a priority for app work |

The SPI layer is inspectable, which matters because the REST surface only ever
shows decoded values:

```bash
curl -s http://localhost:9114/spi/status          # 71-byte status frame, decoded
curl -s http://localhost:9114/spi/read/0x80       # a register read as wire bytes
```

### Register map

The virtual MCU loads the real `factory_register_map.json` when it can find it —
523 registers and 4,411 metrics for the `qcells_mcu` SPI profile, including the
15-register 1 Hz cyclic group. Metrics that represent real power flow are driven
by the physics model rather than by noise, so a register dump is internally
consistent: reactive and apparent power are derived from active power instead of
being sampled independently.

`mcu.registers.boundary_mode` drives **every** metric to its declared minimum,
maximum or beyond in a single run. That is the cheapest way to flush out
formatting, overflow and unit-conversion defects across all 4,411 metrics.

Point at a different map with `--register-map <path>`. A built-in fallback keeps
the rig usable without it.

---

## Physics

The plant model conserves energy. `plant.grid_w` and `plant.battery_w` are
**read-only by design** — they are computed, never set. A scenario cannot ask for
5 kW of PV, 1 kW of load and 0 W of battery and grid, because that is not a
situation a real site can be in, and UI work done against impossible data is
worthless.

The display conversion applies the `0.1 kW` deadband **before** rounding, matching
the device, and formats with `Locale.US` regardless of `sim.locale`. Both are
deliberate: they are what the real device does, and clients that assume otherwise
are the ones that break in the field.

---

## Testing

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit tests, including full scenario-corpus validation
test/smoke.sh        # end-to-end against a running rig
test/determinism.sh  # reproducibility proof
```

The corpus test is the load-bearing one: it fails if any scenario references an
unknown control, sets an out-of-range value, has a name that disagrees with its
filename, extends a base that does not exist, or injects a fault code that is not
in the codebook.

---

## CLI

```bash
npx tsx src/cli.ts serve --scenario normal_day --seed 42

npx tsx src/cli.ts ctl list plant
npx tsx src/cli.ts ctl get plant.battery.soc_pct
npx tsx src/cli.ts ctl set plant.battery.soc_pct 15
npx tsx src/cli.ts ctl diff              # paste straight into a scenario file
npx tsx src/cli.ts ctl patch my-setup.yaml
npx tsx src/cli.ts ctl reset

npx tsx src/cli.ts clock step 1h
npx tsx src/cli.ts clock pause
npx tsx src/cli.ts clock resume 60

npx tsx src/cli.ts scenario list
npx tsx src/cli.ts scenario load grid_outage
npx tsx src/cli.ts scenario state

npx tsx src/cli.ts fault inject e001
npx tsx src/cli.ts fault clear all
npx tsx src/cli.ts fault list

npx tsx src/cli.ts snapshot save bug-1234.json   # attach to a bug report
npx tsx src/cli.ts snapshot restore bug-1234.json
npx tsx src/cli.ts state
```

`serve --paused` starts with the clock stopped, which is the right mode for CI:
step time explicitly and assert at known points.

---

## Layout

```
src/
  cli.ts              serve | ctl | clock | scenario | fault | snapshot | state
  server.ts           wiring, tick loop, TLS, CORS
  core/               rng, clock, control registry, 197 control definitions
  plant/              PV and load profiles, energy-conserving physics
  faults/             device codebook, cloud error codes, injection manager
  ipc/                MQTT-shaped broker, 7 apps and their 23 services
  mcu/                register map, SPI framing, CRC16-CCITT, virtual MCU
  can/                g4 register model, dual PCS, bitmask faults, transport faults
  api/                the 11 device endpoints, envelope, fault-injection middleware
  ws/                 WsMqttBridge-compatible WebSocket
  control/            control-plane REST
  scenario/           YAML loader, extends resolution, timeline, expectations
scenarios/            157 scenario files
test/                 unit tests, smoke script, determinism proof
```

---

## Known gaps

- **No BLE transport.** The `ble.*` controls are published on `/state` for the
  client's own BLE mock to consume, so one scenario file still describes a whole
  run, but the rig does not advertise over Bluetooth.
- **Cloud seam is levers only.** Enough to make a client believe the cloud is
  unreachable or returning `4600`; not a cloud simulator.
- **MCU firmware source location is unknown**, so the virtual MCU is modelled from
  the register map and the SPI protocol document rather than from the STM32 source.
- **IEEE 1547 voltage bands are uncalibrated.** Tables 12 and 13 are paywalled, so
  all three abnormal operating categories share one continuous-operation band and
  are differentiated only by ride-through duration. Assert on how long an
  excursion is tolerated, not on the voltage at which a category trips.
