# AC Gen2 EMS+ — Software-in-the-Loop (SIL) Rig

**A fully controlled, deterministic simulation of the EMS+ board, serving the real device API on `:9112`.**

App developers point the iOS installer, the Android installer, or the Vue Web HMI at this rig
*unmodified*, and get a complete, scriptable, reproducible device — no hardware, no lab, no
commissioning appointment.

```
197 controls · 157 scenarios · 8,106 metrics from the factory register map
17 unit tests · 33 smoke checks · byte-identical replay under a fixed seed
```

---

## Table of contents

1. [Why this exists](#1-why-this-exists)
2. [What it simulates](#2-what-it-simulates)
3. [Quickstart](#3-quickstart)
4. [Pointing the apps at it](#4-pointing-the-apps-at-it)
5. [Concepts: controls, scenarios, seams](#5-concepts-controls-scenarios-seams)
6. [The control plane](#6-the-control-plane)
7. [Scenarios](#7-scenarios)
8. [Determinism](#8-determinism)
9. [Fault injection](#9-fault-injection)
10. [The two buses: SPI and CAN](#10-the-two-buses-spi-and-can)
11. [Grid support and IEEE 1547](#11-grid-support-and-ieee-1547)
12. [How this compares to Gen1](#12-how-this-compares-to-gen1)
13. [Testing and CI](#13-testing-and-ci)
14. [Troubleshooting](#14-troubleshooting)
15. [Repository map](#15-repository-map)
16. [Planning documents](#16-planning-documents)

---

## 1. Why this exists

Developing an app against the AC Gen2 EMS+ has, until now, required a physical board. That
means:

- **You cannot test what you cannot cause.** A battery at 3 % SoC, a grid outage at 2 a.m., a
  bus-off CAN controller, a firmware update that fails CRC on the last chunk — all of these are
  real, all of them ship bugs, and none of them are things you can ask a lab bench to do on
  demand.
- **You cannot reproduce a bug.** Two runs on real hardware are never the same run.
- **You cannot test in CI.** There is no board in the build pipeline.
- **iOS had no simulator at all.** Android had a half-finished in-app scenario simulator; iOS had
  nothing.

This rig removes the board from the loop while keeping the interface identical.

### The central design decision

**The rig serves the real local device API on `:9112`** — the exact HTTP + WebSocket surface the
installer apps already speak, with the same self-signed TLS, the same `EmbResponse<T>` envelope,
the same MQTT-over-WebSocket bridge at `/ws`.

The alternative — a mock layer inside each app — was rejected because it tests the mock, not the
app. Every client that ships to a real board takes a different code path than the one under test,
which is precisely how integration bugs survive to production.

Because the seam is the wire and not the code, **clients run unmodified**, all three of them, and
iOS gets a simulator for free.

---

## 2. What it simulates

The EMS+ board has two processors, and this rig models both:

| | **MPU** | **MCU** |
|---|---|---|
| Silicon | NXP i.MX, ARM64 | STM32 |
| OS | Yocto kirkstone Linux, UniEP containers | bare metal |
| Role | Applications, local API, cloud link, BLE, Wi-Fi | Real-time control |
| Talks to | Apps (`:9112`), cloud, MCU | PCS, BDC, BMS, meters |

They are linked by **SPI** (MPU is master, `/dev/spidev2.0`, 71-byte fixed frames). Below the
MCU, a **CAN** bus reaches the PCS units, their inverter/converter CPUs, and the JF2 battery
stack.

The rig implements all of it:

- **A plant model** — an energy-conserving physical simulation of PV, battery, load, and grid.
  Power flows balance; you cannot set the grid power directly because it is *derived*.
- **A virtual MCU** — 523 registers / 4,411 metrics, generated from the production
  `factory_register_map.json`, with real SPI framing and CRC16.
- **A virtual CAN bus** — 833 registers / 2,985 metrics from the `qcells_ess_g4` map, with
  dual-PCS support and bitmask fault flags.
- **An MQTT IPC broker** — 7 targets × 23 services, matching the real `MqttKey` enums.
- **The device REST API** — all 11 endpoints, with the real envelope and error codes.
- **The WebSocket bridge** — `WsMqttBridge`-compatible, for the Web HMI.
- **A fault manager** — every fault settable *and clearable*, with a cloud error-code catalogue.
- **Firmware update sessions**, **BLE pairing**, **Wi-Fi/Ethernet/cellular networking**,
  **micro-inverter scanning**, **commissioning**, and a **virtual `edge_storage.db`**.

---

## 3. Quickstart

**Requirements:** Node 22+. Nothing else. No Docker, no Yocto, no 250 GB of build tree.

```bash
cd sil-rig
npm install
npm run serve
```

```
[sil info] device API   https://0.0.0.0:9112   (point installer apps here)
[sil info] websocket    wss://0.0.0.0:9112/ws
[sil info] control API  http://0.0.0.0:9114/control
[sil info] register map 520 registers / 4411 metrics, 15 cyclic
[sil info] seed 1
```

Two ports, and the split matters:

- **`:9112` — the device API.** What the real board serves, on the same paths, with the same
  envelope. TLS, self-signed. This is the port your app talks to. **No simulation *controls* are
  exposed here** — you cannot change the simulated world through `:9112` — because anything the
  app can drive, the app might come to depend on.

  Two deliberate exceptions, both read-only and both additive:
  `GET /version/api` includes `simulator: true` and `rig: "sil-rig"`, and `GET /_sil/services`
  lists the virtual MPU services. A simulator that is *indistinguishable* from real hardware is a
  hazard — it lets a rig be mistaken for a board during a field test — so identifying itself is a
  safety property, not a leak. Just don't branch app behaviour on those fields.
- **`:9114` — the control plane.** Plain HTTP. This is where *you* drive the simulation. The app
  never sees it.

Verify it:

```bash
# The device API, as an app sees it
curl -k https://localhost:9112/version/api

TOKEN=$(curl -sk -X POST https://localhost:9112/auth/token \
  -H 'Content-Type: application/json' -d '{"password":"admin"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"])')

curl -k -H "Authorization: Bearer $TOKEN" https://localhost:9112/telemetry
```

```json
{"code":200,"message":"OK","data":{
  "pv_200_W":4.0,"grid_200_W":0.0,"load_200_W":1.0,
  "battery_200_W":-3.0,"battery_713_SoC":50.2,"battery_713_SoH":100.0,
  "Grid_Status":0,"energyControl":1,"networkType":"wifi"}}
```

Now change something and watch it move:

```bash
# Drain the battery to 8 %
curl -X PUT localhost:9114/control/plant.battery.soc_pct \
  -H 'Content-Type: application/json' -d '{"value":8}'

# Cut the grid
curl -X PUT localhost:9114/control/plant.grid.status \
  -H 'Content-Type: application/json' -d '{"value":1}'
```

Or do both, and forty other things, with one scenario:

```bash
npx tsx src/cli.ts scenario load grid_outage_with_low_battery
```

---

## 4. Pointing the apps at it

The real board serves the installer API at `https://192.168.100.1:9112` over Wi-Fi Direct. Both
installer apps already ship a trust-all OkHttp client (`EmbApiModule.kt::getUnsafeOkhttpClient`),
because the board's certificate is self-signed — **so the rig serves self-signed TLS too**. Running
plain HTTP would be more convenient and would break the "unmodified client" property, so it is
off by default. (`--no-tls` exists for `curl` convenience during development.)

### Android installer

Point the base URL at your Mac's LAN address:

```
https://<your-mac-ip>:9112
```

The app's existing trust-all client accepts the rig's certificate with no change.

### iOS installer

Same base URL. iOS has no built-in simulator, so this is its first one. If `ATS` blocks the
self-signed certificate, add an `NSExceptionDomains` entry for your development host — or run the
rig with `--no-tls` and use `http://`.

### Vue Web HMI

Set the WebSocket endpoint to `wss://<your-mac-ip>:9112/ws`. The bridge speaks the same
`WsMqttBridge` protocol, so topic subscriptions and the `<app>/<req|res|noti>/<service>`
addressing work as-is.

### Binding

The rig binds `0.0.0.0` by default so phones on the same Wi-Fi can reach it. Use
`--host 127.0.0.1` to keep it local.

---

## 5. Concepts: controls, scenarios, seams

Three ideas, and everything else follows from them.

### Controls

A **control** is one named, typed, validated, range-checked lever on the simulation.
`plant.battery.soc_pct` is a control. So is `mcu.spi.crc_error_rate_pct`, and
`net.wifi.rssi_dbm`, and `can.bus_off`.

Controls are the *only* way to influence the rig. There are no hidden knobs, no magic env vars,
no code paths reachable only by editing source. This is deliberate: if it can happen, it has a
name, and if it has a name it can be scripted, diffed, snapshotted, and put in CI.

Some controls are **read-only by design**. `plant.grid_w` is derived — grid power is whatever is
left over after PV, load, and battery. You cannot set it, because setting it would let you
describe a site that violates conservation of energy, and then every downstream number would be a
lie. Set the causes; read the effect.

### Scenarios

A **scenario** is a YAML file that sets a batch of controls, optionally on a timeline, optionally
with expectations. It composes: scenarios `extends` a base, so `grid_outage_with_low_battery` inherits
`base_backup_primary` and overrides what differs.

Scenarios exist because "reproduce the bug" should be one command, and because the interesting
states of an energy system are *combinations* — low SoC **and** a grid outage **and** a cold
battery is a different bug from any of the three alone.

### Seams

A **seam** is a place where the simulation can be cut into the stack. The rig supports four, and
the priority order is deliberate:

| | Seam | What it is | Why this priority |
|---|---|---|---|
| **D** | **Local device API `:9112`** | The app-facing HTTP + WS surface | **Highest.** Clients run unmodified. This is the whole point. |
| **B** | **MQTT IPC** | The `<app>/<req\|res\|noti>/<service>` bus between MPU services | Second. Reachable from the browser via the WS bridge, so no `LD_PRELOAD` tricks are needed. |
| **A** | **Virtual SPI + CAN** | Register-level buses to the MCU and PCS | Third. Where boundary-value coverage of 8,106 metrics comes from, nearly free. |
| **C** | **Cloud stub** | The device↔cloud link | Lowest. Useful, but not what app developers are blocked on. |

---

## 6. The control plane

### From the CLI

```bash
npx tsx src/cli.ts ctl list                       # every control, with type and range
npx tsx src/cli.ts ctl list plant                 # just one group
npx tsx src/cli.ts ctl get plant.battery.soc_pct
npx tsx src/cli.ts ctl set plant.battery.soc_pct 15
npx tsx src/cli.ts ctl diff                       # only what you changed from defaults
npx tsx src/cli.ts ctl reset
```

### Over HTTP

```bash
GET    :9114/control              # all controls and current values
GET    :9114/control/diff         # non-default values only
GET    :9114/control/:id
PUT    :9114/control/:id          {"value": 15}
PATCH  :9114/control              {"a": 1, "b": 2}   # atomic bulk write
POST   :9114/control/reset
```

`PATCH` is atomic: every value is validated before any is committed, so a bad control id in a
batch of forty leaves the rig untouched rather than half-applied.

### The 15 control groups

| Group | Controls | What it covers |
|---|---:|---|
| `grid` | 20 | IEEE 1547 ride-through, trip, enter-service, volt-VAR, volt-Watt |
| `plant` | 22 | PV, battery, load, grid — the physics |
| `site` | 21 | Commissioning: EMS type, backup type, CT channels, tariff, grid profile |
| `mcu` | 18 | SPI transport faults, register boundary modes, firmware flash |
| `api` | 16 | HTTP-layer faults: latency, error rates, per-route injection |
| `can` | 16 | CAN transport, dual PCS, g4 register boundary modes |
| `net` | 15 | Wi-Fi, Ethernet, cellular, RSSI, captive portals |
| `sim` | 14 | Seed, clock rate, timezone, locale, boot delay, string edge cases |
| `fault` | 13 | Fault injection, sweeps, random storms |
| `mi` | 9 | Micro-inverter scan and monitoring |
| `ble` | 8 | Pairing, handshake delays, error sweeps |
| `cloud` | 8 | Cloud link state and error codes |
| `fw` | 7 | Firmware update sessions and chunk failures |
| `can.flag` | 5 | PCS bitmask fault flags |
| `db` | 5 | Virtual `edge_storage.db` contents |

### Actions

A handful of controls are **verbs**, not settings — `mcu.reboot`, `can.reboot`,
`can.flag.clear_all`. They hold no value; writing them fires them. In a `PATCH`, actions run
*after* the value writes land, so an action that reacts to state in the same batch sees the new
state.

---

## 7. Scenarios

```bash
npx tsx src/cli.ts scenario list
npx tsx src/cli.ts scenario show grid_outage
npx tsx src/cli.ts scenario load grid_outage
npx tsx src/cli.ts serve --scenario grid_outage    # load at boot
```

### Anatomy

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
  - at: 5m10s
    inject: { code: e002, device: ems, level: A }
expect:
  - at: 6m
    that: telemetry.Grid_Status
    equals: 1
  - at: 40m
    that: plant.battery.soc_pct
    lessThan: 15
```

- `extends` — inherit another scenario's controls, then override. One level of composition,
  because deeper hierarchies stop being readable.
- `clock` — pin the start instant and the time multiplier. Pinning the start is what makes a
  seasonal or time-of-day scenario reproducible in February and in August alike.
- `controls` — applied immediately at load.
- `timeline` — `at` accepts `5m`, `5m10s`, `6h`. Runs on **virtual** time, so at `rate: 60` a
  40-minute scenario finishes in 40 seconds.
- `inject` / `clear` — faults, by code, device, and level.
- `expect` — assertions checked as the timeline runs, with `equals`, `lessThan`, `greaterThan`.
  This is what makes a scenario a *test* rather than a demo.

### The 157 scenarios

Grouped by what they exercise:

| Tag | # | Scenarios |
|---|---:|---|
| **base** | 8 | `base_minimal`, `base_residential`, `base_solar`, `base_large_solar`, `base_multi_battery`, `base_no_ct`, `base_backup_primary`, `base_backup_standalone` |
| **happy** | 8 | `normal_day`, `normal_night`, `self_consumption`, `export_to_grid`, `commissioning_full_happy`, `fw_update_happy`, `mi_scan_happy`, `ble_pairing_happy` |
| **network** | 17 | `network_offline`, `network_flapping`, `network_packet_loss`, `network_high_latency`, `wifi_weak_signal`, `wifi_wrong_password`, `wifi_ssid_not_found`, `wifi_scan_empty`, `wifi_scan_slow`, `captive_portal`, `ethernet_no_link`, `cellular_fallback`, `cellular_activation_fail`, `dns_failure`, `tls_cert_expired`, `cloud_unreachable_local_ok`, `device_offline_threshold` |
| **api** | 15 | `api_500_all`, `api_401_expired_token`, `api_auth_always_reject`, `api_intermittent_5pct`, `api_slow_degraded`, `api_timeout_hang`, `api_rate_limited`, `api_malformed_json`, `api_truncated_response`, `ws_drop_midsession`, `ws_upgrade_rejected`, `ws_out_of_order`, `ws_duplicate_tid`, `sse_drop_no_reconnect`, `sse_never_first_event` |
| **can** | 10 | `can_bus_off`, `can_arbitration_storm`, `can_pcs2_silent`, `can_pcs_heartbeat_stuck`, `can_flag_sweep_fault`, `can_flag_sweep_all`, `can_flag_raw_bytes`, `can_boundary_sweep`, `can_registers_frozen`, `can_write_reject` |
| **standards** | 7 | `ieee1547_cat1_fast_trip`, `ieee1547_cat3_ride_through`, `ieee1547_enter_service_delay`, `ieee1547_enter_service_restart`, `ieee1547_volt_var_absorb`, `ieee1547_volt_watt_curtail`, `ieee1547_2003_narrow_band` |
| **commissioning** | 10 | `commissioning_already_done`, `commissioning_interrupted`, `commissioning_device_not_ready`, `commissioning_invalid_config`, `commissioning_serial_mismatch`, `commissioning_no_devices_found`, `commissioning_partial_devices`, `commissioning_ct_missing`, `commissioning_ct_reversed`, `installer_reset` |
| **firmware** | 10 | `fw_update_crc_fail`, `fw_update_erase_fail`, `fw_update_chunk_rejected`, `fw_update_stall_47`, `fw_update_timeout`, `fw_update_power_loss`, `fw_update_rollback`, `fw_update_incompatible`, `fw_update_slow_network`, `fw_update_mcu_unresponsive` |
| **grid** | 9 | `grid_outage`, `grid_outage_with_low_battery`, `grid_flapping`, `grid_voltage_sag`, `grid_voltage_swell`, `grid_frequency_excursion`, `grid_frequency_50hz`, `anti_islanding_trip`, `black_start` |
| **battery** | 8 | `battery_soc_zero`, `battery_soc_full`, `battery_cold_derate`, `battery_thermal_derate`, `battery_degraded_soh`, `battery_bms_fault`, `battery_force_charge`, `battery_force_discharge` |
| **time** | 7 | `clock_skew`, `clock_unset`, `tz_dst_spring_forward`, `tz_dst_fall_back`, `tz_midnight_rollover`, `tz_asia_seoul`, `tz_utc_offset_half_hour` |
| **fault** | 7 | `fault_storm`, `fault_flapping`, `fault_never_clears`, `fault_critical_shutdown`, `fault_unknown_code`, `fault_sweep_ems`, `fault_sweep_all_devices` |
| **ble** | 6 | `ble_not_found`, `ble_handshake_timeout`, `ble_disconnect_midflow`, `ble_mtu_small`, `ble_permission_denied`, `ble_error_code_sweep` |
| **mcu** | 6 | `mcu_offline`, `mcu_reboot_loop`, `mcu_version_mismatch`, `register_boundary_sweep`, `register_stale_values`, `register_write_rejected` |
| **spi** | 6 | `spi_crc_error`, `spi_nack_storm`, `spi_timeout`, `spi_desync`, `spi_short_frame`, `spi_4k_mode` |
| **energy** | 5 | `flow_all_zero`, `flow_pv_equals_load`, `flow_deadband_boundary`, `flow_generator`, `battery_full_export` |
| **mi** | 5 | `mi_scan_partial`, `mi_offline_subset`, `mi_duplicate_serial`, `mi_large_array`, `mi_reconnection_short` |
| **solar** | 3 | `overcast_day`, `cloudy_intermittent`, `pv_curtailment` |
| **scale** | 3 | `scale_many_faults`, `scale_long_strings`, `scale_unicode_strings` |
| **soak** | 2 | `soak_24h`, `soak_7day` |
| **locale** | 2 | `locale_ko_kr`, `locale_de_de` |
| **load** | 2 | `load_spike`, `load_ev_charging` |
| **chaos** | 1 | `chaos_monkey` |

The eight `base_*` scenarios are the composition roots. Most scenarios `extends` one of them and
override only what differs, which is why 157 files stay readable.

---

## 8. Determinism

**The same seed and the same scenario produce byte-identical output.** Every time, on every
machine.

```bash
npx tsx src/cli.ts serve --seed 20260101 --scenario chaos_monkey
```

This is not a nice-to-have. It is the property that turns "it fails sometimes" into a bug report
someone can act on, and it is what makes the rig usable in CI.

It works because every source of variability is a seeded RNG stream, and the streams are
*derived* rather than shared: `rng.derive('mcu')`, `rng.derive('can')`, and so on. Adding a new
random draw in the CAN layer therefore cannot shift the sequence the MCU layer sees.

Virtual time is the other half. The clock is not the wall clock; it advances by explicit ticks:

```bash
npx tsx src/cli.ts clock pause
npx tsx src/cli.ts clock step 15m      # jump forward, deterministically
npx tsx src/cli.ts clock resume 1000
```

Verify determinism yourself:

```bash
./test/determinism.sh
# PASS: identical telemetry sequences across both runs
#       25 samples compared
```

### Snapshots

Capture the entire rig — every control, the plant, faults, clock, register overrides — and
restore it exactly:

```bash
npx tsx src/cli.ts snapshot save bug-4471.json
npx tsx src/cli.ts snapshot restore bug-4471.json
```

Attach the file to the ticket. The next person reproduces in one command.

---

## 9. Fault injection

Faults are modelled the way the device reports them, which means **every fault must be clearable
as well as settable**. `FaultNoti.flag` is `0` for cleared and `1` for raised; a simulator that
can only raise faults tests half the code.

```bash
npx tsx src/cli.ts fault list                       # the codebook
npx tsx src/cli.ts fault inject e001 --device ems --level F
npx tsx src/cli.ts fault clear e001
```

Faults are organised as **device family × severity**: EMS, INVERTER, BATTERY, GRID, MI, HUB,
each at Fault / Warning / Alarm. Alongside them sits the catalogue of 44 cloud error codes,
including the `460X` device-state family (`4600` offline, `4601` maintenance, `4602` firmware
unsupported, `4603` invalid config, `4604` not ready).

Bulk levers:

- `fault.sweep.device` / `fault.sweep.level` — walk every code for one device family, one severity,
  or both, holding each for `fault.sweep.hold_s` and then clearing it.
- `fault.random.max_active` — a bounded random fault storm.
- `fault.suppress_clear` — raise faults and never clear them, to catch UI that leaks rows.

---

## 10. The two buses: SPI and CAN

### SPI (MPU ↔ MCU)

The frame is fixed at **71 bytes** — sync `0xAA`, command, 2-byte address, payload length,
64-byte payload, CRC16 — because FUS-124 pinned the MPU receive length. A 4K bulk mode
(4,107 bytes) exists for firmware transfer.

The rig implements the framing for real, so it is inspectable rather than merely decoded:

```bash
curl -s localhost:9114/spi/status | python3 -m json.tool
curl -s localhost:9114/spi/read/0x80
```

```json
{"mode":"standard","expectedLength":71,"actualLength":71,
 "hex":"aa88...","decoded":{"cmd":"CMD_ACK","crcValid":true,...}}
```

CRC16-CCITT, polynomial `0x1021`, init `0x0000`, little-endian. Check vector: `"123456789"` →
`0x31C3`.

**Boundary values, nearly free.** Every metric in the factory map declares a data type and often
explicit bounds. So `mcu.registers.boundary_mode` can drive **all 4,411 metrics** to their minima,
maxima, or one step beyond — without anyone hand-authoring a single test vector:

```bash
npx tsx src/cli.ts ctl set mcu.registers.boundary_mode over
```

Transport faults: `mcu.spi.crc_error_rate_pct`, `nack_rate_pct`, `timeout_rate_pct`,
`desync`, `short_frame`, `latency_ms`.

### CAN (MCU ↔ PCS / BDC / BMS)

The `qcells_ess_g4` map: **833 registers, 2,985 metrics**, reaching two PCS units (`P01_*`,
`P02_*`), their inverter and converter CPUs, and the JF2 battery stack.

```bash
curl -s localhost:9114/can/status
curl -s "localhost:9114/can/registers?q=monitoring"
curl -s localhost:9114/can/read/P01_1s_Monitoring_Data_04
```

Two things make CAN worth modelling separately from SPI:

**1. Dual PCS.** Nearly every register is duplicated per unit. Site power is *split* across the
configured units, so a two-unit site does not report double its output — and "unit 2 is dark" is a
real, commonly-mishandled condition:

```bash
npx tsx src/cli.ts ctl set can.pcs_count 2
npx tsx src/cli.ts ctl set can.pcs2.silent true
# -> reads of P02_* now fail with tx_timeout, not a plausible-looking zero
```

**2. Faults are bitmask bytes, not codes.** `P01_PCS_Error_Status_01` carries 48 bytes: six
domains (Grid, PCS, BDC, MCU × Fault, Warning, Alarm) of eight flag bytes each. Every bit is one
condition — **768 addressable faults per PCS unit**.

The rig offers both views, because both are useful:

```bash
# Named bits, Gen1-style code: {G|P|D|M}{PCS:2}{bit:3}{F|W|A}
curl -X PATCH localhost:9114/control -H 'Content-Type: application/json' \
  -d '{"can.flag.set":["G01005F","D01011W"]}'

# Raw hex bytes: the escape hatch for conditions nobody has named yet
curl -X PATCH localhost:9114/control -H 'Content-Type: application/json' \
  -d '{"can.flag.byte.1.PCS.Warning.3":170}'

# Bulk: every Fault-severity bit across every domain
curl -X PATCH localhost:9114/control -H 'Content-Type: application/json' \
  -d '{"can.flag.sweep":"Fault"}'

curl -s localhost:9114/can/faults
```

Named bits and raw bytes are the *same underlying state*, so a bit set by name reads back in the
register, and a raw byte write shows up as named codes.

**Heartbeats actually move.** `FS_PCS_Inverter_heartbeat` increments once per second, because
that is how the MPU detects a hung PCS CPU. `can.pcs1.heartbeat_stuck` pins it — registers keep
returning plausible values, and only the frozen heartbeat says the data is dead. This is the
failure mode that silent-failure bugs are made of.

Transport faults: `can.bus_off` (permanent, not transient — a real controller that accumulates
enough TX errors takes itself off the bus and *stays* there), `arbitration_loss_rate_pct`,
`tx_timeout_rate_pct`, `form_error_rate_pct`.

---

## 11. Grid support and IEEE 1547

Gen1's fault panel could assert that an inverter had tripped. It could not tell you *why*, *when*,
or *whether it should have*. Trip behaviour is not vendor preference — it is the interconnection
standard that determines whether a system may connect to the utility at all. So the rig models it
directly, and the `grid.*` controls are named after the standard rather than after our code.

### What is modelled

| Behaviour | Standard | Controls |
|---|---|---|
| Ride-through and trip | IEEE 1547-2018 abnormal operating categories I / II / III | `grid.ieee1547.abnormal_category`, `grid.ieee1547.revision` |
| Enter service | SunSpec model **703** | `grid.enter_service.{v_hi_pu,v_lo_pu,hz_hi,hz_lo,delay_s,ramp_s}` |
| Volt-VAR | SunSpec model **705** | `grid.volt_var.*` |
| Volt-Watt | SunSpec model **706** | `grid.volt_watt.*` |
| Nameplate ratings | SunSpec model **702** | `grid.nameplate.*` |

The device already speaks IEEE 2030.5 on the wire — `P01_1s_Monitoring_Data_01` carries
`IEEE2030_5_InverterStatus` and `alarm_Status_IEEE2030_5_CSIP` — so these are the terms the rest of
the system, and the utility, already use.

### The state machine

```
connected ──excursion beyond ride-through──> tripped ──conditions back in window──> waiting
    ^                                                                                  │
    └──────────── ramping ◀── delay elapses without a new excursion ───────────────────┘
```

Two properties are worth knowing because they are the ones that surprise people:

- **The enter-service window is deliberately narrower than the trip band.** If they were equal, a
  system sitting exactly at the boundary would connect and trip forever. Recovery must be
  comfortably inside the band, not merely not-outside it.
- **Any excursion during `waiting` restarts the delay.** The delay must be *sustained*, not
  cumulative. A grid that dips every four minutes never reconnects — which is the correct
  behaviour, and a genuinely useful thing to show an app developer.

Watch it happen:

```bash
npx tsx src/cli.ts scenario load ieee1547_enter_service_delay
curl -s localhost:9114/state | jq .plant.gridSupport
```

```
t=0     phase=connected  limit=1.00  pv=0
t=70s   phase=tripped    limit=0.00  grid=900   reason=voltage 0.750 pu outside 0.88-1.1 pu
t=3m    phase=waiting    limit=0.00  grid=900
t=9m    phase=ramping    limit=0.23  pv=918.8
t=17m   phase=connected  limit=1.00  pv=4019.4
```

### Ride-through needs a finer tick

Ride-through thresholds are **sub-second** (Category I tolerates 0.16 s; Category III, 1.0 s). At
the default 1,000 ms tick a single tick accumulates a full second of excursion and *every* category
trips identically. Scenarios that exercise ride-through therefore set:

```yaml
controls:
  sim.tick_ms: 50
```

With that in place the categories separate cleanly — the same 500 ms dip trips Category I and is
ridden through by Category III.

### Calibration caveat

IEEE 1547-2018 Tables 12 and 13 are paywalled and could not be verified. Rather than invent
per-category voltage bands that would look authoritative and be wrong, **all three categories
currently share the same continuous-operation band (0.88–1.1 pu)** and are differentiated only on
ride-through *duration*, which is the axis we can defend.

For test authors this means: asserting on the exact voltage at which a category trips is **not yet
meaningful**; asserting on how long an excursion is tolerated **is**. To calibrate against the real
standard, see NREL/TP-5D00-68575 and widen the bands in
`src/plant/grid-support.ts::VOLTAGE_BAND`.

---

## 12. How this compares to Gen1

Gen1 had a simulation interface: a **Node-RED dashboard** on the EMS board, reachable at
`http://<board>:1880/ui`. It is worth understanding, because this rig deliberately inherits some
of its ideas and deliberately rejects others.

Gen1's flow definition contains **1,328 nodes** across 9 tabs. The two that matter:

- **Fault Manager** — 192 `ui_switch` widgets, one per fault, organised by domain and severity,
  with codes shaped `H00101F` / `G01203W` / `P02603A`.
- **Error** — 200 widgets of raw hex entry, one text input + button per flag register.

**What was right, and is kept:**

| Gen1 idea | How it appears here |
|---|---|
| Faults organised by **domain × severity** | `can.flag` codes: `{G\|P\|D\|M}{PCS}{bit}{F\|W\|A}` |
| **Raw bitmask entry** as an escape hatch | `can.flag.byte.{pcs}.{domain}.{severity}.{index}` |
| Per-CT-channel measurement | `site.ct.*` per channel |
| Grid profile as a first-class selection | The whole `grid.*` group — IEEE 1547 category, revision, trip and enter-service bands (§11) |
| Reboot and update controls | `mcu.reboot`, `can.reboot`, `fw.*` |

**What was structurally wrong, and is not:**

| | Gen1 Node-RED HMI | This rig |
|---|---|---|
| **Drives** | `can0` and a Modbus RTU slave on `/dev/ttyAMA0` — **real hardware** | Nothing. Pure software. |
| **Needs** | A Pi, a wired CAN bus, live PCS/BDC/BMS/HUB hardware | Node 22 |
| **Is it SIL?** | **No — it is hardware-in-the-loop.** | Yes |
| **App-facing?** | No. It drives CAN, not `:9112`. **A mobile app cannot use it at all.** | Yes — that is the entire design |
| **Composition** | None. Every control is a manual click. | 157 composable scenarios |
| **Determinism** | None | Seeded, byte-identical replay |
| **Standards** | Trip behaviour is whatever the hardware does; nothing is named after a standard | IEEE 1547 categories, SunSpec 702/703/705/706 parameter names (§11) |
| **Time control** | None | Pause, step, rate-multiply virtual time |
| **Scriptable / CI** | No | Full CLI + REST; runs in CI |
| **Physics** | None — sliders set values independently; nothing conserves energy | Energy-conserving plant model; derived values are read-only |
| **Coverage** | 192 hand-authored fault switches | 768 CAN flag bits/unit + 8,106 metrics with generated boundary values |

The last row is the one to dwell on. Gen1's sliders were independent: you could set PV to 6 kW,
load to 1 kW, and grid import to 5 kW simultaneously, describing a site that generates energy from
nothing. Every number downstream of that is fiction. Here, grid power is *derived* and read-only —
the model cannot be put into a state that physics forbids.

---

## 13. Testing and CI

```bash
npm run typecheck      # tsc --noEmit
npm test               # 17 unit tests
./test/smoke.sh        # 33 end-to-end checks (needs a running rig)
./test/determinism.sh  # byte-identical replay under a fixed seed
```

Full pass, from a clean tree:

```bash
npm ci && npm run typecheck && npm test
npm run serve & sleep 10
./test/smoke.sh && ./test/determinism.sh
```

### The corpus test is load-bearing

One unit test loads **all 157 scenarios** and fails the build on:

- a control id that does not exist,
- a value outside the control's declared range,
- a `name:` that disagrees with the filename,
- an `extends:` pointing at a missing base,
- a fault code absent from the codebook.

This is what keeps 157 YAML files from rotting silently as controls are renamed. Any new control
or scenario has to satisfy it.

### Using the rig in your own CI

```bash
npx tsx src/cli.ts serve --seed 42 --scenario api_intermittent_5pct --paused &
# ... run your app's integration suite against https://localhost:9112 ...
npx tsx src/cli.ts clock step 1h     # deterministically fast-forward
```

---

## 14. Troubleshooting

**`curl` fails with a certificate error.**
Expected — the rig serves self-signed TLS, exactly like the board. Use `curl -k`, or run with
`--no-tls` for HTTP.

**A phone or the Web HMI cannot reach the rig.**
The rig binds `0.0.0.0` by default. Check your Mac's firewall, and use the LAN IP rather than
`localhost`.

**A newly added scenario is not listed.**
The scenario directory is read at startup. Restart the rig.

**`Error: unknown control: <id>`.**
Every control must be declared in `src/core/control-defs.ts`. `npx tsx src/cli.ts ctl list` shows
what exists. Pattern controls use placeholders — `mcu.register.{addr}.{metric}` — so the literal
string with braces is not itself settable.

**`<id> is derived and cannot be set directly`.**
You tried to set a read-only control, most likely `plant.grid_w` or `plant.battery_w`. Set the
causes instead: PV, load, battery power target, grid status.

**Ports already in use.**
`lsof -ti:9112` and `lsof -ti:9114`, then `kill <pid>`. Or use `--port` / `--control-port`.

**Register map not found.**
The rig locates `factory_register_map.json` by relative path from the working directory. Pass
`--register-map <path>` to override.

**The clock is not advancing.**
Check whether you started with `--paused` or called `clock pause`. `npx tsx src/cli.ts clock`
shows the current time, rate, tick interval and tick count.

**`/state` shows stale values after loading a scenario or resetting.**
`/state` returns the snapshot computed by the **last tick**, not a live recomputation. With the
clock paused, loading a scenario changes the controls but nothing recomputes the snapshot, so you
see the previous scenario's numbers. Step the clock once (`clock step 1s`) before asserting. This
bites hardest in scripted tests, where nothing is advancing time on your behalf.

**A ride-through scenario trips when it should not.**
The default 1,000 ms tick cannot resolve sub-second thresholds — one tick registers a full second
of excursion, so every abnormal operating category trips alike. Set `sim.tick_ms: 50` in the
scenario. See §11.

**Every scenario after a fine-tick scenario runs slowly.**
This was a real bug and is fixed: `controls.reset()` restored values without emitting change
events, so the clock kept the previous scenario's 50 ms interval while the control reported
1,000 ms. If you add a control whose effect is wired to a `change:` listener, this is the failure
mode to watch for — the value looks right and the behaviour is wrong.

---

## 15. Repository map

```
sil-rig/
  src/
    cli.ts                serve | ctl | clock | scenario | fault | snapshot | state
    server.ts             wiring, tick loop, TLS, CORS
    core/
      rng.ts              seeded, derivable RNG streams
      clock.ts            virtual time: pause, step, rate, skew
      controls.ts         the registry: validation, patch, snapshot, actions
      control-defs.ts     all 197 control definitions
      context.ts          RigContext — what every layer shares
    plant/
      profiles.ts         PV and load day profiles
      plant.ts            energy-conserving physical model
      grid-support.ts     IEEE 1547 ride-through, trip, enter service, volt-VAR/Watt
    faults/
      codebook.ts         fault + cloud error-code catalogue
      manager.ts          raise, clear, sweep, storm
    ipc/
      broker.ts           MQTT-shaped request/response/notification bus
      apps.ts             7 virtual MPU services, 23 operations
    mcu/
      crc.ts              CRC16-CCITT
      frame.ts            71-byte and 4107-byte SPI framing
      registers.ts        factory_register_map.json loader
      virtual-mcu.ts      register model + plant binding + boundary engine
    can/
      flags.ts            bitmask fault model, Gen1-style codes
      virtual-can.ts      g4 register model, dual PCS, transport faults
      wiring.ts           makes can.flag.* controls act on the bus
    api/
      envelope.ts         EmbResponse<T>
      middleware.ts       auth, fault injection, latency
      device-api.ts       the 11 real endpoints
    ws/bridge.ts          WsMqttBridge-compatible /ws
    control/api.ts        the control plane + /spi/* + /can/*
    scenario/engine.ts    YAML loader, extends, timeline, expectations
  scenarios/              157 YAML files
  test/
    unit.test.ts          17 tests, including the scenario corpus test
    smoke.sh              37 end-to-end checks
    determinism.sh        replay comparison
  README.md               rig-level reference
```

---

## 16. Planning documents

The design record, in the order worth reading:

| Document | What it covers |
|---|---|
| **[`AC-GEN2-MPU-MCU-SIL-PLAN.md`](AC-GEN2-MPU-MCU-SIL-PLAN.md)** | The primary plan. §11.1 is the `:9112` implementation contract, §13 explains the cloud simulator, §14 the Gen1 HMI verdict, §17 implementation status. |
| **[`AC-GEN2-SIL-CONTROL-PLANE.md`](AC-GEN2-SIL-CONTROL-PLANE.md)** | Control taxonomy and the full scenario catalogue. |
| **[`AC-GEN2-FAILURE-CASE-CATALOG.md`](AC-GEN2-FAILURE-CASE-CATALOG.md)** | The failure cases worth simulating, and where the evidence for each came from. |
| **[`AC-GEN2-DIGITAL-TWIN-PLAN.md`](AC-GEN2-DIGITAL-TWIN-PLAN.md)** | The site digital-twin web app: visual breakdowns, drill-downs, energy-flow animation. |
| **[`AC-GEN2-LOCAL-DEV-SETUP.md`](AC-GEN2-LOCAL-DEV-SETUP.md)** | Full-platform Yocto build reference, for when you *do* need the whole edge platform. |
| **[`sil-rig/README.md`](sil-rig/README.md)** | Rig-level reference detail. |

### A note on the cloud simulator

`qcells-cloud-server/simulator/` is a different tool for a different job. It is a Spring Boot
fleet-scale load generator — 20 replicas, 1,000 sites, each opening its own MQTT connection to
Azure IoT Core while impersonating a device.

It is **not useful for app development**: it speaks MQTT to the cloud only, so there is no
`:9112`, no BLE, and no SPI; it requires Azure, a live API, and a database; it is
non-deterministic; it has no physics; and its cadence is 1 min / 15 min / 1 h. What is worth
borrowing from it is its fault buckets, its `Telemetry1minRanges`, and its device state machine
with a 5-minute heartbeat.

---

## Status

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **17 / 17** |
| `./test/smoke.sh` | **37 / 37** |
| `./test/determinism.sh` | **PASS** — identical telemetry across runs |
| All 157 scenarios loaded at runtime | **0 failures** |
