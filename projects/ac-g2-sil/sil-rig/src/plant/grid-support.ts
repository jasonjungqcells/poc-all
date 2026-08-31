import type { ControlRegistry } from '../core/controls.js';

/**
 * IEEE 1547-2018 grid-support behaviour.
 *
 * Gen1 had no concept of any of this: its grid was a switch and two sliders.
 * But a real grid-tied inverter in North America is legally obliged to behave
 * in specific ways at specific voltages and frequencies, and the app has to
 * render the consequences -- which means app developers need to be able to
 * cause them.
 *
 * Three behaviours are modelled, each mapped to the SunSpec model that carries
 * its parameters, so the control names match what a commissioning engineer
 * already knows:
 *
 *   - **Ride-through / trip** (model 702 `AbnOpCatRtg`): whether an excursion
 *     is survived or trips the inverter. Category I trips soonest, Category III
 *     rides through longest.
 *   - **Enter service** (model 703): after a trip, voltage and frequency must
 *     be back inside a window for a sustained delay, and then power ramps in
 *     over a further period. This is why a system does not come back the
 *     instant the lights do, and it generates more support calls than almost
 *     anything else.
 *   - **Volt-VAR and volt-Watt** (models 705/706): curtail real power, or
 *     absorb/inject reactive power, as a function of voltage.
 *
 * IEEE 1547-2018 itself is paywalled, so the specific trip thresholds here are
 * defaults rather than certified values -- they are controls precisely so that
 * a site with a different grid profile can set its own.
 */

export type AbnormalCategory = 'I' | 'II' | 'III';

export type GridSupportPhase = 'connected' | 'tripped' | 'waiting' | 'ramping';

export interface GridSupportState {
  phase: GridSupportPhase;
  /** Seconds spent in the current phase. */
  elapsedS: number;
  /** Fraction of rated power currently permitted, 0..1. */
  powerLimit: number;
  /** Reactive power target as a fraction of rated VA, signed. */
  varTarget: number;
  /** Why the inverter tripped, if it did. */
  reason: string | null;
}

/**
 * Continuous operating band by abnormal category, in per-unit voltage.
 *
 * Category III is widest because 1547a-2020 broadened it explicitly to simplify
 * adoption.
 *
 * !! CALIBRATION CAVEAT !!
 * The continuous-operation voltage band below is deliberately identical across
 * all three categories. IEEE 1547-2018 Tables 12/13 are behind a paywall and
 * could not be verified, so rather than invent per-category numbers that would
 * look authoritative and be wrong, the categories are differentiated only on
 * the axis we can defend: ride-through *duration*.
 *
 * The consequence for test authors: asserting on the exact voltage at which a
 * category trips is NOT meaningful yet; asserting on how long an excursion is
 * tolerated IS. To calibrate against the real standard, see
 * NREL/TP-5D00-68575, then widen these bands per category.
 */
const VOLTAGE_BAND: Record<AbnormalCategory, { lo: number; hi: number }> = {
  I: { lo: 0.88, hi: 1.1 },
  II: { lo: 0.88, hi: 1.1 },
  III: { lo: 0.88, hi: 1.1 },
};

/**
 * Seconds an excursion outside the band is tolerated before tripping. This is
 * the axis that actually distinguishes the categories in this model.
 *
 * Note these are sub-second, so a scenario exercising ride-through must lower
 * `sim.tick_ms` (50 ms works) or the excursion cannot be resolved at all -- at
 * the default 1000 ms tick every category trips identically.
 */
const RIDE_THROUGH_S: Record<AbnormalCategory, number> = {
  I: 0.16,
  II: 0.32,
  III: 1.0,
};

/**
 * Frequency band. IEEE 1547-2018 allows continuous operation from 56.5 Hz to
 * 62 Hz with droop, a considerable widening from 1547-2003, which mandated a
 * trip at 59.3 Hz and 60.5 Hz. Both are selectable, because a site
 * commissioned to the older rule really does behave differently.
 */
const FREQ_BAND_2018 = { lo: 56.5, hi: 62.0 };
const FREQ_BAND_2003 = { lo: 59.3, hi: 60.5 };

export class GridSupport {
  private phase: GridSupportPhase = 'connected';
  private elapsedS = 0;
  private excursionS = 0;
  private reason: string | null = null;

  constructor(private readonly controls: ControlRegistry) {}

  reset(): void {
    this.phase = 'connected';
    this.elapsedS = 0;
    this.excursionS = 0;
    this.reason = null;
  }

  private category(): AbnormalCategory {
    const v = this.controls.str('grid.ieee1547.abnormal_category');
    return v === 'I' || v === 'II' || v === 'III' ? v : 'II';
  }

  private freqBand(): { lo: number; hi: number } {
    return this.controls.str('grid.ieee1547.revision') === '2003'
      ? FREQ_BAND_2003
      : FREQ_BAND_2018;
  }

  /**
   * Advance the state machine.
   *
   * Returns the fraction of rated power the inverter is allowed to produce and
   * the reactive target, which the plant then applies. Keeping this separate
   * from the plant means the power balance stays a pure function of its inputs.
   */
  tick(deltaMs: number, voltageV: number, frequencyHz: number): GridSupportState {
    const c = this.controls;
    const dt = deltaMs / 1000;
    this.elapsedS += dt;

    if (!c.bool('grid.ieee1547.enabled')) {
      this.phase = 'connected';
      this.reason = null;
      return { phase: 'connected', elapsedS: this.elapsedS, powerLimit: 1, varTarget: 0, reason: null };
    }

    const vNom = c.num('grid.v_nominal_v');
    const pu = vNom > 0 ? voltageV / vNom : 1;
    const cat = this.category();
    const vBand = VOLTAGE_BAND[cat];
    const fBand = this.freqBand();

    const vOut = pu < vBand.lo || pu > vBand.hi;
    const fOut = frequencyHz < fBand.lo || frequencyHz > fBand.hi;
    const outOfBand = vOut || fOut;

    switch (this.phase) {
      case 'connected': {
        if (outOfBand) {
          this.excursionS += dt;
          if (this.excursionS >= RIDE_THROUGH_S[cat]) {
            this.phase = 'tripped';
            this.elapsedS = 0;
            this.reason = vOut
              ? `voltage ${pu.toFixed(3)} pu outside ${vBand.lo}-${vBand.hi} pu (Category ${cat})`
              : `frequency ${frequencyHz.toFixed(2)} Hz outside ${fBand.lo}-${fBand.hi} Hz`;
          }
        } else {
          this.excursionS = 0;
        }
        break;
      }

      case 'tripped': {
        // Cease to energize. Recovery only begins once conditions are inside
        // the *enter service* window, which is deliberately narrower than the
        // trip band so the system does not chatter at the boundary.
        if (this.enterServiceOk(pu, frequencyHz)) {
          this.phase = 'waiting';
          this.elapsedS = 0;
        }
        break;
      }

      case 'waiting': {
        if (!this.enterServiceOk(pu, frequencyHz)) {
          // Any excursion restarts the clock: the delay must be *sustained*.
          this.phase = 'tripped';
          this.elapsedS = 0;
        } else if (this.elapsedS >= c.num('grid.enter_service.delay_s')) {
          this.phase = 'ramping';
          this.elapsedS = 0;
        }
        break;
      }

      case 'ramping': {
        if (!this.enterServiceOk(pu, frequencyHz)) {
          this.phase = 'tripped';
          this.elapsedS = 0;
        } else if (this.elapsedS >= c.num('grid.enter_service.ramp_s')) {
          this.phase = 'connected';
          this.excursionS = 0;
          this.reason = null;
        }
        break;
      }
    }

    return {
      phase: this.phase,
      elapsedS: this.elapsedS,
      powerLimit: this.powerLimit(pu),
      varTarget: this.varTarget(pu),
      reason: this.reason,
    };
  }

  private enterServiceOk(pu: number, frequencyHz: number): boolean {
    const c = this.controls;
    return (
      pu >= c.num('grid.enter_service.v_lo_pu') &&
      pu <= c.num('grid.enter_service.v_hi_pu') &&
      frequencyHz >= c.num('grid.enter_service.hz_lo') &&
      frequencyHz <= c.num('grid.enter_service.hz_hi')
    );
  }

  /** Permitted real power, 0..1, combining trip state and volt-Watt. */
  private powerLimit(pu: number): number {
    if (this.phase === 'tripped' || this.phase === 'waiting') return 0;

    // Linear ramp from zero to full over the enter-service ramp period.
    let limit = 1;
    if (this.phase === 'ramping') {
      const ramp = this.controls.num('grid.enter_service.ramp_s');
      limit = ramp > 0 ? Math.min(1, this.elapsedS / ramp) : 1;
    }

    if (this.controls.bool('grid.volt_watt.enabled')) {
      const start = this.controls.num('grid.volt_watt.v_start_pu');
      const end = this.controls.num('grid.volt_watt.v_end_pu');
      const floor = this.controls.num('grid.volt_watt.w_min_pct') / 100;
      if (pu > start && end > start) {
        const frac = Math.min(1, (pu - start) / (end - start));
        limit = Math.min(limit, 1 - frac * (1 - floor));
      }
    }
    return Math.max(0, Math.min(1, limit));
  }

  /**
   * Volt-VAR: a piecewise curve with a deadband around the reference voltage.
   * Positive absorbs, negative injects, as a fraction of rated VA.
   */
  private varTarget(pu: number): number {
    const c = this.controls;
    if (!c.bool('grid.volt_var.enabled')) return 0;
    if (this.phase === 'tripped' || this.phase === 'waiting') return 0;

    const ref = c.num('grid.volt_var.v_ref_pu');
    const dead = c.num('grid.volt_var.deadband_pu');
    const slopeEnd = c.num('grid.volt_var.v_slope_end_pu');
    const maxVar = c.num('grid.volt_var.var_max_pct') / 100;

    const delta = pu - ref;
    const magnitude = Math.abs(delta);
    if (magnitude <= dead) return 0;

    const span = slopeEnd - dead;
    if (span <= 0) return 0;
    const frac = Math.min(1, (magnitude - dead) / span);
    return Math.sign(delta) * frac * maxVar;
  }

  state(): GridSupportState {
    return {
      phase: this.phase,
      elapsedS: this.elapsedS,
      powerLimit: 1,
      varTarget: 0,
      reason: this.reason,
    };
  }
}
