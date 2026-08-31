# AC Gen2 — Site Digital Twin Web App

> A standalone website that renders a **visual digital twin** of a commissioned site — topology, detailed breakdowns, drill-downs, and energy-flow animations — driven by the site configuration produced during commissioning.
> - [`AC-GEN2-SIL-CONTROL-PLANE.md`](./AC-GEN2-SIL-CONTROL-PLANE.md) — control taxonomy + scenario catalog
> - [`sil-rig/`](./sil-rig/README.md) — **the implementation**: 155 controls, 140 scenarios, serving `:9112`

---

## 1. Why this is more tractable than it sounds

Three of the four hard parts already exist:

| Need | Already exists |
|---|---|
| **Site topology data model** | `SiteSyncPayload.Hardware` + `SiteSyncRequest` in `qcells-resi-server` |
| **Energy-flow case logic** | `EnergyFlowUtil` (Android), `EnergyFlowFunctions.ts` (Vue), `EnergyFlowUtil.swift` (iOS) — three implementations of the same 26-case matrix |
| **Flow animation assets** | Lottie JSONs + layered SVGs in `qcells-hems-frontend-vue/packages/component/src/siteEnergy/Flow.vue` |
| **Live data source** | ❌ the genuinely new part — plus richer topology than any current surface renders |

**The missing piece is not rendering — it's that no existing surface renders *topology*.** Every current view (mobile dashboard, Vue HEMS, homeowner app) draws a **fixed house graphic** with 3–4 fixed nodes (Solar, Battery, Grid, Load). None of them reflect *this* site's actual inverter count, battery string layout, microinverter positions, CT placement, or backup circuits. That's the differentiator.

---

## 2. Data model — what commissioning gives you

### `SiteSyncPayload.Hardware` — the richest topology source
`qcells-resi-server/shared/common-resi-commissioning-contract/.../event/SiteSyncPayload.java`

```
hardware:
  accombiners[]   Accombiner(manufacturer, model, productCode, serialNumber,
                             productType, firmwareVersions)
  acmodules[]     Acmodule(..., powerClass)
  inverters[]     Inverter(..., inverterType, productType,
                           connectedHardwareAcmodulesSerialNumber,  ← EDGES!
                           firmwareVersions)
  batteries[]     Battery(..., communicationType, backupType, couplingType,
                          firmwareVersions{bmsVersion, bdcVersion})
  expansionUnits[] ExpansionUnit(manufacturer, model, productCode, serialNumber, productType)
  hubs[]          Hub(..., firmwareVersions)
  systemDetails   SystemDetails(PanelSystemSize{value, unit})

siteDetails · monitoringDetails · installers · partners · customers
```

> **`Inverter.connectedHardwareAcmodulesSerialNumber` is the key field** — it's an explicit parent→child edge (inverter → AC modules). That single relation turns a flat equipment list into a renderable graph.

### `SiteSyncRequest` — the commissioning submission
`siteName`, `accountId`, `timezoneId`, `address{latitude, longitude, placeName, placeAddress, city, state, postalCode, country}`, `installer{email, accountId}`, `device[]`, `microInverters[]`, `batteries[]`, `expansionBatterySerialNumbers`, `hubs[]`, `customers[]`

### ⚠️ `SiteEquipmentConfiguration` is *not* enough
`resi-commissioning/.../equipment/domain/SiteEquipmentConfiguration.java` stores only:
```java
{ microInverterSerialNumbers, batterySerialNumbers }   // EquipmentService.parseRequestToJson()
```
Endpoints `PUT/GET /v1/sites/equipment-configuration` will **not** give you enough to draw a twin. Use `SiteSyncPayload` instead.

### Device-side configuration
`nextgen-schemas/schemas/messages/configuration/Retrieval.schema.json` → `version`, `lastModifiedBy`, `lastModifiedAt`, `deviceList[]`, `commonTelemetryVer`

And in `factory_register_map.json` → `qcells_mpu / setting_data / INSTALL_DATA_GROUP1`:
`Inverter_Max_output_Power` (%), `Grid_Target_Frequency` (Hz), `ESS1_Battery_number`, `ESS2_Battery_number` (0–4), … — **the real electrical parameters of the installed system.**

### Missing for a *complete* twin
- **CT / Rogowski coil placement** — partially inferable from `hardwareSetting.solarConfig.consumptionCtPair1Type` (`ConsumptionCtType.NotInstalled`) and the `Rogowski_Coil_Monitoring` register (`0x8480`)
- **Backup / essential-load circuit mapping** — `Battery.backupType` exists but per-circuit detail does not
- **Panel-string layout / physical roof geometry** — only `SystemDetails.PanelSystemSize` aggregate
- **Generator** — enum exists across all three clients, never rendered

---

## 3. Live data

| Source | Endpoint | Cadence |
|---|---|---|
| **Cloud SSE** (mobile precedent) | `POST /v1/devices/{deviceId}/telemetry` `{pointRid:"realtimeTelemetry", value:{command:"START"}}` → `GET /api/v1/sessions/{sessionId}/stream` | 3–60 s |
| **REST** (Vue HEMS precedent) | `/devices/telemetries/{siteId}`, `/devices/profiles/{siteId}/installations`, `/devices/telemetries/network-type/{siteId}` | poll |
| **Local device WS** | `wss://<board>:9112/ws` → `subscribe` MQTT topics | push, sub-second |
| **SIL simulator** | same shapes, synthetic | scriptable |

### Realtime telemetry contract
`nextgen-schemas/schemas/messages/realtime-telemetry/RealtimeTelemetry.schema.json`

```json
{ "eventTime": "2025-09-15T13:42:00Z",
  "points": {
    "pv_200_W": 100.0, "extpv_200_W": 50.0, "grid_200_W": 130.0,
    "load_200_W": 200.0, "battery_200_W": 60.0,
    "battery_713_SoC": 80.5, "battery_713_SoH": 78.3,
    "Grid_Status": 0, "energyControl": 0, "networkType": 0 } }
```

**Contractual semantics — do not re-derive:**
- `grid > 0` = **import**, `grid < 0` = **export**
- `battery > 0` = **discharging**, `battery < 0` = **charging**
- `Grid_Status == 0` = on-grid; anything else = off-grid
- `pv = pv_200_W + extpv_200_W`, summed **before** unit conversion
- Deadband **0.1 kW**, applied **before** rounding; a missing field reads as `0.0`, not "unknown"
- `SoC == 100` forces `FullCharged` even when `battery_200_W < 0`
- Sign is **stripped for display**; direction is shown by arrow + label

> For deeper drill-downs than the 10 cloud points, go to the **register map**: 4,411 MCU metrics including per-phase meter data (`Meter_IC_Info_01..05`), `PMU_Monitoring_Data_01..05`, `C_Box_Monitoring`, `Rogowski_Coil_Monitoring` — plus 2,985 CAN metrics on the ESS G4 side. **That's the drill-down substrate.**

---

## 4. Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Digital Twin Web App  (new)                                  │
│  ┌─────────────┬──────────────┬─────────────┬──────────────┐  │
│  │ Topology    │ Energy Flow  │ Drill-down  │ Timeline /   │  │
│  │ graph       │ animation    │ inspector   │ scrubber     │  │
│  └─────────────┴──────────────┴─────────────┴──────────────┘  │
│         ▲                ▲              ▲             ▲       │
│    site config      live points    register map   history     │
└─────────┼────────────────┼──────────────┼─────────────┼───────┘
          │                │              │             │
   SiteSyncPayload   SSE / WS / REST   factory_       energy
   (topology)        (realtime)        register_map   summary API
                            │
                     ┌──────┴───────┐
                     │  SIL rig     │  ← demo & test without hardware
                     └──────────────┘
```

### Model: nodes + edges, not a fixed house picture

```ts
type TwinNode = {
  id: string; kind: 'grid'|'meter'|'ct'|'inverter'|'acmodule'|'accombiner'
              |'battery'|'expansion'|'hub'|'ems'|'load'|'backup'|'generator';
  serialNumber?: string; manufacturer?: string; model?: string;
  productCode?: string; firmwareVersions?: Record<string,string>;
  health: 'ok'|'warning'|'alarm'|'fault'|'offline';
  faults: FaultCode[];
  metrics: Record<string, { value: number; unit: string; ts: string }>;
};

type TwinEdge = {
  from: string; to: string;
  kind: 'ac'|'dc'|'comms-can'|'comms-spi'|'comms-plc'|'comms-ble';
  powerW?: number;          // signed; sign defines animation direction
  animate: boolean;
};
```

- Build edges from `Inverter.connectedHardwareAcmodulesSerialNumber`, `Battery.couplingType`/`communicationType`, and hub associations.
- **Keep the 26-case flow matrix for the *summary* view** (it's the shared contract across three clients — deviating creates a fourth truth). Use the node/edge graph for the *detailed* view.

---

## 5. Reuse vs. build

| Reuse | Build new |
|---|---|
| Lottie flow animations + layered SVGs (`packages/component/src/siteEnergy/Flow.vue`) | Topology graph renderer (SVG or Canvas; consider `elkjs`/`dagre` for layout) |
| `EnergyFlowFunctions.ts` case logic | Node/edge model from `SiteSyncPayload` |
| Highcharts/Highstock (`HighchartsWrapper.vue`, `GraphChart.vue`) | Drill-down inspector over register-map metrics |
| MSW mocks + demo JSON (`web/user/src/mobileviews/demojson/*.json`) | Time-scrubber / replay |
| Error codebook + `howToFix` text | Fault overlay on affected nodes |
| `@hems/*` component library & design tokens | — |

**Recommendation: build it as a new package inside `qcells-hems-frontend-vue`** (`web/twin` / `@hems/twin`) rather than a standalone repo — you inherit the component library, service layer, auth, mocks, and build tooling on day one. Split it out later if it needs an independent release cadence.

---

## 6. Why the SIL rig and the twin belong together

They are mutually enabling:

- **The twin is the best possible debug UI for the simulator.** Watching a scripted scenario animate through the topology beats reading logs.
- **The simulator is the only way to demo/develop the twin without a commissioned site.** No hardware, no roof, no utility interconnection.
- **Shared contract**: both consume `SiteSyncPayload` + `RealtimeTelemetry`. One schema, two consumers.
- **Fault visualization is free**: the simulator injects `E001`, the twin lights up the Rogowski coil node red with `description` + `howToFix` from the existing display JSON.
- **The twin becomes the acceptance test surface** for scenario correctness.

> Build a `--source=sim` flag from day one. The twin should not know whether it's rendering a real site or a simulated one.

---

## 7. Phased plan

### Phase T0 — Contract & static twin *(2–3 weeks)*
1. Define `TwinNode` / `TwinEdge`; write a `SiteSyncPayload` → twin-graph mapper.
2. Obtain 3–5 real anonymized `SiteSyncPayload` samples (Solar-only, TPO, multi-battery, hub, no-CT).
3. Render a **static** topology graph with equipment metadata. No live data.
4. Confirm with an installer that the diagram matches physical reality.

**Exit:** a commissioned site renders recognizably from its config alone.

### Phase T1 — Live data & flow *(3–4 weeks)*
5. Wire SSE/WS/REST behind one adapter interface; implement the SSE lifecycle correctly (see `AC-GEN2-FAILURE-CASE-CATALOG.md` §6 — the session-lifecycle defects are all pre-documented).
6. Port `EnergyFlowFunctions.ts` for the summary view; drive edge animation from signed `powerW`.
7. Implement all degraded states from the mobile spec §9 (offline overlay, shimmer-before-first-event, no auto-reconnect, reset-on-terminal).

**Exit:** live site animates; all documented degraded states behave correctly.

### Phase T2 — Drill-down *(3–4 weeks)*
8. Node inspector backed by the **register map** — per-phase voltages/currents/powers, temperatures, firmware versions, uptime.
9. Fault overlay from the error codebook with persona-aware `description`/`howToFix`.
10. Historical charts via `/v1/sites/{siteId}/energy/{latest,production,summary}`.

**Exit:** click any node → see every metric that exists for it.

### Phase T3 — Simulator integration *(2 weeks)*
11. `--source=sim`; scenario picker; time-scrubber with the virtual clock.
12. Scenario authoring UI: set SOC, PV, load, grid state, inject faults — write back the same YAML the SIL consumes.

**Exit:** a scenario file can be authored, run, and visually verified end-to-end without hardware.

---

## 8. Open questions

1. **Who is the audience?** Installer diagnostics, homeowner engagement, internal QA, and sales demo imply very different products. Pick one primary.
2. **Where does it get site config?** `resi-commissioning` REST, the Kafka `SiteSyncPayload` event stream, or a snapshot store? Is there an existing read model?
3. **Live data path** — cloud SSE (works anywhere, 3–60 s) or local WS (sub-second, same-LAN only)? Both?
4. **Is there a Figma/design spec**, or is this greenfield? (Confluence `11481874436` is a *behavioral* spec, not visual.)
5. **PII/security** — the twin exposes address, customer names, serial numbers. What auth tier? Reuse the `administrator`/`installer`/`homeowner` persona split from the error display layer?
6. **CT placement & backup circuits** aren't in the commissioning payload. Extend commissioning capture, or render them as "unknown"?
7. **Multi-site / fleet view** in scope, or single-site only?
8. **Does `Predict Digital Twin`** (Confluence `11422531588`, space `OP`) or `[Database Documentation] Digital Twins` (`11243520037`, space `RBE`) already claim this name internally? Check for overlap before naming.
