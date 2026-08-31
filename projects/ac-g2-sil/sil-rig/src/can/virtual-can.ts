import type { Clock } from '../core/clock.js';
import type { ControlRegistry } from '../core/controls.js';
import type { Rng } from '../core/rng.js';
import type { Plant } from '../plant/plant.js';
import { loadRegisterMap, metricBounds } from '../mcu/registers.js';
import type { MetricDef, RegisterDef, RegisterMapModel } from '../mcu/registers.js';
import {
  CAN_FLAG_DOMAINS,
  CAN_SEVERITIES,
  CanFlagBank,
  parseFlagCode,
  type CanFlagDomain,
  type CanSeverity,
} from './flags.js';

export class CanError extends Error {
  constructor(message: string, readonly kind: CanErrorKind) {
    super(message);
    this.name = 'CanError';
  }
}

export type CanErrorKind =
  | 'bus_off'
  | 'offline'
  | 'arbitration_lost'
  | 'tx_timeout'
  | 'form_error'
  | 'nack';

export interface CanRead {
  register: string;
  address: string;
  pcs: number | null;
  timestamp: string;
  metrics: Record<string, number | string | boolean | null>;
}

/** `P01_...` / `P02_...` prefix identifies which PCS a register belongs to. */
function pcsOf(registerId: string): number | null {
  const m = /^P(\d{2})_/.exec(registerId);
  return m ? Number(m[1]) : null;
}

/** Split `Grid_Fault_Flag3` into its parts, or undefined if not a flag metric. */
function asFlagMetric(
  metricId: string,
): { domain: CanFlagDomain; severity: CanSeverity; byte: number } | undefined {
  const m = /^(Grid|PCS|BDC|MCU)_(Fault|Warning|Alarm)_Flag(\d)$/.exec(metricId);
  if (!m) return undefined;
  return {
    domain: m[1] as CanFlagDomain,
    severity: m[2] as CanSeverity,
    byte: Number(m[3]),
  };
}

/**
 * Virtual CAN bus carrying the `qcells_ess_g4` register map.
 *
 * This is the second of the two buses the MPU talks to. Where the SPI link
 * reaches the Qcells MCU, CAN reaches the PCS units (P01/P02), their BDC and
 * inverter CPUs, and the JF2 battery stack -- 833 registers and 2,985 metrics.
 *
 * Two things make it worth modelling separately rather than folding into
 * `VirtualMcu`:
 *
 *  1. **Dual PCS.** Almost every register is duplicated as `P01_*` and `P02_*`.
 *     A site may have one or two units, and "unit 2 is dark" is a real and
 *     commonly-mishandled condition.
 *  2. **Bitmask faults.** The PCS reports faults as flag *bytes*, not codes, so
 *     fault injection here is bit manipulation rather than a code lookup.
 */
export class VirtualCan {
  readonly model: RegisterMapModel;
  /** One flag bank per PCS unit, keyed by unit number. */
  private readonly flags = new Map<number, CanFlagBank>();
  private readonly rng: Rng;
  private bootedAt: number;
  private readonly staleCache = new Map<string, CanRead>();

  constructor(
    private readonly controls: ControlRegistry,
    private readonly clock: Clock,
    private readonly plant: Plant,
    rng: Rng,
    registerMapPath?: string,
  ) {
    this.model = loadRegisterMap(registerMapPath, 'qcells_ess_g4');
    this.rng = rng.derive('can');
    this.bootedAt = clock.now().getTime();
  }

  reboot(): void {
    this.bootedAt = this.clock.now().getTime();
    this.staleCache.clear();
  }

  uptimeMs(): number {
    return Math.max(0, this.clock.now().getTime() - this.bootedAt);
  }

  /** Number of PCS units the site is configured with (1 or 2). */
  pcsCount(): number {
    return this.controls.num('can.pcs_count');
  }

  bank(pcs: number): CanFlagBank {
    let existing = this.flags.get(pcs);
    if (!existing) {
      existing = new CanFlagBank();
      this.flags.set(pcs, existing);
    }
    return existing;
  }

  /**
   * Transport-level faults, applied before every operation.
   *
   * `bus_off` is the one that matters most: a real CAN controller that
   * accumulates enough transmit errors takes itself off the bus entirely and
   * stays there until something resets it. Applications that assume a read can
   * only ever be slow, never permanently absent, break here.
   */
  private checkLink(): void {
    if (!this.controls.bool('can.online')) {
      throw new CanError('CAN interface is down', 'offline');
    }
    if (this.controls.bool('can.bus_off')) {
      throw new CanError('CAN controller is bus-off after excessive TX errors', 'bus_off');
    }
    if (this.rng.chance(this.controls.num('can.arbitration_loss_rate_pct'))) {
      throw new CanError('lost arbitration; frame not transmitted', 'arbitration_lost');
    }
    if (this.rng.chance(this.controls.num('can.tx_timeout_rate_pct'))) {
      throw new CanError('CAN transmit timed out', 'tx_timeout');
    }
    if (this.rng.chance(this.controls.num('can.form_error_rate_pct'))) {
      throw new CanError('CAN form error in received frame', 'form_error');
    }
  }

  resolveRegister(key: string): RegisterDef | undefined {
    if (this.model.byName.has(key)) return this.model.byName.get(key);
    if (this.model.registers.has(key)) return this.model.registers.get(key);
    // The map stores g4 addresses zero-padded (`0x00305000`) but the loader
    // normalises them, so accept either spelling.
    if (/^0x/i.test(key)) {
      return this.model.registers.get(`0x${Number.parseInt(key, 16).toString(16).toUpperCase()}`);
    }
    return undefined;
  }

  readRegister(key: string): CanRead {
    this.checkLink();
    const def = this.resolveRegister(key);
    if (!def) throw new CanError(`unknown CAN register: ${key}`, 'nack');

    const pcs = pcsOf(def.id);
    if (pcs !== null && pcs > this.pcsCount()) {
      throw new CanError(`PCS ${pcs} is not present at this site`, 'tx_timeout');
    }
    if (pcs !== null && this.controls.bool(`can.pcs${pcs}.silent`)) {
      throw new CanError(`PCS ${pcs} is not responding on the bus`, 'tx_timeout');
    }

    const mode = this.effectiveMode(def);
    if (mode === 'stale') {
      const cached = this.staleCache.get(def.registerAddress);
      if (cached) return cached;
    }

    const metrics: CanRead['metrics'] = {};
    for (const metric of def.metrics) {
      metrics[metric.id] = this.metricValue(def, metric, mode, pcs);
    }

    const read: CanRead = {
      register: def.id,
      address: def.registerAddress,
      pcs,
      timestamp: this.clock.nowIso(),
      metrics,
    };

    if (mode === 'stale' && !this.staleCache.has(def.registerAddress)) {
      this.staleCache.set(def.registerAddress, read);
    }
    return read;
  }

  writeRegister(key: string, values: Record<string, number>): { register: string; written: string[] } {
    this.checkLink();
    if (this.controls.bool('can.write_reject')) {
      throw new CanError('PCS rejected the CAN write', 'nack');
    }
    const def = this.resolveRegister(key);
    if (!def) throw new CanError(`unknown CAN register: ${key}`, 'nack');

    const pcs = pcsOf(def.id);
    const written: string[] = [];
    for (const [metricId, value] of Object.entries(values)) {
      if (!def.metrics.some((m) => m.id === metricId)) continue;

      // Writing a flag byte goes to the flag bank, so that the raw hex path and
      // the named-bit path stay the same underlying state. This is the Gen1
      // "Error tab" escape hatch, preserved.
      const flag = asFlagMetric(metricId);
      if (flag && pcs !== null) {
        this.bank(pcs).setByte(flag.domain, flag.severity, flag.byte, Number(value));
      } else {
        this.controls.set(`can.register.${def.registerAddress}.${metricId}`, value);
      }
      written.push(metricId);
    }
    return { register: def.id, written };
  }

  /** Set or clear one named fault bit, e.g. `G01005F`. */
  setFlagCode(code: string, on: boolean): boolean {
    const ref = parseFlagCode(code);
    if (!ref) return false;
    this.bank(ref.pcs).setBit(ref, on);
    return true;
  }

  /** Every fault bit currently set, across all PCS units. */
  activeFlags(): string[] {
    const out: string[] = [];
    for (const [pcs, bank] of this.flags) {
      out.push(...bank.active(pcs));
    }
    return out.sort();
  }

  clearFlags(): void {
    for (const bank of this.flags.values()) bank.clearAll();
  }

  /** Raw byte view per PCS, mirroring the Gen1 hex grid. */
  flagSnapshot(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [pcs, bank] of this.flags) {
      const snap = bank.snapshot();
      if (Object.keys(snap).length > 0) out[`P${String(pcs).padStart(2, '0')}`] = snap;
    }
    return out;
  }

  private effectiveMode(def: RegisterDef): string {
    const perRegister = this.controls.str(`can.register.${def.registerAddress}.mode`) || 'normal';
    if (perRegister !== 'normal') return perRegister;
    if (this.controls.bool('can.registers.freeze')) return 'stale';
    switch (this.controls.str('can.registers.boundary_mode')) {
      case 'min': return 'min';
      case 'max': return 'max';
      case 'under': return 'below_min';
      case 'over': return 'above_max';
      default: return 'normal';
    }
  }

  private metricValue(
    def: RegisterDef,
    metric: MetricDef,
    mode: string,
    pcs: number | null,
  ): number | string | boolean | null {
    // Flag metrics read straight out of the bank; boundary sweeps must not
    // clobber them, or every sweep would look like a total system fault.
    const flag = asFlagMetric(metric.id);
    if (flag && pcs !== null) {
      return this.bank(pcs).getByte(flag.domain, flag.severity, flag.byte);
    }

    const overrideId = `can.register.${def.registerAddress}.${metric.id}`;
    const override = this.controls.has(overrideId) ? this.controls.get(overrideId) : null;
    if (override !== null && override !== undefined) return override as number;

    if (mode !== 'normal') {
      const { min, max } = metricBounds(metric);
      switch (mode) {
        case 'min': return min;
        case 'max': return max;
        case 'below_min': return min - 1;
        case 'above_max': return max + 1;
        case 'nan': return null;
      }
    }

    const derived = this.fromPlant(metric.id, pcs);
    if (derived !== undefined) return derived;

    const p = metric.metricProfile;
    if (p.defaultValue !== undefined) return p.defaultValue as number;
    if (p.dataType === 'string') return '';
    if (p.dataType === 'boolean') return false;
    return 0;
  }

  /**
   * Bind CAN metrics to the plant.
   *
   * Power is split across the configured PCS units so that P01 and P02 sum to
   * the site total rather than each reporting the whole thing -- otherwise a
   * two-unit site appears to produce double its actual output.
   */
  private fromPlant(metricId: string, pcs: number | null): number | undefined {
    const s = this.plant.snapshot();
    const id = metricId.toLowerCase();
    const share = pcs === null ? 1 : 1 / Math.max(1, this.pcsCount());

    // Heartbeats increment once per second; a stuck heartbeat is how the MPU
    // detects a hung PCS CPU, so it must actually move.
    if (id.includes('heartbeat')) {
      if (pcs !== null && this.controls.bool(`can.pcs${pcs}.heartbeat_stuck`)) return 1;
      return Math.floor(this.uptimeMs() / 1000) % 256;
    }

    if (id.includes('soc')) return s.socPct;
    if (id.includes('soh')) return s.sohPct;
    if (id.includes('cell_temperature')) return s.batteryTempC;
    if (id.includes('cell_voltage')) return round2(3.2 + (s.socPct / 100) * 0.95);
    if (id.includes('grid_status')) return s.gridStatus;
    if (id === 'ess_grid_frequency' || id === 'ess_inverter_frequency') return s.gridFrequencyHz;
    if (id.includes('frequency')) return s.gridFrequencyHz;
    if (id.includes('detection_value') && id.includes('_v_')) return s.gridVoltageV;
    if (id.includes('voltage')) return s.gridVoltageV;

    const isPower = id.includes('power') || id.endsWith('_w');
    if (!isPower) return undefined;

    let active: number | undefined;
    if (id.includes('batt') || id.includes('rack') || id.includes('bpu')) active = s.batteryW;
    else if (id.includes('pv') || id.includes('solar')) active = s.totalPvW;
    else if (id.includes('grid')) active = s.gridW;
    else if (id.includes('load') || id.includes('consumption')) active = s.loadW;
    else if (id.startsWith('ess_') || id.includes('inv_') || id.includes('target'))
      active = s.batteryW;
    if (active === undefined) return undefined;

    active *= share;
    // L1/L2 split evenly across the split-phase service.
    if (id.includes('_l1_') || id.includes('_l2_')) active /= 2;
    if (id.includes('reactive')) return round2(active * 0.203);
    if (id.includes('apparent')) return round2(active / 0.98);
    return round2(active);
  }

  /** Aggregate view used by the control API and the digital twin. */
  summary(): Record<string, unknown> {
    const units: Record<string, unknown> = {};
    for (let pcs = 1; pcs <= this.pcsCount(); pcs += 1) {
      units[`P${String(pcs).padStart(2, '0')}`] = {
        present: !this.controls.bool(`can.pcs${pcs}.silent`),
        heartbeatStuck: this.controls.bool(`can.pcs${pcs}.heartbeat_stuck`),
        activeFlags: this.bank(pcs).active(pcs),
        flagBytes: this.bank(pcs).snapshot(),
      };
    }
    return {
      protocol: 'CAN',
      registerMap: 'qcells_ess_g4',
      online: this.controls.bool('can.online') && !this.controls.bool('can.bus_off'),
      busOff: this.controls.bool('can.bus_off'),
      pcsCount: this.pcsCount(),
      uptimeMs: this.uptimeMs(),
      stats: this.model.stats,
      domains: CAN_FLAG_DOMAINS,
      severities: CAN_SEVERITIES,
      units,
    };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
