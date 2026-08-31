# AC Gen2 SIL — Control Plane & Scenario Catalog

> Every simulated behaviour is a **named, typed, addressable control**. Scenarios are nothing more than bulk assignments of controls over time. There is no behaviour reachable by a scenario that is not reachable by a single control write, and vice versa.
> - [`sil-rig/`](./sil-rig/README.md) — **the implementation**: 155 controls, 140 scenarios, serving `:9112`

**Companion docs:** [SIL Plan](./AC-GEN2-MPU-MCU-SIL-PLAN.md) · [Failure Catalog](./AC-GEN2-FAILURE-CASE-CATALOG.md) · [Digital Twin](./AC-GEN2-DIGITAL-TWIN-PLAN.md) · [Local Dev Setup](./AC-GEN2-LOCAL-DEV-SETUP.md)

---

## 1. Design rules

1. **One registry, one truth.** Every lever lives in a single control registry with an id, type, range, default, and current value. Nothing is simulated by a hidden `if` buried in a handler.
2. **Everything addressable.** `GET /control` lists all levers with metadata. `PUT /control/{id}` sets one. The UI, the CLI, the YAML loader, and tests all go through this same path.
3. **Scenario = bulk control write + timeline.** A scenario is a declarative document that sets controls at t=0 and optionally schedules further writes. It cannot do anything an operator couldn't do by hand.
4. **Determinism is mandatory.** Virtual clock + seeded RNG. Same scenario + same seed ⇒ byte-identical telemetry sequence. This is the property both existing simulators lack.
5. **Faults are levers, not exceptions.** Injecting `e014` is a control write, not a special code path.
6. **Physics before presentation.** The plant model conserves energy; the API renders it. You cannot set `grid_W` directly to something the power balance forbids — you set the *causes* and read the *effect*.
7. **Parity rule.** Any HMI/GUI panel must be a thin client of the control API. If the CLI can't do it, the panel doesn't get to either.

### Control descriptor

```ts
{ id: "plant.pv_w",
  group: "plant",
  type: "number",              // number | integer | boolean | enum | string | duration | json
  unit: "W",
  min: 0, max: 38400,
  default: 0,
  volatile: true,              // derived/overwritten by the plant each tick?
  description: "PV array AC output power",
  appliesTo: ["telemetry.pv_200_W", "register:0x8224"] }
```

---

## 2. Control taxonomy

### 2.1 `sim.*` — engine

| Control | Type | Range / values | Default | Purpose |
|---|---|---|---|---|
| `sim.seed` | integer | any | `1` | RNG seed. Same seed ⇒ same run. |
| `sim.clock.mode` | enum | `virtual`, `wall` | `virtual` | Virtual time or real time |
| `sim.clock.rate` | number | `0`–`3600` | `1` | `0` = paused; `60` = 1 min/s |
| `sim.clock.now` | string | ISO-8601 | scenario | Set absolute virtual time |
| `sim.clock.step` | duration | — | — | Action: advance N and settle |
| `sim.tick_ms` | integer | `10`–`60000` | `1000` | Plant integration step |
| `sim.timezone` | string | IANA | `America/Los_Angeles` | ⚠️ factory default is `Asia/Seoul` — test both |
| `sim.autoplay` | boolean | — | `true` | Start ticking on boot |
| `sim.strict` | boolean | — | `false` | Fail fast on contract violations |

### 2.2 `site.*` — topology & identity

| Control | Type | Values | Default |
|---|---|---|---|
| `site.ems_type` | enum | `ACCB_GEN2`, `ESS_GEN4`, `STANDALONE`, `BACKUP_PRIMARY`, `BACKUP_STANDALONE` | `ACCB_GEN2` |
| `site.serial_number` | string | — | `EMS2SIM00000001` |
| `site.name` / `site.timezone_id` / `site.address.*` | string | — | — |
| `site.inverter_count` | integer | `0`–`4` | `1` |
| `site.battery_count` | integer | `0`–`4` | `1` |
| `site.expansion_battery_count` | integer | `0`–`8` | `0` |
| `site.mi_count` | integer | `0`–`200` | `12` |
| `site.hub_count` | integer | `0`–`4` | `1` |
| `site.accombiner_present` | boolean | — | `true` |
| `site.generator_present` | boolean | — | `false` |
| `site.backup_type` | enum | `NONE`, `PARTIAL`, `WHOLE_HOME` | `PARTIAL` |
| `site.ct.consumption_pair1` | enum | `NotInstalled`, `Installed`, `Reversed` | `Installed` |
| `site.panel_system_size_w` | number | `0`–`100000` | `8000` |
| `site.commissioning_status` | enum | `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, `FAILED` | `NOT_STARTED` |

### 2.3 `plant.*` — physics inputs

Inputs you set; outputs the model derives.

| Control | Type | Unit | Range | Default | Kind |
|---|---|---|---|---|---|
| `plant.pv_w` | number | W | `0`–`38400` | `0` | input |
| `plant.extpv_w` | number | W | `0`–`38400` | `0` | input |
| `plant.pv_profile` | enum | — | `flat`, `clear_day`, `cloudy`, `intermittent`, `sunrise_sunset`, `night`, `custom` | `flat` | input |
| `plant.load_w` | number | W | `0`–`38400` | `1000` | input |
| `plant.load_profile` | enum | — | `flat`, `residential_day`, `evening_peak`, `ev_charging`, `spiky`, `custom` | `flat` | input |
| `plant.battery.soc_pct` | number | % | `0`–`100` | `50` | state |
| `plant.battery.soh_pct` | number | % | `0`–`100` | `100` | state |
| `plant.battery.capacity_wh` | number | Wh | `0`–`100000` | `13500` | input |
| `plant.battery.max_charge_w` | number | W | `0`–`10000` | `5000` | input |
| `plant.battery.max_discharge_w` | number | W | `0`–`10000` | `5000` | input |
| `plant.battery.temperature_c` | number | °C | `-40`–`85` | `25` | input |
| `plant.battery.derate_pct` | number | % | `0`–`100` | `0` | input |
| `plant.grid.status` | enum | — | `0` on-grid, `1` off-grid | `0` | input |
| `plant.grid.voltage_v` | number | V | `0`–`300` | `240` | input |
| `plant.grid.frequency_hz` | number | Hz | `45`–`65` | `60` | input |
| `plant.grid.export_limit_w` | number | W | `0`–`38400` | `38400` | input |
| `plant.energy_control` | enum | — | `0` STANDBY, `1` AUTO, `3` FORCE_CHARGE, `4` FORCE_DISCHARGE | `1` | input |
| `plant.grid_w` / `plant.battery_w` | number | W | — | — | **derived — read-only** |

> **Derived outputs obey the contract:** `grid > 0` import, `grid < 0` export, `battery > 0` discharging, `battery < 0` charging. Deadband `0.1 kW` applied **before** rounding. Missing ⇒ `0.0`, never "unknown".

### 2.4 `net.*` — connectivity

| Control | Type | Values | Default |
|---|---|---|---|
| `net.type` | enum | `0` none, `1` wifi, `2` ethernet, `3` cellular | `1` |
| `net.wifi.state` | enum | `disconnected`, `connecting`, `connected`, `failed` | `connected` |
| `net.wifi.ssid` / `net.wifi.rssi_dbm` | string / integer | — / `-100`–`0` | `SIM-AP` / `-55` |
| `net.wifi.scan_count` | integer | `0`–`64` | `8` |
| `net.wifi.scan_delay_ms` | integer | `0`–`120000` | `1200` |
| `net.wifi.connect_fail_reason` | enum | `none`, `bad_password`, `not_found`, `timeout`, `dhcp_fail` | `none` |
| `net.ethernet.state` | enum | `up`, `down`, `no_link` | `down` |
| `net.cellular.state` | enum | `inactive`, `activating`, `active`, `failed` | `inactive` |
| `net.cloud.reachable` | boolean | — | `true` |
| `net.cloud.latency_ms` | integer | `0`–`60000` | `40` |
| `net.cloud.packet_loss_pct` | number | `0`–`100` | `0` |
| `net.dns.fail` | boolean | — | `false` |
| `net.captive_portal` | boolean | — | `false` |
| `net.tls.cert_expired` | boolean | — | `false` |

### 2.5 `api.*` — transport-level fault injection

The controls that make apps prove their error handling.

| Control | Type | Values | Default |
|---|---|---|---|
| `api.latency_ms` | integer | `0`–`600000` | `0` |
| `api.jitter_ms` | integer | `0`–`60000` | `0` |
| `api.fail_rate_pct` | number | `0`–`100` | `0` |
| `api.fail_status` | integer | `400`–`599` | `500` |
| `api.route.{route}.latency_ms` | integer | — | inherit |
| `api.route.{route}.status` | integer | `0` = normal | `0` |
| `api.route.{route}.body` | json | override payload | — |
| `api.route.{route}.hang` | boolean | never respond | `false` |
| `api.route.{route}.truncate` | boolean | cut response mid-body | `false` |
| `api.auth.token_ttl_s` | integer | `1`–`86400` | `3600` |
| `api.auth.reject` | boolean | always 401 | `false` |
| `api.malformed_json` | boolean | emit invalid JSON | `false` |
| `api.ws.drop_after_s` | integer | `0` = never | `0` |
| `api.ws.reject_upgrade` | boolean | — | `false` |
| `api.ws.duplicate_responses` | boolean | same `tid` twice | `false` |
| `api.ws.out_of_order` | boolean | shuffle replies | `false` |

`{route}` is a stable slug: `auth_token`, `publish`, `notifications`, `telemetry`, `update_register`, `update_chunk`, `update_sessions`, `update_finalize`, `factory_reset`, `serial_number`, `version`.

### 2.6 `mcu.*` — MPU↔MCU / SPI

| Control | Type | Values | Default |
|---|---|---|---|
| `mcu.online` | boolean | — | `true` |
| `mcu.fw_version` | string | — | `1.0.0` |
| `mcu.spi.latency_ms` | integer | `0`–`10000` | `1` |
| `mcu.spi.crc_error_rate_pct` | number | `0`–`100` | `0` |
| `mcu.spi.nack_rate_pct` | number | `0`–`100` | `0` |
| `mcu.spi.timeout_rate_pct` | number | `0`–`100` | `0` |
| `mcu.spi.desync` | boolean | corrupt sync byte `0xAA` | `false` |
| `mcu.spi.short_frame` | boolean | violate the 71-byte fix | `false` |
| `mcu.reboot` | action | — | — |
| `mcu.register.{addr}.{metric}` | number | per register map | map default |
| `mcu.register.{addr}.mode` | enum | `normal`, `min`, `max`, `below_min`, `above_max`, `stale`, `nan` | `normal` |
| `mcu.erase_delay_ms` | integer | `0`–`60000` | `270` |
| `mcu.fw.crc_pass` | boolean | — | `true` |
| `mcu.fw.erase_ok` | boolean | — | `true` |

> `mcu.register.*.mode` is the **boundary-value engine**: `min`/`max`/`below_min`/`above_max` are generated automatically from `minValue`/`maxValue` in `factory_register_map.json` for all 4,411 metrics. No hand-authoring.

### 2.7 `fw.*` — firmware update

| Control | Type | Values | Default |
|---|---|---|---|
| `fw.target` | enum | `mpu`, `mcu`, `pcs`, `bms`, `hub`, `mi` | `mcu` |
| `fw.transfer_rate_kbps` | integer | `1`–`100000` | `2048` |
| `fw.progress_stall_at_pct` | integer | `0` = none | `0` |
| `fw.fail_at_pct` | integer | `0` = none | `0` |
| `fw.fail_mode` | enum | `none`, `crc`, `timeout`, `power_loss`, `rollback`, `verify_fail`, `incompatible` | `none` |
| `fw.chunk_reject_index` | integer | `-1` = none | `-1` |
| `fw.post_update_reboot_s` | integer | `0`–`600` | `30` |

### 2.8 `mi.*` — microinverters

| Control | Type | Values | Default |
|---|---|---|---|
| `mi.scan.duration_s` | integer | `0`–`900` | `60` |
| `mi.scan.discover_count` | integer | `0`–`200` | `12` |
| `mi.scan.discovery_rate_per_s` | number | `0`–`50` | `0.5` |
| `mi.scan.fail` | boolean | — | `false` |
| `mi.scan.partial_pct` | integer | `0`–`100` | `100` |
| `mi.duplicate_serials` | boolean | — | `false` |
| `mi.offline_count` | integer | `0`–`200` | `0` |
| `mi.fault_count` | integer | `0`–`200` | `0` |

### 2.9 `ble.*` — Bluetooth

| Control | Type | Values | Default |
|---|---|---|---|
| `ble.enabled` | boolean | — | `true` |
| `ble.mtu` | integer | `23`–`517` | `517` |
| `ble.pair.fail_reason` | enum | `none`, `timeout`, `rejected`, `auth_fail`, `bonding_lost` | `none` |
| `ble.disconnect_after_s` | integer | `0` = never | `0` |
| `ble.error_code` | enum | `0x00`, `0xFF` DATA_FORMAT … `0xF4` UNKNOWN | `0x00` |
| `ble.ack_timeout` | boolean | exceed `ACK_TIMEOUT_MS` 20000 | `false` |

### 2.10 `fault.*` — device faults

| Control | Type | Values | Default |
|---|---|---|---|
| `fault.active` | json | `[{code, device, level, flag}]` | `[]` |
| `fault.inject` | action | `{code, device, level}` | — |
| `fault.clear` | action | `{code}` or `all` | — |
| `fault.random.enabled` | boolean | — | `false` |
| `fault.random.rate_per_hour` | number | `0`–`100` | `0` |
| `fault.random.buckets` | enum[] | `ACES`, `COMMON`, `MICROINVERTER` | `[]` |
| `fault.cache_ttl_s` | integer | — | `3600` |

Codes come from the existing codebook — `ems` `e001`–`e035`, plus `inverter`, `bdc`, `hub`, `grid`, `solar`, `ac-combiner`, `micro-inverter`, `battery-qhome-smart`, `cloud`. Levels `W`/`A`/`F`. **Every fault supports set *and* clear** (`flag` 1/0).

### 2.11 `cloud.*` — northbound

| Control | Type | Values | Default |
|---|---|---|---|
| `cloud.enabled` | boolean | — | `false` |
| `cloud.telemetry_1m` / `cloud.telemetry_15m` | boolean | — | `true` / `false` |
| `cloud.error_code` | integer | 44 codes: `4001`…`4600` offline, `4601` maintenance, `4602` fw unsupported, `4603` invalid config, `4604` not ready, `5201`… | `0` |
| `cloud.sse.enabled` | boolean | — | `true` |
| `cloud.sse.drop_after_s` | integer | `0` = never | `0` |
| `cloud.sse.first_event_delay_s` | integer | `0`–`600` | `2` |
| `cloud.heartbeat_stall` | boolean | trip the 5-min offline threshold | `false` |

### 2.12 `db.*` — virtual `edge_storage.db`

`db.device_info.{key}` and `db.system_setting.{key}` are directly writable for all well-known keys: `product_serial_number`, `battery_pack_sn`, `mpu_version`, `pcs_version`, `MCU_FW_VERSION`, `jf2_bms_version`, `bpu_version`, `mi_info`, `System_Commissioning_Status`, `fault_history`, `Grid_V_Detection_Value`, `Nameplate_Ratings_WMaxRtg`, `validation_status_info`, `ja12_enabled_date`.

---

## 3. Control API

```
GET    /control                     list all controls + metadata + current values
GET    /control/{id}                read one
PUT    /control/{id}      {value}   write one
PATCH  /control           {map}     bulk write (atomic)
POST   /control/reset               back to defaults
GET    /control/diff                only values differing from default  ← paste into a scenario
POST   /clock/step        {ms}      advance virtual time
POST   /clock/pause | /clock/resume
GET    /scenarios                   list available
POST   /scenarios/{name}/load       apply a scenario
GET    /scenario/state              current scenario + timeline position
POST   /fault/inject | /fault/clear
GET    /snapshot                    full state (controls + plant + faults)
POST   /snapshot/restore            restore a snapshot  ← attach to bug reports
```

CLI mirrors it exactly:

```bash
sil serve --port 9112 --scenario grid_outage --seed 42
sil ctl get plant.battery.soc_pct
sil ctl set plant.grid.status 1
sil ctl patch -f overrides.yaml
sil clock step 1h
sil fault inject e014 --device ems --level F
sil scenario load fw_update_stall
sil snapshot save bug-1234.json
```

> **The `GET /control/diff` → scenario workflow is the point.** A developer fiddles with controls until they reproduce a bug, dumps the diff, and attaches a scenario file to the ticket. Reproduction becomes a file, not a paragraph.

---

## 4. Scenario format

```yaml
name: grid_outage_with_low_battery
extends: base_residential           # inheritance; deltas only
description: Grid fails at dusk with battery at 15% SoC.
tags: [grid, backup, failure]
seed: 42

clock:
  start: "2026-06-21T18:00:00-07:00"
  rate: 60                          # 1 min per real second
  timezone: America/Los_Angeles

controls:                           # bulk assignment at t=0
  site.ems_type: BACKUP_PRIMARY
  plant.pv_profile: sunrise_sunset
  plant.load_profile: evening_peak
  plant.battery.soc_pct: 15

timeline:                           # scheduled control writes
  - at: 5m
    set: { plant.grid.status: 1 }
    note: utility outage begins
  - at: 5m10s
    inject: { code: e002, device: ems, level: A }
  - at: 45m
    set: { plant.grid.status: 0 }
    clear: [e002]

expect:                             # optional assertions
  - at: 6m
    that: telemetry.Grid_Status
    equals: 1
  - at: 40m
    that: plant.battery.soc_pct
    lessThan: 15
```

Semantics: `extends` deep-merges parent first. `controls` applies atomically at t=0. `timeline` entries fire at virtual-clock offsets. `expect` failures are reported but don't stop the run unless `sim.strict`.

---

## 5. Scenario catalog

Grouped by pattern. Each is a bulk control assignment; all are reproducible from `seed`.

### 5.1 Baselines (composition roots)

| Scenario | Description |
|---|---|
| `base_minimal` | All defaults. Nothing installed beyond a bare EMS. |
| `base_solar` | AC Combiner + 12 MI, no battery. `ACCB_GEN2`. |
| `base_residential` | Solar + 1 battery + hub. The common case. |
| `base_backup_primary` | Backup-capable, whole-home. |
| `base_backup_standalone` | Backup, standalone EMS type. |
| `base_multi_battery` | 4 batteries + 4 expansion units. |
| `base_large_solar` | 200 MI, 4 inverters — scale limits. |
| `base_no_ct` | `consumption_pair1: NotInstalled` — degraded load data. |

### 5.2 Happy paths

| Scenario | Description |
|---|---|
| `commissioning_full_happy` | End-to-end: site create → MI scan → network → FW → validation. **The smoke test.** |
| `commissioning_solar_only` | No battery variant. |
| `commissioning_backup` | Backup-configured variant. |
| `normal_day` | 24 h clear-sky cycle, 60× rate. Every flow case appears naturally. |
| `normal_night` | Night: PV 0, battery discharging to load. |
| `self_consumption` | AUTO mode, PV covers load, surplus charges battery. |
| `export_to_grid` | PV exceeds load and battery is full ⇒ export. |
| `battery_charging_from_pv` | Classic mid-morning case. |
| `battery_full_export` | `SoC == 100` forces `FullCharged` even with negative battery power. |
| `fw_update_happy` | Clean MCU firmware update, 0→100 %. |
| `mi_scan_happy` | Discovers exactly `mi_count`. |
| `wifi_connect_happy` | Scan → select → connect → verified. |

### 5.3 Energy-flow matrix coverage

| Scenario | Description |
|---|---|
| `flow_case_sweep` | Steps through **all 26 documented flow cases** in order. Regression net for the shared matrix. |
| `flow_pv_equals_load` | `pv == load` exactly — the only path that reaches `Case312`. **Branch-order canary.** |
| `flow_deadband_boundary` | Powers at exactly ±0.1 kW — proves deadband runs *before* rounding. |
| `flow_sign_conventions` | Every sign permutation of grid/battery. |
| `flow_missing_fields` | Telemetry with fields absent ⇒ must read `0.0`, not "unknown". |
| `flow_all_zero` | Idle system; no animation should render. |
| `flow_generator` | Generator present — the enum exists in all three clients and is never rendered. |

### 5.4 Solar & load patterns

| Scenario | Description |
|---|---|
| `pv_sunrise_sunset` | Full diurnal ramp. |
| `pv_cloudy_intermittent` | Rapid PV swings — UI thrash, animation stability. |
| `pv_curtailment` | Export limit forces inverter curtailment. |
| `pv_zero_output_daytime` | Sunny but no production ⇒ fault condition. |
| `load_evening_peak` | Residential peak-shaving shape. |
| `load_ev_charging` | Sustained 7 kW step load. |
| `load_spike` | Instantaneous load beyond inverter rating. |
| `tou_arbitrage` | Time-of-use: charge off-peak, discharge on-peak. |
| `peak_shaving` | Battery caps grid import at a threshold. |

### 5.5 Grid events

| Scenario | Description |
|---|---|
| `grid_outage` | Clean transition to island. |
| `grid_outage_with_low_battery` | Outage at 15 % SoC ⇒ eventual shutdown. |
| `grid_outage_extended` | Multi-hour island, SoC to 0. |
| `grid_reconnect` | Return + resync. |
| `grid_flapping` | Repeated on/off — debounce and state-machine stress. |
| `grid_voltage_sag` / `grid_voltage_swell` | 180 V / 280 V excursions. |
| `grid_frequency_excursion` | 58.5 / 61.5 Hz. |
| `grid_frequency_50hz` | 50 Hz region config against a 60 Hz site. |
| `anti_islanding_trip` | Protective trip on island detection. |
| `black_start` | Cold start with no grid present. |

### 5.6 Battery & storage

| Scenario | Description |
|---|---|
| `battery_soc_zero` / `battery_soc_full` | Hard boundaries. |
| `battery_soc_sweep` | 0→100→0 continuous. |
| `battery_degraded_soh` | SoH 70 % — capacity math. |
| `battery_thermal_derate` | 55 °C ⇒ reduced power. |
| `battery_cold_derate` | −10 °C ⇒ charge inhibited. |
| `battery_bms_fault` | BMS fault code + comms loss. |
| `battery_cell_imbalance` | Warning-level fault. |
| `battery_missing` | Configured but absent. |
| `battery_added_midrun` | Hot-add an expansion unit. |
| `battery_force_charge` / `battery_force_discharge` | TPO-only modes `3` / `4`. |

### 5.7 Network & connectivity

| Scenario | Description |
|---|---|
| `network_offline` | No cloud reachability. |
| `network_flapping` | Connect/disconnect every 30 s. |
| `network_high_latency` | 5 s latency on every call. |
| `network_packet_loss` | 30 % loss. |
| `wifi_wrong_password` | `bad_password` on connect. |
| `wifi_ssid_not_found` | Target SSID absent from scan. |
| `wifi_scan_empty` | Zero APs. |
| `wifi_scan_slow` | Scan exceeds `SCAN_SETTLE_DELAY_MS` 10000. |
| `wifi_weak_signal` | RSSI −88 dBm. |
| `ethernet_no_link` | Cable in, no link. |
| `cellular_activation_fail` | Activation rejected. |
| `cellular_fallback` | Wi-Fi drops ⇒ cellular takes over. |
| `dns_failure` | Resolution fails, TCP fine. |
| `captive_portal` | Hotel-style interception. |
| `tls_cert_expired` | Expired board certificate. |
| `cloud_unreachable_local_ok` | Local API works, cloud doesn't. **Very common in the field.** |
| `device_offline_threshold` | Heartbeat stall past the 5-minute mark. |

### 5.8 API & transport failures

| Scenario | Description |
|---|---|
| `api_500_all` | Every endpoint 500s. |
| `api_401_expired_token` | Token expires mid-flow ⇒ refresh path. |
| `api_auth_always_reject` | Permanent 401. |
| `api_timeout_hang` | Connection accepted, no response — the worst case. |
| `api_slow_degraded` | 3 s on every call. |
| `api_malformed_json` | Invalid JSON body. |
| `api_truncated_response` | Body cut mid-stream. |
| `api_intermittent_5pct` | 5 % random failures. |
| `api_rate_limited` | 429 with `Retry-After`. |
| `ws_upgrade_rejected` | WebSocket refused ⇒ polling fallback. |
| `ws_drop_midsession` | Socket dies after 30 s. |
| `ws_duplicate_tid` | Same `tid` answered twice. |
| `ws_out_of_order` | Responses shuffled. |
| `ws_no_response` | Request accepted, never answered. |
| `sse_never_first_event` | Stream opens, no data — shimmer-forever check. |
| `sse_drop_no_reconnect` | Verifies documented no-auto-reconnect behaviour. |

### 5.9 Firmware update

| Scenario | Description |
|---|---|
| `fw_update_happy` | Baseline. |
| `fw_update_stall_47` | Progress freezes at 47 %. **The support-ticket classic.** |
| `fw_update_crc_fail` | CRC check fails after transfer. |
| `fw_update_erase_fail` | Erase never reports done. |
| `fw_update_power_loss` | Interrupted at 60 %. |
| `fw_update_chunk_rejected` | Chunk 12 rejected. |
| `fw_update_out_of_order_chunks` | Non-monotonic indices. |
| `fw_update_timeout` | Exceeds `RESPONSE_TIMEOUT_MS` 600000. |
| `fw_update_rollback` | Fails verification ⇒ A/B rollback. |
| `fw_update_incompatible` | Version unsupported (cloud `4602`). |
| `fw_update_slow_network` | 64 kbps transfer. |
| `fw_update_mcu_unresponsive` | MCU stops answering mid-update. |
| `fw_update_concurrent` | Second update attempted during the first. |

### 5.10 Commissioning failures

| Scenario | Description |
|---|---|
| `commissioning_wrong_serial` | Serial mismatch. |
| `commissioning_mi_not_found` | Scan finds 0. |
| `commissioning_mi_partial` | Finds 8 of 12. |
| `commissioning_mi_duplicate` | Duplicate serials. |
| `commissioning_ct_reversed` | CT backwards ⇒ inverted sign. **Very common, hard to spot.** |
| `commissioning_ct_missing` | No CT installed. |
| `commissioning_grid_code_mismatch` | Wrong region profile. |
| `commissioning_validation_fail` | Final validation rejects. |
| `commissioning_interrupted` | App killed mid-flow ⇒ resume. |
| `commissioning_duplicate_site` | Site already exists (cloud `4090`). |
| `commissioning_no_internet` | Offline during commissioning. |
| `commissioning_timeout_equipment` | Exhausts all 6 fetch attempts. |

### 5.11 MPU↔MCU / SPI protocol

| Scenario | Description |
|---|---|
| `spi_crc_errors` | 10 % CRC corruption. |
| `spi_nack_storm` | Continuous NACKs. |
| `spi_desync` | Sync byte corrupted. |
| `spi_short_frame` | Violates the fixed 71-byte Rx. |
| `spi_timeout` | MCU stops responding. |
| `mcu_offline` | MCU entirely absent. |
| `mcu_reboot_midflow` | Reboots during operation. |
| `mcu_version_mismatch` | MCU FW older than MPU expects. |
| `register_boundary_sweep` | Every metric to min/max/below/above. **Auto-generated from the register map.** |
| `register_stale_data` | Values stop updating; timestamps freeze. |
| `register_nan` | Non-numeric where a number is required. |

### 5.12 Device faults

| Scenario | Description |
|---|---|
| `fault_sweep_ems` | All `e001`–`e035`, set then clear. |
| `fault_rogowski_coil` | `e001`. |
| `fault_pcs_disconnect` | `e002`. |
| `fault_internet_lost` | `e004`. |
| `fault_crash_reboot` | Unexpected reboot. |
| `fault_storage_full` | eMMC write limit. |
| `fault_overtemperature` | Thermal. |
| `fault_cascade` | Multiple simultaneous, mixed levels. |
| `fault_flapping` | Set/clear every 10 s — notification-storm handling. |
| `fault_all_levels` | W, A, F together. |
| `fault_persist_across_reboot` | Survives restart. |
| `fault_random_chaos` | Seeded random injection, 5/hour. |

### 5.13 BLE

| Scenario | Description |
|---|---|
| `ble_pair_happy` / `ble_pair_timeout` / `ble_pair_rejected` | Pairing paths. |
| `ble_bonding_lost` | Bond dropped mid-session. |
| `ble_disconnect_midflow` | Drop after 15 s. |
| `ble_small_mtu` | MTU 23 ⇒ heavy fragmentation. |
| `ble_ack_timeout` | Exceeds 20 s. |
| `ble_error_sweep` | All 10 wire error codes. |
| `ble_out_of_range` | Signal degrades to loss. |

### 5.14 Time, locale, edge cases

| Scenario | Description |
|---|---|
| `tz_asia_seoul` | Factory default vs. a US site. **Known bug source.** |
| `tz_dst_spring_forward` / `tz_dst_fall_back` | 2 a.m. transitions. |
| `tz_midnight_rollover` | Daily-total reset. |
| `tz_year_rollover` | Dec 31 → Jan 1. |
| `leap_day` | Feb 29. |
| `clock_skew` | Device clock 10 min off. |
| `clock_jump_backward` | NTP correction backwards. |
| `energy_counter_rollover` | Wh counter wraps at uint32. |
| `locale_non_us` | Non-US formatting against hardcoded `Locale.US`. |

### 5.15 Scale & soak

| Scenario | Description |
|---|---|
| `scale_200_mi` | Maximum microinverters. |
| `scale_4_batteries` | Max battery config. |
| `soak_24h` | 24 virtual hours at 3600×. |
| `soak_7d` | One virtual week. |
| `chaos_monkey` | Seeded random control mutation. |
| `rapid_state_changes` | Control writes every 100 ms. |

---

## 6. Coverage traceability

Every scenario declares `tags`, and every failure-catalog entry maps to at least one scenario. `sil coverage` reports which catalogued failure modes have no scenario — that report is the backlog.

| Catalog source | Covered by |
|---|---|
| 44 cloud error codes | §5.7, §5.8, `cloud.error_code` sweep |
| EMS `e001`–`e035` | §5.12 `fault_sweep_ems` |
| BLE 13/14 client errors + 10 wire codes | §5.13 |
| Timing constants | §5.7, §5.8 |
| SPI failure modes | §5.11 |
| ~40 energy-flow defects | §5.3 |
| 4,411 MCU metric boundaries | §5.11 `register_boundary_sweep` (generated) |
