# AC Gen2 — Failure-Case Catalog for SIL

> **Answer to "do you have enough data to build a comprehensive failure catalog?" — Yes, decisively.**
> Enough exists *today*, across code and Confluence, to author several hundred non-happy-path cases without inventing anything. The work is **consolidation, not discovery.**
> - [`AC-GEN2-SIL-CONTROL-PLANE.md`](./AC-GEN2-SIL-CONTROL-PLANE.md) — control taxonomy + scenario catalog
> - [`sil-rig/`](./sil-rig/README.md) — **the implementation**: 155 controls, 140 scenarios, serving `:9112`

---

## 1. Source inventory

| # | Source | Location | Yield |
|---|---|---|---|
| 1 | **Cloud response error codes** | `nextgen-schemas/async-api/response-error-codes/response-error-codes-api.json` | **44 codes**, 8 categories |
| 2 | **Device error codebook (CSV)** | `qcells-cloud-server/service-alarm-repository/src/main/resources/error_code/code/*.csv` | 10 device families × codes × level `W`/`A`/`F` |
| 3 | **Error display text (JSON)** | `.../error_code/display/{installer,homeowner,administrator}/en/*.json` | `description` + `howToFix` per code, **per persona** |
| 4 | **Simulator fault buckets** | `qcells-cloud-server/simulator/.../telemetry_range_spec/ErrorType.java` | `ACES`, `COMMON`, `MICROINVERTER` concrete code lists |
| 5 | **Telemetry ranges** | `.../telemetry_range_spec/Telemetry1minRanges.java` | numeric bounds for boundary-value injection |
| 6 | **Register map min/max** | `nextgen-schemas/factory_json/ac_system_gen2/factory_register_map.json` | **8,106 metrics**, many with `minValue`/`maxValue`/`defaultValue` |
| 7 | **Energy-flow non-conformance list** | Confluence `11481874436` §11 | **~40 explicitly-declared defects** |
| 8 | **Energy-flow case matrix** | same, §7 | **26 cases** + branch-order trap |
| 9 | **BLE error enums** | Android `data/.../error/BleError.kt`; iOS `Projects/Domain/Sources/BLE/Error/BLEError.swift` | 13 + 14 cases |
| 10 | **BLE protocol error codes** | Android `library/common-util/.../ble/BleGattProfile.kt` | 10 wire-level codes `0xF4`–`0xFF` |
| 11 | **Timeout/retry constants** | `BleTiming.kt`, dashboard spec §2.2 | concrete deadlines to test around |
| 12 | **Device lifecycle states** | `qcells-cloud-server` simulator + manager | desired/actual state machines, offline rules |
| 13 | **Existing scenario YAMLs** | `qcells-android-installer/data/src/main/assets/scenarios/` | **19 scenarios**, several already failure cases |
| 14 | **MPU-MCU SPI protocol** | Confluence `10768187454` | CRC/NACK/timeout/erase/reboot failure modes |
| 15 | **FUSA safety requirements** | Confluence space `FUSA` | `FUS-115/120/121/122/123/124/155/156`, `FUS-285/286/287`, `FUS-171/172/187` |

---

## 2. Cloud response error codes (all 44)

`async-api/response-error-codes/response-error-codes-api.json`

**Auth & authorization** `4010` missing/invalid auth · `4011` token expired · `4012` invalid credentials · `4030` forbidden · `4031` device not registered

**Request validation** `4000` bad payload · `4001` missing required field · `4002` invalid type/format · `4003` schema mismatch · `4220` semantic error

**Not found** `4040` resource · `4041` device · `4042` site · `4043` asset · `4100` permanently deleted

**Rate limit / throttling** `4290` too many requests · `4291` telemetry rate limit · `4292` connection limit · `4293` burst limit · `5030` throttled

**Server & processing** `5000` internal · `5001` data processing failure · `5020` bad gateway · `5031` service unavailable · `5040` upstream timeout

**Device state** `4600` offline · `4601` maintenance mode · `4602` firmware unsupported · `4603` invalid configuration · `4604` not ready

**Data conflict** `4090` already exists · `4091` duplicate registration · `4092` version conflict · `4093` state conflict · `4094` concurrent update

**Network & transport** `5200` connection failure · `5201` delivery failed · `5202` protocol error · `5203` message timeout · `5204` unexpectedly closed

---

## 3. Device error codebook

**Families** (`error_code/code/*.csv`): `ems`, `inverter`, `bdc`, `hub`, `grid`, `solar`, `ac-combiner`, `micro-inverter`, `battery-qhome-smart`, `cloud`

**CSV shape:** `model, major, minor, level` — e.g. `default,E001,01,F`

**Levels:** `F` Fault · `A` Alarm · `W` Warning
**Types:** `MAJOR` / `MINOR` (minor lookup strips a trailing letter)
**Personas:** `administrator`, `installer`, `homeowner` — each with its own `description` + `howToFix`
**Languages:** `en` only (`ErrorDisplayLanguage.EN`)

### EMS codes (`ems.json`) — a ready-made scenario list

| Code | Meaning |
|---|---|
| `e001` | Rogowski coil connection / sensing error |
| `e002` | PCS disconnection |
| `e003` | Gateway connection error |
| `e004` / `e017` | Internet disconnection |
| `e006` | Device info update error |
| `e007` | Configuration update error |
| `e008` | EMS firmware update error |
| `e009` | Application crash & system reboot |
| `e010` | Boot failure |
| `e011` | CPU usage high |
| `e012` | Memory usage high |
| `e013` | User storage full |
| `e014` | High temperature |
| `e015` / `e030` | CAN driver error |
| `e018` | PCS firmware update error |
| `e019` | BMS firmware update error |
| `e020` | Malware detected |
| `e026` | GEM communication error |
| `e027` | GEM firmware update error |
| `e028` | HUB firmware update error |
| `e029` | WiFi driver error |
| `e031` | PCS Master1/Master2/Slave/HUB core error |
| `e032` | eMMC write-limit warning |
| `e033` | Secondary disconnection warning |
| `e034` | USB fault |
| `e035` | LTE modem driver error |

Other families follow the same pattern — `inverter.csv` (`P001` F, `P005` W, `P012/04` F, `P015` F, `P017/02` W, `P019` F), `cloud.csv` (`C001/01` F, `C001/02` W, `C001/03` W, `C128/01` F), etc.

### Simulator fault buckets (`ErrorType.java`)
- **`ACES`**: `B00701A`, `B01002W`, `B01003F`, `B01301A`, `B01302W`, `B00103F`, `B00203F`, `B00301F`, `B00401F`, `B02001F`, `B02701F`, `B02901F`, `B03001F`
- **`COMMON`**: EMS/BDC/HUB/GRID/INVERTER/AC-COMBINER — `E03103F`, `E03201A`, `D00201F`, `H00301F`, `G00101A`, `P01204F`, `A00101W`, …
- **`MICROINVERTER`**: `M01501W`, `M00802W`, `M00301W`, `M00402W`, `M00302W`

### Alarm message contracts
- **`FaultNoti`** — `siteId`, `data.{assetId, serialNumber, flag, code, timestamp}`; `flag`: `0` = cleared, `1` = fault → **every fault needs a set *and* clear case**.
- **`CommonAlarm`** — `origin` ∈ `["", SITE, DEVICE, VENDOR_API, OTHER]`, `severity` ∈ `["", CRITICAL, MAJOR, MINOR]`.

---

## 4. Connectivity & transport failures

### BLE — Android `BleError.kt`
`BluetoothDisabled` · `PermissionMissing` · `ServiceNotFound` · `CharacteristicNotFound` · `ProtocolError` · `WriteFailed` · `WriteInProgress` · `DeviceDisconnected` · `NotConnected` · `ConnectionTimeout` · `AuthenticationFailed` · `AuthenticationTimeout` · `DecryptionFailed`

### BLE — iOS `BLEError.swift`
`bluetoothPoweredOff` · `bluetoothUnsupported` · `bluetoothUnauthorized` · `deviceNotFound` · `connectionFailed` · `disconnected` · `serviceNotFound` · `characteristicNotFound` · `readNotPermitted` · `readFailed` · `writeNotPermitted` · `writeFailed` · `writeInProgress` · `unknown`

### BLE wire protocol (`BleGattProfile.kt`)
`0xFF` DATA_FORMAT · `0xFE` TRANSACTION_TIMEOUT · `0xFD` PACKET_CRC_FAILED · `0xFC` TRANSFER_LEVEL_CRC_FAILED · `0xFB` SEQUENCE · `0xFA` BUSY · `0xF9` PACKET_SIZE · `0xF7` HANDSHAKE_TIMEOUT · `0xF5` TRANSFER_NOT_ACTIVE · `0xF4` UNKNOWN

BLE service UUIDs: `2bfc77a1/b1/c1-96d7-4b23-b51d-8ecd01237f67/6d`; auth `c2e4f600-…`, `PAIR_WRITE` `c2e4f601-…`, `PAIR_NOTIFY` `c2e4f602-…`. `REQUESTED_MTU = 517`.

### Timing constants worth testing at the boundary
| Constant | Value |
|---|---|
| `ACK_TIMEOUT_MS` | 20 000 |
| `INTER_PACKET_COOLDOWN_MS` | 150 |
| `HANDSHAKE_TIMEOUT_MS` | 10 000 |
| `ENSURE_READY_TIMEOUT_MS` | 30 000 |
| `RESPONSE_TIMEOUT_MS` | 600 000 |
| `SCAN_SETTLE_DELAY_MS` | 10 000 |
| `RETRY_INTERVAL_MS` | 3 000 |
| `SESSION_ABORT_SETTLE_MS` | 1 500 |
| `MAX_EQUIPMENT_FETCH_ATTEMPTS` | 6 |
| `EQUIPMENT_FETCH_RETRY_DELAY_MILLIS` | 5 000 |
| SSE `connectTimeout` / `readTimeout` | 30 s / **0 (infinite)** |
| Device offline threshold | **5 min** without heartbeat |

---

## 5. MPU↔MCU SPI failure modes

From the protocol spec + register map:

- CRC16-CCITT mismatch on header, on payload, on 4K data block, on whole image
- `0x91` NACK; NACK storm; **MPU ignores ACKs during chunk streaming** — packet loss is silent by design
- Sync byte ≠ `0xAA`; wrong payload length; truncated frame; oversized frame (fixed 71 B per FUS-124)
- Flash erase never completes (`byte[6] != 0x01`) / exceeds 270 ms
- CRC fail reported (`byte[7] = 0x02`)
- MCU never reboots after final `0x8011` / reboots into old version
- `0xFFFF` unrecoverable error event mid-update
- Image exceeds `max_size` (1 MB); `device_select` mismatch (≠ `0x11`)
- SPI bus: clock glitch, MISO stuck high/low, wrong mode, speed mismatch
- **Comms loss** — FUSA `FUS-285` detect, `FUS-286` warning release, `FUS-287` warning action
- Register-level: value below `minValue` / above `maxValue`, stuck register, `scaleFactor` misapplied, endianness inversion, string field not NUL-terminated

---

## 6. Energy-flow / dashboard defects (Confluence `11481874436` §11)

**~40 declared defects**, already written as pass/fail assertions. Highlights:

**Sign & unit** — minus sign displayed · `-0.0 kW` · `"0.0 kW"` instead of `"0 kW"` · comma decimal on de-DE/fr-FR · rounding before deadband · flicker around 0.1 kW · charging shown as discharging · export shown as import · mixed units into `getEnergyFlowCase` · un-dead-banded values collapsing to `Case0`

**Node & configuration** — battery card on a SolarConfig site · grid/load labels when `hasConsumptionCT == false` · arrows animating with no CT · Force Charge/Discharge offered on solar-only · wrong work-mode label per config · on-grid SVG while off-grid · external PV rendered separately or dropped · generator/EV node appearing

**Session lifecycle** — SSE continuing after `ON_PAUSE` · `STOP` without `sessionId` · stream started before `deviceId` resolves · auto-reconnect to a dead session (ADR-2 forbids) · finite `readTimeout` · wrong host (`serverUrl()` vs `flavor.baseUrl()`) · missing `X-API-Version: Mobile-V100` / `Origin` · session leak on navigation · hardcoded `deviceId`

**Stale & flicker** — previous site's data after switching · terminal emission with non-null `data` · frozen numbers without Disconnected overlay · numbers updating behind the overlay · `0 kW` instead of shimmer before first event · Disconnected flashing on resume

### Degraded-state matrix (§9) — expected UI per failure
| Failure | Expected |
|---|---|
| No internet | Full-screen `NoInternetConnection()` + Retry |
| SSE `FAILURE`/`DISCONNECTED` | 70 % overlay, cloud-off icon, "Disconnected", Retry; carousel → 20 dp spacer; work-mode chip hidden |
| Equipment API fails 6× | `handleApiError` dialog; monitoring never starts |
| Equipment returns empty | Early return, **no dialog**, no monitoring |
| Alerts API fails | Silent; `alertList = []`; Error Code card shows `0` |
| Homeowner/weather API fails | Silent; placeholder retained |
| Token expired | Refresh + **exactly one** 401 retry |
| SSE idle past keep-alive | **No** auto-reconnect |

---

## 7. Combinatorial generators (where the volume comes from)

| Generator | Cases |
|---|---|
| **Energy-flow matrix** — 26 cases × {on-grid, off-grid} × {CT, no-CT} × {SolarConfig, TPOConfig} | ~200 |
| **Register boundary values** — 5 per metric (below-min, min, mid, max, above-max) over metrics with declared bounds | 1 000s |
| **Fault set/clear** — every code × `flag ∈ {0,1}` × 3 personas | 100s |
| **IPC payload DSL** — `ipc_tester` already auto-generates union (`0\|1\|2`), range (`number(-40~85)` → 5 boundary cases), and optional-field cases | 100s |
| **Commissioning step × failure** — 9 steps × {BLE drop, timeout, auth fail, EMS not ready, offline, sync conflict} | ~54 |
| **Lifecycle transitions** — `START_REQUESTED`/`STOP_REQUESTED`/`DELETE_REQUESTED` × `STARTING`/`RUNNING`/`STOPPED` + offline >5 min | ~20 |

**Priority order:** hand-author the ~40 declared defects + degraded-state matrix first (these are *specified* behaviors with known expected outcomes), then switch on the generators.

---

## 8. Recommended format — extend the Android scenario YAML

Already proven at `qcells-android-installer/data/src/main/assets/scenarios/` with `extends:` inheritance:

```yaml
name: device_offline
extends: solar_ready_to_sync
description: >
  Previously-commissioned Solar site that has lost connectivity...
seed:
  site: { siteId: "site-solar-ready", isOnline: false, ... }
cloud:
  "GET /v1/sites": { status: 200, body: { ... } }
```

**Existing 19 scenarios** — `default`, `solar_ready_to_sync`, `tpo_ready_to_sync`, `site_completed_history`, `firmware_info_persisted_tpo`, plus failure cases: `device_offline`, `equipment_verification_failed`, `expired_session_token`, `firmware_update_in_progress`, `mid_firmware_update_killed`, `permission_denied_state`, `solar_grid_fault`, `stale_cache_offline`, `tpo_backup_low_battery`, `large_site_list_pagination_stress`, `g2s_1111_system_settings_sync_failure`, `g2s_1404_local_disconnect_banner_missing`, `g2s_1406_power_control_reset_to_max`, `g2s_1407_power_control_ct_navigation_broken`

> Note the `g2s_*` names — **scenarios are already being used to pin real Jira defects.** That's exactly the workflow to scale.

### Proposed extension for SIL
```yaml
name: mcu_crc_storm
extends: tpo_ready_to_sync
description: MCU NACKs 30% of FW chunks with CRC failure during update.

clock:  { start: "2026-03-01T12:00:00Z", rate: 10x }   # deterministic virtual time
rng:    { seed: 42 }

plant:                       # NEW — drives the virtual MCU
  battery: { soc: 62, temperature_c: 24, soh: 98 }
  pv:      { profile: clear_sky_march, peak_w: 7200 }
  load:    { profile: us_residential_weekday }
  grid:    { voltage_v: 240, frequency_hz: 60, status: on_grid }

faults:                      # NEW — timeline-based injection
  - at: 00:05:00
    inject: spi.crc_error
    params: { rate: 0.3, target: "0x8012" }
  - at: 00:12:00
    inject: register.stuck
    params: { register: "0x8480", metric: "Rogowski_Coil_Current_L1" }
  - at: 00:20:00
    inject: fault_noti
    params: { code: "E001", flag: 1 }

assert:                      # NEW — machine-checkable expectations
  - at: 00:06:00
    expect: ipc.noti
    topic: "energy_link/noti/mcu_comm_status"
    matches: { degraded: true }
```

---

## 9. Immediate action

1. **Consolidate sources 1–3 and 7 into one machine-readable catalog** (`failure-cases.yaml`), keyed by stable IDs, with expected observable behavior per persona and per surface (mobile / web HMI / cloud). This is ~2 weeks and unblocks mobile devs *before* any SIL code exists.
2. **Promote the Android scenario YAML into a shared package** so iOS and the Web HMI can consume it.
3. **Wire the generators** (register bounds, energy-flow matrix, IPC payload DSL) into CI.
4. **Adopt the `g2s_*` convention** — every reproduced defect ships with a scenario file attached to the ticket.

### Gaps that still need a human
- Which fault codes are **actually reachable** on AC Gen2 hardware vs. inherited from Gen1/other product lines
- **MCU-internal** failure modes (needs the STM32 firmware source — still unlocated)
- Real-world **timing/jitter** distributions on the SPI bus (needs Saleae captures)
- CAN/ESS-G4 (`qcells_ess_g4`, 833 registers) fault semantics
