import type { Clock } from '../core/clock.js';
import type { ControlRegistry } from '../core/controls.js';
import type { Rng } from '../core/rng.js';
import { LOAD_PROFILES, PV_PROFILES } from './profiles.js';
import { GridSupport, type GridSupportState } from './grid-support.js';

/**
 * Contractual constant. Powers below this magnitude read as zero.
 *
 * Order matters and is part of the shared contract with the mobile apps and the
 * Vue HEMS: divide to kW, apply the deadband, THEN round. Applying the deadband
 * after rounding changes which flow cases fire, and a simulator that disagrees
 * with the fleet is worse than no simulator.
 */
export const POWER_DEAD_BAND_KW = 0.1;

export interface PlantState {
  pvW: number;
  extPvW: number;
  totalPvW: number;
  loadW: number;
  batteryW: number;
  gridW: number;
  socPct: number;
  sohPct: number;
  gridStatus: number;
  gridVoltageV: number;
  gridFrequencyHz: number;
  batteryTempC: number;
  energyControl: number;
  curtailedW: number;
  /** Set when islanded demand exceeds available supply. */
  loadShedW: number;
  /** IEEE 1547 ride-through / enter-service state. */
  gridSupport: GridSupportState;
  /** Reactive power target from the volt-VAR curve. */
  reactiveVar: number;
}

/**
 * The physical model.
 *
 * Operators set causes (irradiance, demand, grid presence, work mode) and read
 * effects (grid power, battery power, SoC). `plant.grid_w` and
 * `plant.battery_w` are deliberately read-only in the registry: allowing a
 * direct write would let a scenario express a state that violates conservation
 * of energy, which is exactly the flaw that makes the existing cloud simulator
 * unusable for UI correctness work.
 */
export class Plant {
  private state: PlantState;
  readonly gridSupport: GridSupport;

  constructor(
    private readonly controls: ControlRegistry,
    private readonly clock: Clock,
    private readonly rng: Rng,
  ) {
    this.gridSupport = new GridSupport(controls);
    this.state = this.blankState();
  }

  private blankState(): PlantState {
    return {
      pvW: 0,
      extPvW: 0,
      totalPvW: 0,
      loadW: 0,
      batteryW: 0,
      gridW: 0,
      socPct: this.controls.num('plant.battery.soc_pct'),
      sohPct: this.controls.num('plant.battery.soh_pct'),
      gridStatus: Number(this.controls.get('plant.grid.status')),
      gridVoltageV: this.controls.num('plant.grid.voltage_v'),
      gridFrequencyHz: this.controls.num('plant.grid.frequency_hz'),
      batteryTempC: this.controls.num('plant.battery.temperature_c'),
      energyControl: Number(this.controls.get('plant.energy_control')),
      curtailedW: 0,
      loadShedW: 0,
      gridSupport: this.gridSupport.state(),
      reactiveVar: 0,
    };
  }

  snapshot(): PlantState {
    return { ...this.state };
  }

  /** Advance the model by `deltaMs` of virtual time. */
  tick(deltaMs: number): PlantState {
    const c = this.controls;
    const hour = this.localHour();

    // --- Sources -----------------------------------------------------------
    const capacityW = c.num('site.panel_system_size_w');
    const pvProfile = c.str('plant.pv_profile');
    const loadProfile = c.str('plant.load_profile');
    const profileCtx = {
      hour,
      capacityW,
      variability: c.num('plant.pv.cloud_variability'),
      dayOfYear: this.localDayOfYear(),
      rng: this.rng,
    };

    let pvW = c.num('plant.pv_w');
    if (pvProfile !== 'custom') {
      const fn = PV_PROFILES[pvProfile];
      if (fn) {
        // Clamp to the control's own bounds. A profile is a generator, not an
        // authority: if it exceeds the declared range the write would throw and
        // take the whole tick -- and with it the scenario engine -- down.
        pvW = clampToControl(c, 'plant.pv_w', fn(profileCtx));
        c.set('plant.pv_w', round(pvW), { internal: true });
      }
    }

    let loadW = c.num('plant.load_w');
    if (loadProfile !== 'custom') {
      const fn = LOAD_PROFILES[loadProfile];
      if (fn) {
        loadW = clampToControl(c, 'plant.load_w', fn(profileCtx));
        c.set('plant.load_w', round(loadW), { internal: true });
      }
    }

    const extPvW = c.num('plant.extpv_w');
    // Summed before unit conversion, per the shared telemetry contract.
    let totalPvW = pvW + extPvW;

    // Inverter output ceiling clips PV before anything else sees it.
    const inverterMaxW = c.num('plant.inverter.max_output_w');
    let curtailedW = 0;
    if (totalPvW > inverterMaxW) {
      curtailedW = totalPvW - inverterMaxW;
      totalPvW = inverterMaxW;
    }

    // A reversed consumption CT is a real and frequently-missed field error.
    // The physics are unchanged; the measurement sign is what flips.
    const ctState = c.str('site.ct.consumption_pair1');
    const measuredLoadW = ctState === 'Reversed' ? -loadW : ctState === 'NotInstalled' ? 0 : loadW;

    // --- IEEE 1547 grid support -------------------------------------------
    // Ride-through, trip, and enter-service run before dispatch, because a
    // tripped inverter has ceased to energize and therefore has no dispatch to
    // make. Load is then served entirely from the grid, which is exactly what a
    // homeowner sees: the lights are on, and the system says it is producing
    // nothing for the next five minutes.
    const support = this.gridSupport.tick(
      deltaMs,
      c.num('plant.grid.voltage_v'),
      c.num('plant.grid.frequency_hz'),
    );
    const ceased = support.powerLimit <= 0;
    if (support.powerLimit < 1) {
      const permittedW = totalPvW * support.powerLimit;
      curtailedW += totalPvW - permittedW;
      totalPvW = permittedW;
    }

    // --- Battery capability ------------------------------------------------
    const offGrid = Number(c.get('plant.grid.status')) !== 0;
    const mode = Number(c.get('plant.energy_control'));
    const derate = 1 - c.num('plant.battery.derate_pct') / 100;
    const thermalDerate = this.thermalDerate(c.num('plant.battery.temperature_c'));
    const batteryPresent = c.num('site.battery_count') > 0;

    const usable = batteryPresent && !ceased;
    const maxChargeW = usable ? c.num('plant.battery.max_charge_w') * derate * thermalDerate : 0;
    const maxDischargeW = usable ? c.num('plant.battery.max_discharge_w') * derate * thermalDerate : 0;

    const soc = c.num('plant.battery.soc_pct');
    const minSoc = c.num('plant.battery.min_soc_pct');
    const chargeHeadroom = soc >= 100 ? 0 : maxChargeW;
    // Off-grid the reserve floor is ignored: the battery is the only source left.
    const dischargeHeadroom = soc <= (offGrid ? 0 : minSoc) ? 0 : maxDischargeW;

    // --- Dispatch ----------------------------------------------------------
    // Sign convention, contractual: battery > 0 discharging, < 0 charging.
    const surplusW = totalPvW - loadW;
    let batteryW = 0;

    switch (mode) {
      case 0: // STANDBY
        batteryW = 0;
        break;
      case 3: // FORCE_CHARGE
        batteryW = -chargeHeadroom;
        break;
      case 4: // FORCE_DISCHARGE
        batteryW = dischargeHeadroom;
        break;
      case 1: // AUTO -- self consumption
      default:
        batteryW = surplusW > 0 ? -Math.min(surplusW, chargeHeadroom) : Math.min(-surplusW, dischargeHeadroom);
        break;
    }

    // --- Grid / islanding --------------------------------------------------
    let gridW = 0;
    let loadShedW = 0;

    if (offGrid) {
      // Islanded: no grid term, so supply must equal demand. Whatever cannot be
      // met by PV plus battery is shed, which is what a real system does before
      // it shuts down.
      const availableW = totalPvW + Math.max(0, batteryW);
      if (availableW < loadW) {
        loadShedW = loadW - availableW;
      } else if (totalPvW > loadW) {
        // Excess PV with nowhere to go is curtailed, not exported.
        const absorbedW = Math.min(totalPvW - loadW, chargeHeadroom);
        batteryW = -absorbedW;
        curtailedW += totalPvW - loadW - absorbedW;
      }
      gridW = 0;
    } else {
      // Power balance: pv + batteryDischarge + gridImport = load
      gridW = loadW - totalPvW - batteryW;

      const exportLimitW = c.num('plant.grid.export_limit_w');
      if (-gridW > exportLimitW) {
        // Export cap forces curtailment of the excess.
        const excessW = -gridW - exportLimitW;
        curtailedW += excessW;
        totalPvW -= excessW;
        gridW = -exportLimitW;
      }
    }

    // --- Integrate SoC -----------------------------------------------------
    const capacityWh = c.num('plant.battery.capacity_wh') * (c.num('plant.battery.soh_pct') / 100);
    let newSoc = soc;
    if (capacityWh > 0 && batteryW !== 0) {
      const deltaWh = (batteryW * (deltaMs / 3_600_000));
      newSoc = clamp(soc - (deltaWh / capacityWh) * 100, 0, 100);
      c.set('plant.battery.soc_pct', roundTo(newSoc, 2), { internal: true });
    }

    // --- Publish derived values -------------------------------------------
    c.set('plant.grid_w', round(gridW), { internal: true });
    c.set('plant.battery_w', round(batteryW), { internal: true });

    this.state = {
      pvW: round(pvW),
      extPvW: round(extPvW),
      totalPvW: round(totalPvW),
      loadW: round(measuredLoadW),
      batteryW: round(batteryW),
      gridW: round(gridW),
      socPct: roundTo(newSoc, 2),
      sohPct: c.num('plant.battery.soh_pct'),
      gridStatus: Number(c.get('plant.grid.status')),
      gridVoltageV: c.num('plant.grid.voltage_v'),
      gridFrequencyHz: c.num('plant.grid.frequency_hz'),
      batteryTempC: c.num('plant.battery.temperature_c'),
      energyControl: mode,
      curtailedW: round(curtailedW),
      gridSupport: support,
      reactiveVar: roundTo(support.varTarget * c.num('plant.inverter.max_output_w'), 1),
      loadShedW: round(loadShedW),
    };

    return this.state;
  }

  /** Li-ion style capability curve: reduced at both temperature extremes. */
  private thermalDerate(tempC: number): number {
    if (tempC <= -20) return 0;
    if (tempC < 0) return 0.3;
    if (tempC < 10) return 0.7;
    if (tempC <= 40) return 1;
    if (tempC <= 50) return 0.7;
    if (tempC <= 60) return 0.4;
    return 0;
  }

  private localHour(): number {
    const tz = this.controls.str('sim.timezone') || 'UTC';
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
      }).formatToParts(this.clock.now());
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      // Intl renders midnight as hour 24 in some locales; normalise.
      return (get('hour') % 24) + get('minute') / 60 + get('second') / 3600;
    } catch {
      const d = this.clock.now();
      return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    }
  }

  private localDayOfYear(): number {
    const d = this.clock.now();
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    return Math.floor((d.getTime() - start) / 86_400_000);
  }
}

/**
 * Convert W to kW, apply the deadband, then round -- in that order.
 * Exported so the API layer and any twin renderer use the identical function
 * rather than re-deriving it and drifting.
 */
export function toDisplayKw(watts: number, decimals = 1): number {
  const kw = watts / 1000;
  const deadbanded = Math.abs(kw) < POWER_DEAD_BAND_KW ? 0 : kw;
  return roundTo(deadbanded, decimals);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  // HALF_UP, matching the server-side BigDecimal contract.
  return Math.sign(v) * Math.round(Math.abs(v) * f) / f;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Clamp a generated value into a control's declared range. */
function clampToControl(c: ControlRegistry, id: string, value: number): number {
  const def = c.definition(id);
  const lo = typeof def?.min === 'number' ? def.min : -Infinity;
  const hi = typeof def?.max === 'number' ? def.max : Infinity;
  return Math.min(hi, Math.max(lo, value));
}
