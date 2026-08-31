# AC Gen2 SIL — Web Console Development Plan

**A browser cockpit for the SIL rig's control plane.** Everything the CLI can do, clickable —
and nothing more.

Status: **Phases 1–8 complete**, plus a scenario-browser redesign — see §7 and §8.
Companion documents: `AC-GEN2-SIL-CONTROL-PLANE.md` (the API being wrapped),
`AC-GEN2-MPU-MCU-SIL-PLAN.md` §14 (why the cockpit and the engine are separate),
`README.md` §6 (control plane reference).

---

## 1. What this is, and what it deliberately is not

The rig already has a complete control surface: 197 controls, 157 scenarios, a virtual clock, a
fault codebook, SPI/CAN inspectors and snapshot save/restore — all reachable over HTTP on
`:9114` and from the `sil ctl` CLI. What it does not have is a way to *see* the machine while it
runs. Reading `GET /state` in a terminal loop is a poor substitute for watching power flows
settle, a fault latch, and a scenario timeline advance.

This project builds that view. It is a **thin client of the control API** — a renderer with no
state of its own.

**It is not:**

- **Not a second engine.** No simulation logic in the browser. §14 of the SIL plan settles this:
  a browser-resident engine sits above the IPC bus, cannot run headless in CI, cannot be reached
  by the iOS/Android installers, and cannot be deterministic in an event loop driven by wall
  time.
- **Not a required dependency.** The rig starts, serves `:9112`, and runs 157 scenarios in CI
  with the console never loaded. It is opt-in observability.
- **Not a place where new capability lands.** Features arrive in the control API first. The
  console is downstream of it, always.

### The parity rule

> Any HMI/GUI panel must be a thin client of the control API. If the CLI can't do it, the panel
> doesn't get to either.
> — `AC-GEN2-SIL-CONTROL-PLANE.md` §18

This is the load-bearing constraint of the whole project, and it exists for a specific failure
mode. A QA engineer reproduces a bug by clicking through a panel; the bug is filed as a
screenshot and a sentence; the developer cannot reproduce it; the ticket dies. The rig's answer
is that the reproducible artifact is a **YAML scenario file**, and every session in the console
must be exportable as one (Phase 6). If a control is only reachable by clicking, that artifact
is incomplete and the console has become a toy.

Two mechanisms enforce it rather than merely asserting it:

1. **The console never calls anything but the control API.** No private module imports, no
   direct engine access. It runs against a rig on another host just as well as a local one.
2. **A CI check (Phase 8)** asserts every action the console can issue has a CLI equivalent.

---

## 2. Architecture

```
     browser
        │  http://localhost:9114/          static assets (built Vue SPA)
        │  http://localhost:9114/control   REST — read/write controls
        │  http://localhost:9114/events    SSE  — live push
        ▼
┌────────────────────────────────────────────────────┐
│  CONTROL SERVER  :9114   (express, plain HTTP)     │
│  buildControlApi()  ·  buildEventStream()  ·  web/ │
└───────────────────────────┬────────────────────────┘
                            │ ControlRegistry — the single mutation path
┌───────────────────────────▼────────────────────────┐
│  SIMULATION ENGINE (headless)                      │
│  clock · seeded RNG · plant · faults · MCU · CAN   │
└───────────────────────────┬────────────────────────┘
                            ▼
              DEVICE API :9112  ← the installer apps and Web HMI
```

The console is served from the **control port, not the device port**. This matters: `:9112` must
stay byte-identical to the board's surface, because "clients run unmodified" is the property
that justifies the whole seam. Adding a console route there would put a non-device endpoint on
the device API. `:9114` is also already the port intended to be firewalled independently.

### Stack

| Choice | Rationale |
|---|---|
| **Vue 3 + TypeScript** | Matches `qcells-hems-frontend-vue`. The team already reads and writes it, and the energy-flow renderer there is a future borrow (Phase 7+). |
| **Vite** | Dev server with HMR, proxying `/control` and `/events` to `:9114`; production build is a static bundle with no runtime dependency. |
| **No component library** | The control browser is a form generator over `ControlDef`. A design system would be more constraint than help, and adds a large dependency to a dev tool. |
| **No state library** | Server state is the only state. `ref`/`reactive` over the SSE feed is sufficient; a store would tempt local caches that drift from the rig. |

The build output lands in `sil-rig/dist/web/` and is served by the control server, so a built rig
is a single `npm start` with no second process.

---

## 3. Control API gaps closed by this work

The console is a client of the existing API, but six gaps made it unbuildable as-is. Each is a
control-plane feature in its own right — useful from `curl` and the CLI, not only from the
browser.

| # | Gap | Fix | Phase |
|---|---|---|---|
| 1 | **No push channel.** The control API is request/response only. A live view would have to poll `/state`, which at 1 Hz across 8,106 metrics is wasteful and always slightly stale. | `GET /events` — Server-Sent Events carrying `hello`, `tick`, `control`, `fault`, `scenario`. SSE over WebSocket because the flow is one-way and it survives proxies, reconnects itself, and is trivially consumable by `curl`. | 1 |
| 2 | **No static hosting.** The control app has a catch-all 404 and no asset route. | `express.static(dist/web)` plus an SPA index fallback, mounted *after* the API router so no route is shadowed. | 1 |
| 3 | **No session → artifact path.** `GET /control/diff` shows what changed but there is no way to turn it into the scenario file that gets attached to a ticket. | `POST /scenario/export` — renders the current diff (plus clock and seed) as scenario YAML. | 6 |
| 4 | **Scenario run state is coarse.** `scenarios.state()` reports the loaded scenario but not step-by-step progress, so a timeline view has nothing to render. | Extend `state()` with step index, due times, and per-expectation results. | 4 |
| 5 | **No scenario stop.** A running timeline can only be replaced, not aborted. | `POST /scenarios/stop`. | 4 |
| 6 | **No scenario reload.** Found while testing the export round-trip: a scenario exported to `scenarios/` is invisible until the process restarts, which breaks the edit-and-rerun loop the export feature exists to enable. | `POST /scenarios/reload` — re-reads the scenario directory in place. | 6 |

---

## 4. Phases

Each phase ends in something demonstrable. Phases 1–4 (~5 days) are already a useful product;
5–8 are what make it a replacement for reading JSON.

### Phase 1 — Foundation *(~1 day)*

The plumbing, with nothing on top of it.

- `src/control/events.ts` — SSE endpoint. Coalesces control changes into batches, throttles tick
  events (the clock ticks at up to 1 kHz under time acceleration; the browser needs ~4 Hz),
  sends keep-alive comments, and drops cleanly on disconnect.
- Static mount and SPA fallback on the control server, active only when a build exists.
- `web/` — Vite + Vue 3 + TS scaffold, dev proxy to `:9114`.
- A **typed API client** mirroring every control route, generated by hand from `control/api.ts`
  and sharing the engine's own `ControlDef` types via a direct type import. One place to change
  when a route changes.
- npm scripts: `web:dev`, `web:build`, and `build` wiring.

**Done when:** `curl -N localhost:9114/events` streams, the Vite dev server renders a page
showing live clock and plant values, and `npm run web:build` output is served by the rig itself.

### Phase 2 — Shell and live state *(~1 day)*

- Header: connection state, seed, loaded scenario, virtual clock, rate, tick count.
- Transport bar: pause / resume / step 1 s / 1 m / 1 h — `POST /clock/*`, the same calls
  `sil clock` makes.
- State panel from the SSE feed: plant power flows (PV, battery, load, grid, SoC), active faults,
  MCU online/version/uptime, site serial and commissioning status.
- Energy conservation shown explicitly: `grid_w` and `battery_w` render as **derived, read-only**,
  because Gen1's independent sliders happily held PV 6 kW + load 1 kW + grid import 5 kW and that
  is exactly the class of nonsense this rig refuses to produce.

### Phase 3 — Control browser *(~2 days)*

The largest piece, and the one that carries the parity rule.

- Group tree from `GET /control` (`groups()` + counts), plus fuzzy search across id and
  description.
- **Widgets generated from `ControlDef`**, not hand-written per control — 197 controls today and
  the register maps keep growing. `number`/`integer` → bounded input honouring `min`/`max`/`unit`;
  `boolean` → toggle; `enum` → select over `values`; `duration` → text accepting `30s`/`5m`;
  `json` → validated textarea; `action` → button issuing an invoke.
- `readOnly` controls render as values with a note explaining what derives them.
- Edits stage locally and commit as one `PATCH /control`, so a multi-field change is a single
  atomic write and one line in the diff.
- Dirty sidebar from `GET /control/diff`: everything differing from defaults, with revert.

### Phase 4 — Scenarios *(~1 day)*

- List from `GET /scenarios` with tag filter and search across 157 files.
- Detail view: raw YAML, `extends` chain resolved, timeline steps, declared expectations.
- Load, and stop (gap 5).
- **Running timeline**: current step highlighted, elapsed virtual time, expectation results as
  pass/fail as they resolve (gap 4).

### Phase 5 — Faults *(~1 day)*

- Catalog from `GET /fault` — the cloud error-code table — searchable, with inject (device,
  level) and clear, and clear-all.
- **CAN flag matrix** from `GET /can/faults`: domain × severity × PCS, showing which of the
  addressable bits are set. This is the Gen1 fault-manager tab, except every bit is also
  clearable and every one has a name.
- **Raw bitmask entry** per flag byte — the Gen1 escape hatch, kept deliberately: a taxonomy
  always lags the firmware, and the hex path never does.

### Phase 6 — Repro bundle *(~1 day)*

Where the parity rule pays off.

- Snapshot save (`GET /snapshot` → download) and restore (upload → `POST /snapshot/restore`).
- **Export as scenario YAML** (gap 3): the current diff as a runnable scenario file, the artifact
  that goes on the ticket.
- **Copy as CLI** on every action: each click surfaces the equivalent `sil ctl …` command, which
  makes the parity rule visible instead of merely documented, and teaches the CLI by using the
  GUI.

### Phase 7 — Bus inspectors *(~1 day, optional)*

- SPI: frame hex dump with decoded sync/cmd/address/len/CRC and validity, register read by name,
  standard vs 4k mode.
- CAN: register search over 833 registers, read, and write with rejection surfaced.

Optional because both are already usable via `curl` and are the least-used surfaces day to day.

### Phase 8 — Hardening *(~1 day)*

- **Parity check in CI**: enumerate the actions the console can issue and assert each maps to a
  CLI command. A GUI-only capability fails the build.
- Smoke test: serve the built bundle, assert index and asset routes and that no API route is
  shadowed by the static mount.
- README §6 gains a console section; this document's status moves to complete.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| **The console becomes the primary interface and the CLI rots.** | The Phase 8 parity check fails the build on GUI-only capability; Phase 6 "copy as CLI" keeps the CLI in front of the user. |
| **SSE floods the browser** under time acceleration (clock ticks far faster than 60 Hz). | Server-side throttle and coalescing in Phase 1 — the browser sees ~4 Hz regardless of rate. |
| **Rendering 197 controls (and growing) hurts.** | Widgets are generated from `ControlDef`; a new control needs no console change. Long groups virtualise if profiling requires it. |
| **Console state drifts from rig state.** | No client-side cache of server state: SSE is the source, `hello` reseeds on every reconnect. |
| **Build coupling** — a stale `dist/web` served silently. | Static mount only activates when a build exists; otherwise `/` returns a message pointing at `npm run web:build`. |

---

## 6. Estimate

| Phase | Days |
|---|---|
| 1 Foundation | 1 |
| 2 Shell + live state | 1 |
| 3 Control browser | 2 |
| 4 Scenarios | 1 |
| 5 Faults | 1 |
| 6 Repro bundle | 1 |
| 7 Bus inspectors (optional) | 1 |
| 8 Hardening | 1 |
| **Total** | **~9** |

Phases 1–4 (~5 days) deliver a console that can watch a run, change any control, and drive any
scenario — the point at which it displaces reading `GET /state` in a terminal.

---

## 7. What shipped

All eight phases are implemented, and the gaps in §3 are closed.

### Control plane additions

| Surface | Route | CLI |
|---|---|---|
| Event stream | `GET /events`, `GET /events/stats` | `curl -N .../events` |
| Scenario stop | `POST /scenarios/stop` | `sil scenario stop` |
| Scenario reload | `POST /scenarios/reload` | `sil scenario reload` |
| Session export | `POST /scenario/export[?format=yaml]` | `sil scenario export [file]` |
| Static console | `GET /` and asset routes | — |

`ScenarioEngine.state()` now reports step-by-step progress (`steps`, `expectations`,
`currentStep`, `completedSteps`, `durationMs`, `stopped`) rather than just the loaded name.
The CLI also gained `spi` and `can` inspector groups and `sil ctl patch -` (stdin), so the
bus views and bulk edits have CLI equivalents.

### Console

Six views under `sil-rig/web/`: state, controls, scenarios, faults, repro, buses. Vue 3 +
Vite, no runtime dependency on rig code, served by the control server on :9114.

### Parity enforcement

`web/src/api/actions.ts` declares every mutating console action with its route and CLI
equivalent; `test/parity.test.ts` parses `control/api.ts`, `control/events.ts` and `cli.ts`
and fails the build if the console can do something the CLI cannot, or if it imports rig
runtime code. Verified by deliberately adding a GUI-only action and confirming the test
caught it.

### Verification

- `npm run typecheck` (tsc + vue-tsc) clean.
- `npm test` — 22 passing, including the 5 parity tests.
- `npm run web:build` — ~206 KB JS, ~12.5 KB CSS.
- `test/smoke.sh` — 42 passing, including 9 new event-stream and console checks. The 4
  failures are pre-existing and unrelated: the sibling schema repo supplying
  `factory_register_map.json` is absent, so the register map loads 1 register instead of 520.
- Export → reload → load round-trip reproduced a 9 % SoC and re-injected fault `e014`.
- Headless render of the built bundle: all six views mount and load live data from a running
  rig with no console errors.

---

## 8. Follow-up: making the scenario catalog choosable

The first cut of the scenarios view was honest and unusable. It listed 157 snake_case
identifiers in a 230-pixel rail with no descriptions, and filtered them with a wall of 89 tag
buttons — a filter list longer than most result lists. Choosing a scenario meant clicking one,
reading YAML in a third column, and clicking the next.

Three things were wrong, and only one of them was cosmetic.

**The corpus was described in the authors' vocabulary, not the reader's.** 88 tags, 80 of which
appear once or twice. `src/scenario/facets.ts` folds them onto two axes people actually think
in: a *kind* (what sort of run this is — every scenario has exactly one) and *areas* (what it
touches — any number). Seven kinds, nine areas, each with a one-line hint, and nothing falls
through: the fallback kind is `nominal`, which is a real answer rather than a bucket labelled
"other". `test/facets.test.ts` asserts every bucket is used and that none swallows more than
60 % of the corpus, so the taxonomy cannot quietly rot back into a single big pile.

**The list withheld the deciding fact.** 96 of the 157 scenarios are static rig setups with no
timeline at all; the other 61 are timed runs. Name and tags never said which. `list()` now
resolves `extends` and reports `kind`, `areas`, `steps`, `expects` and `durationMs`, so a card
can say "20m run · 2 steps · 2 checks" or "static setup" before you open it.

**The filters lived only in the browser.** Under the parity rule that is not allowed, so the
mapping is server-side and the console renders what the rig sends. `sil scenario list --kind
failure --area grid --timed` is the same query the chips build, and the console prints that
exact command under the filter row as you click.

| Before | After |
|---|---|
| 89 filter buttons, single raw tag | 21 chips on 3 labelled rows, each with a hint |
| Identifiers only | Cards: name, description, kind badge, run shape, parent |
| Counts fixed to the whole corpus | Counts recomputed against the other active filters |
| YAML as the primary detail | Controls, timeline and checks in words; YAML behind a toggle |
| Raw tags were the filter | Raw tags on the selected scenario, still filterable, no wall |
| Three narrow columns | Full-width run banner over a card grid and an inspector |

The filter row also renders its own CLI equivalent, which is the same trick every mutating
button already uses: the fastest way to teach the CLI is to show it at the moment of clicking.

Verified by driving the built bundle headlessly against a live rig: 31 checks covering card
rendering, each filter axis, cross-filtered counts, the CLI hint, preview contents, the YAML
toggle, tag filtering, and an actual load reaching the rig and coming back as a run banner.
