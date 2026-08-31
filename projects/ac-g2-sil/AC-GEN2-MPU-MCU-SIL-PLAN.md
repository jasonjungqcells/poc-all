# AC Gen2 — MPU/MCU Software-in-the-Loop (SIL) Simulator: Baseline & Plan

> **Document set**
> - [`AC-GEN2-LOCAL-DEV-SETUP.md`](./AC-GEN2-LOCAL-DEV-SETUP.md) — full edge-platform build environment (Yocto, `repo`, Jenkins)
> - **`AC-GEN2-MPU-MCU-SIL-PLAN.md`** ← *you are here* — MPU/MCU boundary + SIL simulator
> - [`AC-GEN2-FAILURE-CASE-CATALOG.md`](./AC-GEN2-FAILURE-CASE-CATALOG.md) — non-happy-path catalog for app/mobile devs
> - [`AC-GEN2-DIGITAL-TWIN-PLAN.md`](./AC-GEN2-DIGITAL-TWIN-PLAN.md) — site digital-twin web app
>
> **This document narrows scope to the MPU/MCU boundary** and lays out what's needed to build a SIL rig that gives app developers a fully controlled, deterministic environment.
>
> **Revision note:** §§10–15 were substantially revised after a survey of the local repos (`qcells-cloud-server`, `qcells-cloud-server-nextgen-schemas`, `qcells-resi-server`, `qcells-hems-frontend-vue`, `qcells-ios-installer`, `qcells-android-installer`). Several §§1–9 assumptions were corrected there — read §§10–15 as authoritative where they conflict.
> - [`AC-GEN2-SIL-CONTROL-PLANE.md`](./AC-GEN2-SIL-CONTROL-PLANE.md) — control taxonomy + scenario catalog
> - [`sil-rig/`](./sil-rig/README.md) — **the implementation**: 155 controls, 140 scenarios, serving `:9112`

---

## 1. The two layers you care about

```
                    ┌──────────────────────────────────────────────┐
   Azure IoT Hub    │  Cloud (IoT Hub / DPS / Blob / ADU)          │
   Mobile / Web     └───────────────────▲──────────────────────────┘
                                        │ MQTT + JSON, file upload
   ══════════════════════════════════════╪═══════════════════════════  ← NORTH seam
                    ┌───────────────────┴──────────────────────────┐
                    │  MPU  —  i.MX ARM64, Yocto kirkstone Linux   │
                    │  ┌────────────────────────────────────────┐  │
                    │  │ AC Gen2 apps (energy_link, system_log, │  │
                    │  │ web_interface, ac_gen2_api, …)         │  │
                    │  ├────────────────────────────────────────┤  │
                    │  │ UniEP — Unified Edge Platform          │  │
                    │  │ IPC bus: SERVICE_* / NOTI_* (JSON)     │  │  ← IPC seam
                    │  ├────────────────────────────────────────┤  │
                    │  │ Device/SPI driver + mcu_updater        │  │
                    │  └────────────────┬───────────────────────┘  │
                    └───────────────────┼──────────────────────────┘
                                        │ SPI  /dev/spidev2.0
   ══════════════════════════════════════╪═══════════════════════════  ← SOUTH seam
                    ┌───────────────────▼──────────────────────────┐
                    │  MCU  —  STM32 (ST-Link/JTAG flashable)      │
                    │  Real-time control: inverter, relays,        │
                    │  BMS/battery, meter, PV, protection          │
                    └──────────────────────────────────────────────┘
```

### MPU (Micro **Processor** Unit)
- NXP **i.MX** application processor, ARM64, running a **Yocto kirkstone** Linux built by this repo tree.
- Hosts **UniEP** (Unified Edge Platform) — the containerized, HW-agnostic app runtime that also serves the CCI product line.
- Apps talk to each other over a **JSON IPC bus** defined in `msg_ipc.hpp` / `msg_ipc_payload.hpp`.
- Owns all northbound comms: Azure IoT Hub telemetry, config/twin sync, DPS provisioning, Blob log upload, local web UI, BLE.
- **This is the layer app developers interface with.**

### MCU (Micro **Controller** Unit)
- **STM32** class real-time controller sitting directly on the power electronics.
- Connected to the MPU by **SPI**, MPU is master.
- Exposes a **register map** (READ/WRITE addressed registers) — this *is* the contract.
- Also accepts a firmware-update protocol over the same SPI link.

---

## 2. The MPU↔MCU contract (what the simulator must implement)

### 2.1 SPI physical/link layer

| Parameter | Value |
|---|---|
| Device node (MPU) | `/dev/spidev2.0` |
| Mode | SPI Mode 0 (CPOL=0, CPHA=0) |
| Clock | 10 MHz (`10000000`, configurable) |
| Bits per word | 8 |
| Duplex | Full-duplex, ≥1 ms inter-packet delay |
| Lines tapped for debug | MISO, SCLK, MOSI (board pins 22/23/24) |

### 2.2 Frame format

| Field | Size | Notes |
|---|---|---|
| Sync | 1 B | fixed `0xAA` |
| CMD code | 1 B | e.g. `0x01` write, `0x10` read; `0x81` ACK, `0x91` NACK, `0x88` cmd-ack |
| Address | 2 B LE | target register address (e.g. `0x8010` → `10 80`) |
| Payload len | 1 B | |
| Payload | 64 B (standard) / 4100 B (4K mode) | zero-padded in standard mode |
| CRC16 | 2 B LE | CRC16-CCITT, poly `0x1021`, init `0x0000`, over header+payload |

- **Standard packet = 71 bytes** (5 header + 64 payload + 2 CRC). *Requirement FUS-124 fixes MPU Rx size at 71 bytes.*
- **4K data packet = 4107 bytes** (5 + 4100 + 2); 4100 B payload = packet index (2 B LE) + data CRC (2 B LE) + 4096 B flash block.
- All multi-byte values little-endian.

### 2.3 Register map

- Canonical file: **`register_map.json`**, table **`tpo_opt_spi_reg_map`**.
- Used by both the MPU driver and the Saleae **Logic 2 High Level Analyzer** extension (`HighLevelAnalyzer.py`) for decoding captures.
- Traffic decodes as `WRITE` (MPU→MCU, e.g. `UNIX_TIME`) and `READ` (MCU→MPU, e.g. `MCU_Status`).
- **This JSON is the single most important artifact for the simulator** — the virtual MCU should be generated/driven directly from it.

### 2.4 Firmware-update command overlay

| Code | Direction | Purpose |
|---|---|---|
| `0x8000` | MPU ↔ MCU | Get MCU FW version + serial |
| `0x8010` | MPU ↔ MCU | Query update status |
| `0x8011` | MPU ↔ MCU | Start update (image size, expected CRC16, FW version) / final flash+reboot trigger |
| `0x8012` | MPU ↔ MCU | Firmware chunk data |
| `0x8013` | MPU → MCU | Finalize |
| `0xFFFF` | MCU → MPU | Unrecoverable error event |
| `0x8020` / `0x8030` | (proposed) | `GET_CONFIG` / `REBOOT_MCU` |

**Status byte semantics** (full received byte array of the `0x8010` response):
`byte[0]`=Sync `0xAA`, `byte[1]`=CMD ACK `0x88`, `byte[2]`=address type `0x10`, `byte[5]`=device select (EMS Main = `0x11`), `byte[6]`=`0x01` flash-erase complete, `byte[7]`=`0x01` CRC pass / `0x02` CRC fail.

**Update workflow:** handshake (`0x8000`) → start (`0x8011`) → erase wait 270 ms then poll → stream chunks (`0x8012`, MPU does **not** wait for ACKs — fire-and-forget at `send_interval_ms`) → MCU CRCs whole image, reports via `0x8010` → MPU sends final `0x8011` with `byte[11]=0x80` → MCU bootloader flashes + reboots → MPU polls `0x8010` for new version.

**MPU-side updater config** (`configuration.json`) already externalizes `spi.device`, `speed_hz`, `mode`, `bits_per_word`, block sizes, command codes, and timings — **useful: `spi.device` is already a config knob, not a hardcoded path.**

### 2.5 IPC layer (north of the MCU boundary)

Defined in `msg_ipc.hpp`, annotated with Doxygen tags that are machine-parsed by existing tooling:

- `SERVICE_<VERB>_<NOUN>` — request/response (e.g. `SERVICE_GET_BATTERY_STATUS`, `SERVICE_SET_SYSTEM_MODE`)
- `NOTI_<NOUN>` / `NOTI_CHANGED_<NOUN>` — notifications (e.g. `NOTI_PV_POWER`, `NOTI_CHANGED_BATTERY_SOC`)
- `APPID_<NAME>` — app registry
- Annotations: `@note Module:`, `Req_Payload:`, `Res_Payload:`, `Noti_Payload:`, `DependsOn:`, `SuccessField:`, `Sample_Payload:`, `Required:`, `SkipIpcTest`, `RebootService`
- Payload DSL supports union types (`0 | 1 | 2`), numeric ranges (`number(-40~85)`), and optional fields (`string?`)

> **Existing assets to reuse:** `ipc_tester` (auto-generates and runs test cases from these annotations, including boundary-value cases) and `ipc_validator` (offline lint). A SIL rig should plug straight into these rather than reinvent them.

---

## 3. Prior art — what the team already decided

From **"07 [AC GEN2] Simulation Mode에 대한 검토 및 정리"** (2026-02-25), five approaches were evaluated:

| Approach | Summary | Verdict |
|---|---|---|
| **HIL (pure hardware)** | Real product HW rig, all boards wired | No real battery → monitoring values are not valid |
| **HIL + Raspberry Pi** | Pi runs simulation SW emulating device data | Good monitoring data, but **cannot test update flows**; Pi needs ongoing maintenance |
| **HIL + PC** | Same, but a PC app replaces the Pi | No Pi needed; PC app needs maintenance |
| **Python script inside MPU SW** | Generates CAN data → MQTT | **One-way monitoring only**, no control loop |
| **Simulation Mode inside EMS+ MPU SW** | Dedicated Simulation Application: commissioning simulation + energy-flow simulation, responds to control | ✅ **Chosen direction** |

**Implication for you:** the org has already committed to an in-MPU simulation application. Your SIL rig should be *architecturally compatible* with that decision — i.e. the same scenario/energy model should be usable both as an in-MPU Simulation Mode and as an out-of-process virtual MCU. Don't build a competing silo.

Other existing assets:
- **Saleae Logic Pro 8 + Logic 2 HLA extension** decoding real SPI traffic against `register_map.json` → **you can capture golden traces from real hardware and replay/diff them against the virtual MCU.** This is the cheapest possible fidelity check.
- **AC Gen2 SPI Debugger** guide (soldered jumpers on pins 22/23/24).
- **MCU Monitoring Tool** (in development, separate space).

---

## 4. Where to cut the loop — three seams

Build these as **layers**, not alternatives. Each serves a different audience.

### Seam A — Virtual MCU over virtual SPI ★ core of the rig
Replace the physical MCU with a software model; MPU code runs unmodified above the SPI transport.

**Exercises:** real MPU driver code, framing, CRC, register semantics, timing, retry, FW-update state machine.
**Audience:** platform/firmware devs, integration tests, regression CI.

Transport options, in recommended order:

| Option | How | Effort | Fidelity | Source change |
|---|---|---|---|---|
| **A1 `LD_PRELOAD` shim** | Intercept `open`/`ioctl(SPI_IOC_MESSAGE)`/`close` on `/dev/spidev2.0`, forward frames over a Unix socket to the virtual MCU | Low | High (byte-exact) | **None** — works on prebuilt binaries |
| **A2 Pluggable transport** | Abstract the SPI call site behind an interface; add `unix://` / `tcp://` backends selectable via the existing `configuration.json` `spi.device` key | Low–Med | High | Small, in MPU driver |
| **A3 Kernel virtual SPI** | `spi-loopback` / custom kernel module exposing a spidev node backed by a userspace slave | High | Very high (real ioctl path) | Kernel module |
| **A4 QEMU full-system** | Emulate the i.MX board with a custom SPI slave device model | Very high | Highest (boots real image) | QEMU device model |

> **Recommendation:** ship **A1** first (zero-touch, unblocks everyone in days), then productize **A2** as the supported long-term path. A2 has the bonus that it becomes the transport for the team's already-decided in-MPU Simulation Mode.

### Seam B — Fake device layer at the IPC bus ★ best DX for app devs
A stub app that publishes `NOTI_*` and answers `SERVICE_*` per `msg_ipc.hpp`, with no SPI and no MCU model at all.

**Exercises:** app logic, web UI, cloud payloads.
**Audience:** app/UI developers — instant startup, scriptable, no protocol knowledge required.
**Build it by generating stubs from the `msg_ipc.hpp` Doxygen annotations** (the parser already exists in `ipc_tester`/`ipc_validator`).

### Seam C — Cloud/north stub
Local MQTT broker standing in for Azure IoT Hub + DPS, plus a Blob-upload sink and a fake ADU endpoint.

**Exercises:** provisioning, telemetry, twin/config distribution, OTA orchestration.
**Audience:** anyone needing offline/air-gapped or fault-injected cloud behaviour.

---

## 5. What the Virtual MCU must model

1. **Register file** — every register in `tpo_opt_spi_reg_map`, with type, scaling, access (RO/RW), and reset value. Generated from `register_map.json`, not hand-written.
2. **Protocol engine** — framing, CRC16-CCITT, ACK/NACK, address decode, standard vs 4K mode, error event `0xFFFF`.
3. **Boot/init state machine** — mirrors "EMS+ MCU-MPU Initialization sequence"; handshake, version/serial reporting, ready transitions.
4. **Plant model** (the actual "in the loop" part):
   - Battery: SOC integrator, voltage/current curves, temperature, SOH, charge/discharge limits
   - PV: irradiance profile → DC power
   - Load: household profile
   - Grid: voltage/frequency, import/export, outage/islanding
   - Inverter: mode, setpoint tracking, ramp rates, efficiency losses
   - **Closed loop:** MPU control writes must actually move the plant state
5. **Firmware-update responder** — full `0x8011`/`0x8012`/`0x8010` sequence with realistic erase timing (270 ms), CRC pass/fail, reboot, and version bump. *This is precisely what the Raspberry Pi HIL approach could not do — make it a first-class feature.*
6. **Fault injection** — CRC corruption, NACK storms, timeouts, comms loss (cf. FUSA `FUS-285/286/287` MPU loss-of-communication detect/warn/release), brownout, sensor out-of-range, stuck registers.
7. **Determinism** — virtual clock, seeded RNG, scenario files, record/replay. Two runs of the same scenario must produce identical traces.

---

## 6. Minimal source baseline (you do **not** need the whole platform)

Sync with `repo` group **`a2`**, then work with this subset:

| Repo | Why you need it |
|---|---|
| `edge_repo` | manifest / entry point |
| `edge_uniep`, `edge_uniep_common` | IPC framework, `msg_ipc.hpp`, `msg_ipc_payload.hpp` — the app-facing contract |
| `edge_ac_system_gen2_application` | AC Gen2 app logic, device layer, SPI driver, `mcu_updater` |
| `edge_ac_system_gen2_host` | host-side component |
| `edge_ac_system_gen2_web`, `edge_web_interface` | UI to drive/observe scenarios |
| `qcells-cloud-server-nextgen-schemas` | telemetry/config payload schemas (Seam C) |
| `edge_tools` | `build_apps.sh`, `tools/b/` Jenkins dispatch, `set_hostos` |
| `edge_gcm_dec` | grid/comms decoding, if in the data path |

**Not needed for SIL:** `meta-qcells-bsp-emsplus`, `meta-ublox-modules`, `meta-qcells-edge*` (Yocto layers) — unless you need a bootable image. **Skipping these avoids the 150–250 GB Yocto disk requirement entirely.**

```bash
repo init -u git@github.com:qcells-hqct/edge_repo \
          -b imx-linux-kirkstone-qcells-edge -m qcells-edge_mirror.xml
repo sync -j8
repo forall -g a2 -c 'git checkout main'
```

### ✅ Artifacts — RESOLVED (see §12)
The register map is **already on your disk** and is fully machine-readable:
`qcells-cloud-server-nextgen-schemas/factory_json/ac_system_gen2/factory_register_map.json`

Still to track down:
- **MCU firmware source** (STM32) — owner/repo unknown.
- **MCU-MPU Initialization sequence** diagram (Confluence `11062673453` has an empty body).

## 7. Why this is good news for your MacBook

The blocker in the full-platform plan was Yocto's 150–250 GB and x86_64 requirement. **SIL work sidesteps both:**

| Concern | Full platform | SIL scope |
|---|---|---|
| Disk | 150–250 GB | ~30–50 GB (source + containers) — **fits your 52 GB** |
| Architecture | x86_64 host required for Yocto | The MPU target is **ARM64**, so **arm64 containers run natively at full speed on Apple Silicon** |
| Emulation penalty | Rosetta x86 emulation | None, if you stay arm64 |
| Docker | Docker Desktop | Docker Desktop (arm64) — same |

You still need Linux (case-sensitive FS, glibc, `LD_PRELOAD`), but an **arm64 Debian/Ubuntu container is architecturally closer to the real MPU than an x86_64 VM would be.**

⚠️ Verify early: `build_apps.sh` / AppLibBuilder emits `edge_arm64_debug` — confirm whether it can target a plain arm64 Linux container (glibc/musl, sysroot deps) or only the Yocto sysroot. If only Yocto, fall back to Jenkins (`b apps`) for binaries and run *those* in the container.

---

## 8. Phased plan

### Phase 0 — Access & narrow sync *(days, blocked on IT/leads)*
1. GitHub `qcells-hqct` org access; SSH key; port-443 `~/.ssh/config`; corp VPN; Jenkins DevEdge.
2. Install Docker Desktop (arm64).
3. `repo init` + `repo sync` + `repo forall -g a2 -c 'git checkout main'` inside an **arm64 Ubuntu container** on a case-sensitive volume.
4. **Locate `register_map.json`, the MCU firmware repo, and the Logic2 HLA script.**

**Exit criteria:** full `a2` tree on disk; register map in hand.

### Phase 1 — Read the boundary, build a decoder *(1–2 weeks)*
5. Trace the SPI call site in `edge_ac_system_gen2_application` — find every `open("/dev/spidev…")` and `ioctl(SPI_IOC_MESSAGE)`.
6. Map `msg_ipc.hpp` `SERVICE_*`/`NOTI_*` that originate from MCU data — this defines what app devs actually consume.
7. Port the Logic2 HLA into a standalone **frame codec library** (encode + decode + CRC), with unit tests against captured traces.
8. Get real hardware SPI captures (or ask whoever has the Saleae rig) → **golden traces**.

**Exit criteria:** codec round-trips golden traces byte-exactly.

### Phase 2 — Virtual MCU + virtual SPI *(2–4 weeks)*
9. Build the **`LD_PRELOAD` SPI shim** (Seam A1) → Unix socket.
10. Build the **Virtual MCU** service: register file generated from `register_map.json`, protocol engine on the codec, boot/init state machine, stub plant model.
11. Bring up MPU apps in the arm64 container against the virtual MCU. First success metric: **MPU completes handshake and reads `MCU_Status`.**
12. Replay golden traces; diff virtual vs real responses.

**Exit criteria:** MPU boots, initializes, and cyclically exchanges data with the virtual MCU with no code changes to MPU binaries.

### Phase 3 — Close the loop & make it controllable *(3–5 weeks)*
13. Implement the plant model (battery/PV/load/grid/inverter) so control writes move state.
14. **Scenario engine**: declarative YAML — timeline of irradiance, load, grid events, faults, plus assertions. Virtual clock + seeded RNG for determinism.
15. Fault injection library incl. comms-loss (FUS-285/286/287) and CRC/NACK/timeout cases.
16. Implement the **FW-update responder** — the capability the Pi-based HIL lacked.
17. **Seam B**: generate IPC-level fakes from `msg_ipc.hpp` annotations so UI/app devs can skip the MCU model entirely.
18. **Seam C**: local MQTT broker + Blob sink + ADU stub.

**Exit criteria:** an app dev runs one command, gets a running system with a chosen scenario, and can script "battery at 20% SOC, grid outage at t+5min".

### Phase 4 — Productize *(ongoing)*
19. Single `docker compose up` bringing up apps + virtual MCU + cloud stub + UI.
20. Wire into `ipc_tester` for automated regression; add to Jenkins CI.
21. Publish golden-trace corpus + a "how to add a scenario" guide.
22. Converge with the official in-MPU **Simulation Mode** app so there's one energy model, two deployment shapes.

---

## 9. Design principles

- **Generate, don't hand-write.** Register model from `register_map.json`; IPC fakes from `msg_ipc.hpp` annotations. Hand-written mirrors rot the day the contract changes.
- **Byte-exact or it doesn't count.** Validate against golden traces from real hardware — this is what separates a simulator from a mock.
- **Deterministic by default.** Virtual clock, seeded RNG, versioned scenario files. Non-deterministic tests get ignored.
- **No MPU source changes for v1.** `LD_PRELOAD` means firmware and app teams aren't blocked on each other.
- **Fail loudly on contract drift.** CI should break when the register map or `msg_ipc.hpp` changes without a corresponding simulator update.
- **Don't fork the energy model.** One model, shared with the sanctioned Simulation Mode app.

---

## 10. Open questions — status after code survey

| # | Question | Status |
|---|---|---|
| 1 | Authoritative `register_map.json`? | ✅ **ANSWERED** — `qcells-cloud-server-nextgen-schemas/factory_json/ac_system_gen2/factory_register_map.json`, already local. See §12. |
| 2 | Where does MCU firmware source live? | ❌ **STILL OPEN** — not in any manifest group. |
| 3 | Cyclic or event-driven? Period? | ✅ **ANSWERED** — cyclic group `read` at **`periodMs: 1000`**, 15 registers (meters, PMU, C-Box, Rogowski coil). Everything else is `onDemandRead` / `onDemandWrite` / `onDemandReadWrite`. |
| 4 | Can AppLibBuilder target plain arm64 Linux? | ❌ **STILL OPEN** — verify in Phase 1. |
| 5 | What transport is UniEP IPC? | ✅ **ANSWERED** — **MQTT**. Topics are `<app>/<req\|res\|noti>/<service>`, e.g. `sys_manager/res/get_system_info`, `energy_link/res/send_read_register_addr`. Exposed to browsers via a **WebSocket→MQTT bridge** (`WsMqttBridge`) at `wss://<board>:9112/ws`. |
| 6 | Status/owner of the sanctioned Simulation Mode app? | ⚠️ **PARTIAL** — decision recorded 2026-02-25; owner still unconfirmed. Meanwhile **two** simulators already exist (cloud `simulator/` module, Android scenario simulator). See §13. |
| 7 | Who owns the Saleae rig / capture corpus? | ❌ **STILL OPEN** |
| 8 | Init-sequence content? | ❌ **STILL OPEN** — page body empty. |

---

## 11. ★ The local device API — the highest-value seam for app & mobile devs

The EMS+ board exposes a **local HTTPS + WebSocket API** that both installer apps already speak:

| | |
|---|---|
| Base | `https://192.168.100.1:9112` (Wi-Fi Direct) — UniEP Proxy API |
| Proxies to | `http://localhost:9113/` (Web Interface, Node/Express) |
| WebSocket | `wss://<board>:9112/ws` — `WsMqttBridge` |
| Swagger | `https://localhost:9112/api-docs` |
| Frontend | Vue3 + TS served from the board at `/admin`, `/installer`, `/user`, `/portal` |

**REST endpoints in active use** (`qcells-android-installer/data/.../emb/EmbApi.kt`, `qcells-ios-installer/Projects/Data/Sources/Endpoints/Embedded/`):

```
GET  /version/api                             GET  /telemetry
POST /auth/token                              GET  /notifications/{name}
POST /product/serial-number                   POST /api/update/register
POST /publish/{target}/{service}              GET  /api/update/sessions
POST /api/update/{uploadId}/chunk/{chunkIndex}
POST /api/update/finalize                     POST /api/factory/installer-reset
```

That is the **complete** list — see §11.1 for the full contract.

**WebSocket services:** `auth-token`, `subscribe`, `unsubscribe`, `mqtt-request`, `cached-memory`.

Message envelope: `{ headers:{authorization}, tid, service, timestamp, context }`.

> **Why this matters more than the SPI seam for most developers:**
> If your SIL rig serves **this exact HTTP+WS surface on localhost**, then the iOS installer, Android installer, the Vue Web HMI, and `ac_gen2_api` **all work unmodified**. No `LD_PRELOAD`, no cross-compilation, no MPU binaries. Mobile devs get a fully controlled EMS+ with a hostname change.
>
> **Revised seam priority: build Seam D (local device API) first, Seam A (virtual SPI) second.**

### Revised seam map

| Seam | Level | Audience | Effort | Fidelity |
|---|---|---|---|---|
| **D — Local device API** (`:9112` REST + `/ws`) | Device edge | **Mobile + web devs** ← biggest population | Low | Medium-high |
| **B — MQTT IPC bus** | Inside MPU | App devs, `ipc_tester` | Low (IPC *is* MQTT — just publish/subscribe) | High |
| **A — Virtual SPI + virtual MCU** | Below MPU | Platform/firmware devs, FW-update tests | Medium | Highest |
| **C — Cloud/north stub** | Above MPU | Provisioning, telemetry, OTA | Low | Medium |

Because IPC is MQTT, **Seam B needs no `LD_PRELOAD` and no source changes at all** — a fake device app is just another MQTT client. This is a significant simplification versus the original plan.

---

### 11.1 Seam D in detail — the surface to implement

The entire contract that mobile apps depend on is small and **fully enumerated in code you already have**
(`qcells-android-installer/data/src/main/java/com/qcells/data/remote/emb/EmbApi.kt`,
`domain/src/main/java/com/qcells/domain/enums/MqttKey.kt`, `NotificationName.kt`).

#### A. REST surface — 11 endpoints, that's all

| Method | Path | Purpose | Simulator behaviour |
|---|---|---|---|
| `GET`  | `/version/api` | API version probe | Static, from a pinned contract version |
| `POST` | `/auth/token` | Obtain bearer token | Issue a real JWT; **honour expiry** so refresh paths get exercised |
| `POST` | `/publish/{target}/{service}` | **The IPC RPC front door** | Route to virtual app (see B) |
| `GET`  | `/notifications/{name}` | Poll latest cached notification | Serve from the virtual Cache Manager |
| `POST` | `/api/update/register` | Begin FW upload, returns `uploadId` | Allocate session; enforce chunk ordering |
| `POST` | `/api/update/{uploadId}/chunk/{chunkIndex}` | Upload one chunk | Validate index monotonicity + size |
| `GET`  | `/api/update/sessions` | List update sessions | Reflect the state machine |
| `POST` | `/api/update/finalize` | Commit the upload | Kick the virtual SPI FW-update flow (Seam A) |
| `GET`  | `/telemetry` | Current telemetry snapshot | Rendered from the virtual plant |
| `POST` | `/api/factory/installer-reset` | Factory reset | Reset all virtual state |
| `POST` | `/product/serial-number` | Write EMS serial | Persist to virtual storage |

> Envelope is uniform: `EmbResponse<T>`. **Match the error envelope exactly** — apps branch on it. This is where a sloppy simulator does more harm than none.

#### B. IPC RPC catalog — 7 targets × 23 services

`POST /publish/{target}/{service}` maps onto MQTT `<target>/req/<service>`, with the reply on `<target>/res/<service>`.

| Target | Services |
|---|---|
| `db_manager` | `select_records`, `update_records` |
| `device_manager` | `mi_scan_start_stop`, `mi_scan_realtime_data`, `mi_multi_add`, `mi_multi_delete`, `mi_get_monitoring_data`, `mi_reconnection_time_short` |
| `sys_manager` | `scan_wifi`, `set_wifi_connect`, `set_wifi_disconnect`, `set_ethernet_config`, `set_cellular_activate`, `set_cellular_deactivate`, `set_timezone`, `set_configuration_json`, `get_configuration_json` |
| `energy_dispatcher` | `get_energy_settings`, `update_energy_settings` |
| `realtime_monitor` | `get_realtime_monitoring_data` |
| `energy_link` | `send_read_metric`, `send_write_metric` |
| `edge_runtime` | `request_system_reboot` |

**`energy_link/send_read_metric` and `send_write_metric` are the bridge to the MCU.** They take a metric identifier and cross the SPI boundary. Implement these against the generated register model from §12 and **Seams D and A meet in the middle** — that junction is the whole architecture in one line.

`db_manager` operates on `edge_storage.db`, tables `device_info` and `system_setting`, with well-known keys:
`product_serial_number`, `battery_pack_sn`, `mpu_version`, `pcs_version`, `MCU_FW_VERSION`, `jf2_bms_version`, `bpu_version`, `mi_info`, `System_Commissioning_Status`, `fault_history`, `Grid_V_Detection_Value`, `Nameplate_Ratings_WMaxRtg`, `validation_status_info`, `ja12_enabled_date`.
Wire types are `MqttDataType`: `BOOL=0, UINT8=1, UINT16=3, UINT32=5, INT32=6, UINT64=7, INT64=8, DOUBLE=9, STRING=10, JSON_STRING=11, JSON_STRING_ARRAY=12`.

> ⚠️ Note the gap: `UINT16=3` and `UINT32=5` skip 2 and 4. Don't "fix" it — replicate it.

#### C. Notifications — 5 async channels

`network_info`, `wifi_scan_result`, `wifi_status`, `ethernet_status`, `swupdate_progress`

Available both by `GET /notifications/{name}` (cached latest) and by WS `subscribe` (push). **The simulator must serve both consistently** — a poller and a subscriber observing different values is a classic real-device bug worth reproducing *on demand*, but never by accident.

`swupdate_progress` is the highest-value one: it's the only progress feed during firmware update, and every "stuck at 47%" support ticket lives here.

#### D. Transport details that will bite you

- **TLS**: the board serves HTTPS with a self-signed cert; both apps ship an unsafe/pinned-trust OkHttp client (`EmbApiModule.kt::getUnsafeOkhttpClient`). The simulator should serve TLS too — if it serves plain HTTP, apps need a code change and you've lost the "works unmodified" property. Generate a self-signed cert at startup.
- **Host**: apps target `192.168.100.1:9112` (Wi-Fi Direct). Make the base URL injectable via build config / launch argument so devs can point at `localhost:9112`. If it isn't already injectable on iOS, **that one-line change is the entire iOS integration cost.**
- **WebSocket** at `/ws` with services `auth-token`, `subscribe`, `unsubscribe`, `mqtt-request`, `cached-memory`. Envelope `{ headers:{authorization}, tid, service, timestamp, context }`. `tid` correlates request→response — honour it, including for out-of-order and duplicate replies.
- Reserved handler name `ws-mqtt-bridge` — don't shadow it.

#### E. Implementation shape

```
sil-rig/
  transport/http     → TLS server, 11 REST routes, EmbResponse envelope
  transport/ws       → WsMqttBridge-compatible: subscribe / mqtt-request / cached-memory
  ipc/broker         → in-process MQTT-shaped bus (<app>/<req|res|noti>/<service>)
  apps/              → virtual sys_manager, device_manager, db_manager,
                        energy_dispatcher, realtime_monitor, energy_link, edge_runtime
  cache/             → Cache Manager: latest Response + Notification per topic
  mcu/               → generated register model (§12) + virtual MCU (Seam A)
  plant/             → physical model: PV curve, battery SoC integrator, load, grid
  clock/             → virtual clock (pausable, steppable, fast-forwardable)
  scenario/          → YAML loader, fault injection, assertions
  control/           → REST + CLI control plane (§14)
```

**Language:** pick the one your team will maintain. Kotlin/JVM lets you reuse cloud-server code and the Android scenario loader; Go or Rust give a single static binary devs can `brew install` with no runtime. **The single-binary property matters more than language purity** — the adoption barrier for a simulator is measured in seconds-to-first-run.

#### F. Definition of done for Seam D

The simulator has succeeded when **an app developer can run the iOS or Android installer through the full commissioning flow — site creation, MI scan, network setup, firmware update, validation — with no hardware, no code changes, and identical results on every run.**

Everything else in this document is in service of that sentence.

---

## 12. ★ The register map — already in your hands

`qcells-cloud-server-nextgen-schemas/factory_json/ac_system_gen2/factory_register_map.json` (1.2 MB)

```
version, schemaVersion, protocolVersion { can:0.99, spi:1.00, installDoc:1.67, jf2:2.8.4.8 }
registerMaps[]:
  qcells_mcu     protocol=QcellsSPI    523 registers   4,411 metrics
  qcells_ess_g4  protocol=CAN          833 registers   2,985 metrics
  qcells_mpu     protocol=None          40 groups        710 metrics
                                       ───────────────────────────────
                                       TOTAL            8,106 metrics
```

**`qcells_mcu` register groups**

| Group | periodMs | Registers | Notes |
|---|---|---|---|
| `onDemandWrite` | 0 | 4 | `MCU_Rebooting_CMD` `0x8001`, `FW_Update_Status` `0x8010`, … |
| `onDemandRead` | 0 | 230 | `FW_Update_Status_Read` `0x8010`, `MCU_Debug_Info0` `0x8581`, … |
| `onDemandReadWrite` | 0 | 274 | `MPU_Info` `0x8003`, `MPU_Status` `0x8004`, … |
| **`read`** | **1000** | **15** | **the cyclic loop** — see below |

**Cyclic (1 Hz) registers — this is the real-time data path:**

```
0x80   Meter_IC_Info_01        58 B  18 metrics    0x8224 PMU_Monitoring_Data_01  64 B  30 metrics
0x9D   Meter_IC_Info_02        60 B  16 metrics    0x8225 PMU_Monitoring_Data_02  54 B  12 metrics
0xBB   Meter_IC_Info_03        64 B  13 metrics    0x8226 PMU_Monitoring_Data_03  64 B   4 metrics
0xDD   Meter_IC_Info_04        62 B  16 metrics    0x8227 PMU_Monitoring_Data_04  53 B  25 metrics
0xFB   Meter_IC_Info_05        10 B   3 metrics    0x8228 PMU_Monitoring_Data_05  25 B  15 metrics
0x8127 Solar_Off_Grid_State     1 B   1 metric     0x8400 C_Box_Monitoring        62 B  17 metrics
0x6B1A MI_Enter_Service         2 B   1 metric     0x8480 Rogowski_Coil_Monitoring 64 B 16 metrics
                                                   0x8481 Rogowski_Coil_Energy    16 B   2 metrics
```

**Every metric carries** `id`, `offset`, `dataType` (`uint8/16/32`, `int16/32/64`, `string`+`stringLength`, `boolean`, `jsonStringObject`, `jsonStringArray`), and optionally `unit` (`W`, `Var`, `A`, `V`, `Hz`, `Wh`, `ms`, `%`), `scaleFactor` (e.g. `0.01`), `defaultValue`, `minValue`, `maxValue`.

### Consequences

1. **The virtual MCU is a code-generation problem, not a reverse-engineering problem.** Generate the register file, the codec, and the decoder from this JSON.
2. **`minValue`/`maxValue`/`defaultValue` on thousands of metrics = automatic boundary-value fault injection.** Below-min / at-min / mid / at-max / above-max for free.
3. **`scaleFactor` + `unit` give you a typed physical model** for the plant simulation.
4. **There is a whole second device layer you hadn't scoped:** `qcells_ess_g4` over **CAN**, 833 registers — the ESS/battery/PCS side (`P01_PCS_Fault_Release_CMD`, `FS_Grid_V_Detection_Value`, …). Decide explicitly whether the SIL models CAN too.
5. **`qcells_mpu` documents the MPU's own data model** — `setting_data` (incl. `INSTALL_DATA_GROUP1`: `Inverter_Max_output_Power`, `Grid_Target_Frequency`, `ESS1/2_Battery_number`), `info_data`, `persistent_data` (`mpu_energy_control`: `MPU_Operation_CMD`, `System_Target_Power` ±38400 W, `Battery_Target_Power`), and `control_data` which maps directly to **IPC service names**:
   `reboot → edge_runtime/request_system_reboot`, `rebootHub → device_manager/reboot_hub`, `wifiSetting → sys_manager/set_wifi_connect`, …
   That last group is effectively a **ready-made IPC command catalog**.

> ⚠️ `factory_configuration.json` (226 KB) contains real endpoint URLs (e.g. EST/ezca provisioning). Treat as sensitive; don't copy secrets into the simulator repo.

---

## 13. Existing simulation efforts — what to take, what to leave

Three efforts exist. **None of them does what you need**, but two contain reusable material and one defines your mandate.

### 13.1 The cloud simulator — what it actually is

`qcells-cloud-server/simulator/` — Spring Boot, ~308 Java files, built with Jib, deployed to AKS via Kustomize, **scaled to 20 replicas targeting 1,000 sites.**

**It is a fleet-scale load generator, not a developer tool.** It exists to make the cloud backend believe thousands of real EMS+ units are online, so that ingestion, storage, dashboards, and alerting can be tested at production volume.

**How it works**

1. **Commissioning.** `POST /simulator/api/sites` with `{configuration: "SOLAR"|"BACKUP", token}` runs the *real* commissioning workflow against the *real* API (`api.dev.us.qommand.qcells.com`) — site creation, device provisioning, setup — and returns a `siteId`. `DELETE /simulator/api/sites/{siteId}` tears it down. An `AutoLoadService` can create sites automatically (target 1,000; max 100 per run; 90 % SOLAR / 10 % BACKUP; every 10 s) — **disabled by default**, enabled by uncommenting a `@Scheduled` annotation.
2. **Device lifecycle.** `LoadDeviceScheduler` polls the DB every 10 s and starts a `SimulatorRuntime` per device for anything in `START_REQUESTED`, plus **restarts any `RUNNING` device that hasn't sent a heartbeat in 5 minutes**. Bounded by `maxSimulatorCount`.
3. **Per-device runtime.** Each `SimulatorRuntime` opens an **MQTT connection to Azure IoT Core impersonating one device**, then runs scheduled publishers and subscribers:

| Direction | What |
|---|---|
| **Publishes** | `ems/ready`, `ems/info/device`, `ems/config`; **1-minute telemetry** (always); **15-minute MI telemetry** (only for `EmsTypeCode.STANDALONE`); **hourly hub generator**; heartbeats to the DB |
| **Subscribes** | `configuration`, `control`, `firmware_update`, `qommand_info`, `tou` — and *responds* (e.g. `RebootControlRequestHandler`, `RealTimeMonitoringControlRequestHandler`) |

4. **Data generation.** `Telemetry1minRanges` declares per-point numeric ranges; `RandomValueGenerator` samples them. There are three shapes: `Telemetry1mMessageGeneratorDefaultImpl`, `...BackupStandAloneImpl`, `...BackupPrimaryImpl`, chosen by `EmsTypeCode`.
5. **Fault injection.** `ErrorFactory.generateErrors()` randomly picks codes from `ACES` / `COMMON` buckets; `generateMicroInverterErrors()` returns 0–2; `ErrorCache` holds them per-device for 1 hour so a fault persists rather than flickering.

**Why it doesn't solve your problem**

| | |
|---|---|
| Wrong side of the wire | It talks **MQTT to the cloud**. It never touches the local `:9112` API, BLE, Wi-Fi Direct, SPI, or the MCU. A mobile installer app cannot use it at all. |
| Requires real infrastructure | Needs Azure IoT Core, a live API, a DB, and credentials. Not runnable on a laptop, offline, or in a PR check. |
| Non-deterministic by design | Random values, random faults, wall-clock schedules. **Correct for load testing, useless for reproducing a bug.** |
| No physics | Points are sampled from independent ranges. Nothing conserves energy — PV, load, battery, and grid don't have to add up. |
| Coarse cadence | 1 min / 15 min / 1 hour. Commissioning and energy-flow UX operate at seconds. |

**What to take from it:** the fault-code buckets, `Telemetry1minRanges`, the `EmsTypeCode`-driven generator split, and the device state machine (`START_REQUESTED`/`STARTING`/`RUNNING`/`STOPPED` + 5-minute heartbeat threshold — which is also **the real definition of "offline"** and belongs in your failure catalog).

**What to leave:** everything about its architecture. Different problem.

### 13.2 The Android scenario simulator — a pilot, treated as one

`qcells-android-installer`: `docs/simulator_manual.md`, `data/src/main/assets/scenarios/*.yaml` (19 files), `SimulatedEmbRepository`, `MockNetworkSimStore`, `SimulatedBleConnectionUtil`, gated behind a `Mock` product flavor.

Per the author: **a half-baked pilot.** Treat it accordingly — mine it, don't inherit it.

Its structural limits are inherent, not fixable by polish:
- It replaces repositories **inside the app process**. Nothing outside the app is simulated, so it can never validate the wire protocol, the API envelope, timeouts, TLS, or reconnection.
- It's Android-only. iOS would need a parallel implementation with the same limits — **two mocks that drift is worse than one simulator.**
- Simulator code compiles into every flavor and is gated only at runtime.
- Being in-process, it can't be shared with the Web HMI, QA, or automated integration tests.

**Worth mining:**
- The **19 scenario names** — they encode which situations actually matter, and the `g2s_*` ones pin real defects. That's a requirements list, free.
- The `extends:` inheritance idea (a base scenario plus deltas) — a good pattern regardless of format.
- `docs/simulator_manual.md` as a record of what developers asked for.

**Worth discarding:** the format itself, the in-process architecture, the flavor gating. **Design the scenario schema fresh** against the SIL's actual seams (see the proposed schema in `AC-GEN2-FAILURE-CASE-CATALOG.md` §8) rather than retrofitting a pilot's shape.

> The right end state: **Seam D makes the Android `Mock` flavor unnecessary.** The app points at `localhost:9112` and gets a simulator that's realer than any in-process mock — and iOS gets it at the same time, for free.

### 13.3 The sanctioned in-MPU Simulation Mode

Confluence “Simulation Mode에 대한 검토 및 정리” (`11162616608`) records that the team evaluated five approaches and selected an in-MPU Simulation Mode (decision dated 2026-02-25). Owner and status unconfirmed.

**Action: find the owner before writing code.** The goal is to *be* this, not to compete with it. Note that the same evaluation rejected “Python script inside MPU SW” for exactly the reason given in §14 — injecting above the control loop is one-way — which is a good sign the reasoning here is aligned with the team's.

### 13.4 Net position

| | Cloud sim | Android sim | **SIL rig** |
|---|---|---|---|
| Runs on a laptop, offline | ❌ | ✅ | ✅ |
| Usable by iOS | ❌ | ❌ | ✅ |
| Usable by Web HMI | ❌ | ❌ | ✅ |
| Exercises the real wire protocol | partial (cloud MQTT) | ❌ | ✅ |
| Models MPU↔MCU / SPI | ❌ | ❌ | ✅ |
| Deterministic / reproducible | ❌ | partial | ✅ **← the differentiator** |
| Fleet-scale load | ✅ | ❌ | not a goal |

The cloud simulator keeps its job. The SIL rig takes the developer-facing one.

---

## 14. ★ Should the SIL control surface live in the embedded Web HMI?

**Short answer: yes as the *cockpit*, no as the *engine*. Split them.**

### Why the Gen1 precedent is sound

The plumbing already exists and is better than you'd expect:

- The board serves a **Vue3 + TypeScript** frontend at `/admin`, `/installer`, `/user`, `/portal` (build target `--dest ../../dist/<app>`, `assetsDir: '../resources/'`).
- The Web HMI is already a **WebSocket client of the IPC bus** via `WsMqttBridge` — it can `subscribe` to any `NOTI_*` topic and issue `mqtt-request` to any `SERVICE_*`. A simulator control panel is *just another WS client*. Nearly zero new infrastructure.
- There is precedent for a privileged surface: **Web HMI engineer password** (`GET /managements/security/ems/web/hmi/passwords`), "Reverse HMI (Engineer Page)", and `Engineer_Control_Mode` in `mpu_energy_control`. A gated engineer-only simulator tab fits the existing security model.
- `qcells-hems-frontend-vue` already contains an **energy-flow renderer** — `EnergyFlowACContainer.vue`, `EnergyFlowACPipeLayer.vue`, `EnergyFlowACProductLayer.vue`, `EnergyFlowFunctions.ts`, with **Lottie** animations via `packages/component/src/siteEnergy/Flow.vue`. You'd get live visual feedback on your simulated plant essentially for free.

### Why the engine must **not** live there

1. **Wrong side of the boundary.** The HMI sits *above* the IPC bus. An engine there can only inject data northbound — exactly the one-way limitation that killed the "Python script inside MPU SW" option in the team's own evaluation. Control writes would never reach a plant model.
2. **No headless/CI story.** A browser-resident engine can't run in Jenkins, can't run in `ipc_tester`, can't run 500 scenarios overnight.
3. **Not reusable by mobile.** iOS/Android talk to `:9112` REST, not to the HMI's DOM.
4. **Determinism is impossible** in a browser event loop with wall-clock timers.
5. **Deployment coupling.** Every simulator change would require reflashing/redeploying HMI assets.

### Recommended architecture

```
┌──────────────────────────────────────────────────────────┐
│  CONTROL PLANE (pick any, all equal citizens)            │
│  • Web HMI "Simulator" tab  ← the Gen1-style cockpit     │
│  • REST/CLI  (for CI, ipc_tester, Jenkins)               │
│  • Scenario YAML files      ← the reproducible artifact  │
└───────────────────────────┬──────────────────────────────┘
                            │ one control API
┌───────────────────────────▼──────────────────────────────┐
│  SIMULATION ENGINE  (headless service)                   │
│  virtual clock · seeded RNG · plant model · fault inject │
│  register file generated from factory_register_map.json  │
└───────────────────────────┬──────────────────────────────┘
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   Seam A (SPI)       Seam B (MQTT IPC)    Seam D (:9112 API)
   virtual MCU        fake device app      local device API
```

**Rule: the HMI panel must not be able to do anything the CLI can't.** If a QA engineer can only reproduce a bug by clicking, you've built a toy. The YAML scenario file is the artifact that gets attached to the Jira ticket.

### RESOLVED — Gen1 HMI analysed

`http://192.168.8.248:1880/ui` was retrieved (`GET /flows` is unauthenticated; 594 KB, 1,328 nodes)
and the three open questions are answered:

- **Above or below the control loop?** *Below*, and further below than expected. The Gen1 panel
  drives `socketcan-config` on `can0` plus a Modbus-RTU slave on `/dev/ttyAMA0`. It is
  **hardware-in-the-loop, not software-in-the-loop** — it needs a Pi and live PCS/BDC/BMS/HUB
  hardware, and because it drives CAN rather than `:9112`, **a mobile app cannot use it at all**.
  This confirms the seam decision: serve the device API, not the bus.
- **Scriptable or headless?** No. 193 `ui_switch` + 121 `ui_button` + 103 `ui_text_input` widgets,
  every one a manual click. No composition, no determinism, no time control.
- **Scenario format worth inheriting?** There is no scenario format to inherit. What *is* worth
  inheriting is the **fault taxonomy** — domain × severity codes (`H00101F`, `G01203W`,
  `P02603A`), a 192-switch Fault Manager tab, and a 200-widget Error tab of raw hex bitmask entry
  per flag byte. Both the taxonomy and the raw-bitmask escape hatch are implemented in
  `can.flag.*`.

The decisive structural flaw: Gen1 has **no physics**. Its sliders are independent, so it will
happily hold PV 6 kW, load 1 kW and grid import 5 kW simultaneously. The rig's plant model is
energy-conserving and makes `plant.grid_w` / `plant.battery_w` read-only for exactly this reason.

Full comparison table: `README.md` §12.

---

## 15. Deployment path to your local EMS Pi board (brief)

You don't own the platform code, so keep the footprint additive:

| Option | How | Notes |
|---|---|---|
| **Run the SIL off-board** ✅ **recommended** | Simulator runs on your Mac; point the mobile app / browser at your host instead of `192.168.100.1:9112` | Zero board changes, no signing, no ownership needed. **Do this first.** |
| **Static HMI asset drop** | The HMI is a static Vue bundle under the device's served `resources/` | Needs write access to the served dir; may be wiped by SWUpdate. Fine for a dev board. |
| **Sideload a container** | UniEP is containerized; add your simulator container | Needs registry access + the internal Docker mirror (VPN). |
| **Signed `.swu` package** | Proper path, via `build_apps.sh` / Jenkins `b apps` | Requires code ownership, signing keys, and SWUpdate's `swupdate_cert.pem`. **Not worth it for local dev.** |

⚠️ SWUpdate is signature-verified (`/etc/swupdate/swupdate_cert.pem`) and the board has A/B partitioning + bootloader fallback. Anything you hand-place outside a signed update may be reverted on the next OTA. Treat the Pi board as disposable and keep the simulator authoritative on your Mac.

---

## 16. Key references

| Page | ID |
|---|---|
| 07. MPU-MCU SPI Firmware Update Protocol Spec | `10768187454` |
| 07 [AC GEN2] Simulation Mode에 대한 검토 및 정리 | `11162616608` |
| AC Gen2 SPI Debugger 사용법 정리 | `11162320940` |
| 02 [AC GEN2] Software Architecture Design | `10925277355` |
| 01 [AC GEN2] System Architecture Design | `10924393664` |
| [AC GEN2] EMS+ MPU 외부 interface 설계 | `10928161701` |
| [AC Gen2] IPC Naming Rules | `11279467251` |
| [AC System GEN2] IPC test documentation | `11244339405` |
| 05. MCU Updater Design Specification | `10899654249` |
| 06_EMS+ MCU-MPU Initialization sequence *(empty)* | `11062673453` |
| MCU ST Link JTAG Flashing Guide | `11249057793` |
| 09 [AC GEN2] Version release sync (MPU/MCU) | `11252073824` |
| FUSA SPI/MPU requirements (FUS-115…FUS-156, FUS-285…287) | space `FUSA` |

Base URL: `https://growingenergylabs.atlassian.net/wiki/spaces/EnergySW/pages/<ID>`

---

## 17. Implementation status

The rig described by §11.1 and [`AC-GEN2-SIL-CONTROL-PLANE.md`](./AC-GEN2-SIL-CONTROL-PLANE.md) is **built and running**: [`sil-rig/`](./sil-rig/README.md).

Node 22 + TypeScript, chosen because the real board's Web Interface (`edge_core_nodejs`) is itself Node/Express — matching express 5, ws 8.18 and jsonwebtoken 9 gives the best envelope fidelity at zero install cost.

### What works

| Seam | Delivered |
|---|---|
| **D** — local device API | All 11 endpoints from `EmbApi.kt`, self-signed TLS on `:9112`, `EmbResponse` envelope, JWT auth |
| **B** — IPC | MQTT-shaped in-process broker, 7 targets × 23 services from `MqttKey.kt`, notification cache seeded at boot, `WsMqttBridge`-compatible `/ws` |
| **A** — virtual MCU | Real `factory_register_map.json` (520 registers / 4,411 metrics / 15 cyclic), CRC16-CCITT, 71-byte and 4107-byte framing, inspectable at `/spi/status` and `/spi/read/{reg}` |
| **C** — cloud | Levers only (`cloud.*`), deliberately not a cloud simulator |

- **155 controls** across 12 groups, all validated; `patch` is all-or-nothing
- **140 scenarios**, composed via `extends`, every one verified to load at runtime
- **Control plane** on `:9114`, with the `GET /control/diff` → scenario workflow as the centrepiece
- **Determinism proven** under `chaos_monkey`: identical telemetry sequences across independent runs at the same seed

### Verification

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` (17 tests, incl. full corpus validation) | 17/17 pass |
| `test/smoke.sh` (end-to-end, every seam) | 25/25 pass |
| `test/determinism.sh` | pass |
| All 140 scenarios loaded at runtime | 0 failures |

### Design decisions worth knowing

- **`plant.grid_w` and `plant.battery_w` are read-only.** They are computed from an energy-conserving model, so no scenario can describe a physically impossible site. This is precisely the flaw that makes the cloud simulator useless for UI work, where points are sampled independently and do not sum.
- **Reactive and apparent power are derived from active power**, not sampled separately, so a register dump is internally consistent.
- **The deadband is applied before rounding**, and formatting is `Locale.US` regardless of `sim.locale` — both replicate the device rather than fixing it.
- **Seeded RNG uses derived substreams per subsystem**, so enabling chaos in one subsystem cannot shift the numbers any other subsystem sees.
- **`mcu.registers.boundary_mode`** drives all 4,411 metrics to their declared extremes in one run.
- **`fault.sweep.*`** walks the codebook, proving every code renders and every fault has a working clear path.

### Remaining gaps

- No BLE transport; `ble.*` levers are published on `/state` for the client's own BLE mock.
- ~~`qcells_ess_g4` CAN registers load but are not physics-driven~~ **Done.** Confirmed in scope and
  implemented: `src/can/` binds the 833 registers / 2,985 metrics to the plant, splits power across
  dual PCS units, models transport faults (bus-off, arbitration storm, absent unit, stuck
  heartbeat), and drives the fault bitmasks through `P01/P02_PCS_Error_Status_01/_02` — the same
  registers Gen1's Error tab wrote to.
- ~~Gen1 embedded web HMI link outstanding~~ **Done** — see §14.
- MCU firmware source location still unknown, so the virtual MCU is modelled from the register map
  and SPI spec. Deferred by decision, not blocked.
- **IEEE 1547 voltage bands are uncalibrated.** Tables 12/13 are paywalled, so all three abnormal
  operating categories share one band and differ only in ride-through duration. See README §11.
