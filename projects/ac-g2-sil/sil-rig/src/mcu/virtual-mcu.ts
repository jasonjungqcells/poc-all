import type { Clock } from '../core/clock.js';
import type { ControlRegistry } from '../core/controls.js';
import type { Rng } from '../core/rng.js';
import type { Plant } from '../plant/plant.js';
import { loadRegisterMap, metricBounds, type MetricDef, type RegisterDef, type RegisterMapModel } from './registers.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class SpiError extends Error {
  constructor(message: string, readonly kind: 'crc' | 'nack' | 'timeout' | 'offline' | 'desync' | 'short_frame') {
    super(message);
    this.name = 'SpiError';
  }
}

export interface RegisterRead {
  register: string;
  address: string;
  timestamp: string;
  metrics: Record<string, number | string | boolean | null>;
}

/**
 * Virtual MCU.
 *
 * Serves register reads/writes over a simulated SPI link. Values come from three
 * places, in priority order:
 *   1. an explicit `mcu.register.{addr}.{metric}` override,
 *   2. a boundary mode set via `mcu.register.{addr}.mode`,
 *   3. the plant, for the handful of metrics that represent real power flow,
 *      falling back to the register map's defaultValue.
 *
 * Boundary modes are the reason this is worth generating from the factory map:
 * `min`/`max`/`below_min`/`above_max` produce meaningful out-of-range values for
 * all 4,411 metrics without anyone hand-authoring a single test vector.
 */
export class VirtualMcu {
  readonly model: RegisterMapModel;
  private bootedAt: number;
  private readonly rng: Rng;
  /** Frozen snapshots used by the `stale` boundary mode. */
  private readonly staleCache = new Map<string, RegisterRead>();

  constructor(
    private readonly controls: ControlRegistry,
    private readonly clock: Clock,
    private readonly plant: Plant,
    rng: Rng,
    registerMapPath?: string,
  ) {
    this.model = loadRegisterMap(registerMapPath);
    this.rng = rng.derive('mcu');
    this.bootedAt = clock.now().getTime();
  }

  reboot(): void {
    this.bootedAt = this.clock.now().getTime();
    this.staleCache.clear();
  }

  /** Milliseconds since the virtual MCU last booted. */
  uptimeMs(): number {
    return Math.max(0, this.clock.now().getTime() - this.bootedAt);
  }

  /**
   * Apply transport-level faults. Called before every register operation so a
   * scenario that sets `mcu.spi.crc_error_rate_pct` affects reads and writes
   * alike, exactly as a real bus fault would.
   */
  private checkLink(): void {
    if (!this.controls.bool('mcu.online')) {
      throw new SpiError('MCU is offline', 'offline');
    }
    if (this.controls.bool('mcu.spi.desync')) {
      throw new SpiError('sync byte corrupted (expected 0xAA)', 'desync');
    }
    if (this.controls.bool('mcu.spi.short_frame')) {
      throw new SpiError('frame shorter than the fixed 71 bytes (FUS-124)', 'short_frame');
    }
    if (this.rng.chance(this.controls.num('mcu.spi.timeout_rate_pct'))) {
      throw new SpiError('SPI transaction timed out', 'timeout');
    }
    if (this.rng.chance(this.controls.num('mcu.spi.nack_rate_pct'))) {
      throw new SpiError('MCU responded NACK (0x91)', 'nack');
    }
    if (this.rng.chance(this.controls.num('mcu.spi.crc_error_rate_pct'))) {
      throw new SpiError('CRC16 mismatch on SPI frame', 'crc');
    }
  }

  resolveRegister(key: string): RegisterDef | undefined {
    if (this.model.byName.has(key)) return this.model.byName.get(key);
    const norm = key.startsWith('0x') || key.startsWith('0X')
      ? `0x${Number.parseInt(key, 16).toString(16).toUpperCase()}`
      : key;
    return this.model.registers.get(norm);
  }

  readRegister(key: string): RegisterRead {
    this.checkLink();
    const def = this.resolveRegister(key);
    if (!def) throw new SpiError(`unknown register: ${key}`, 'nack');

    const mode = this.effectiveMode(def);

    if (mode === 'stale') {
      const cached = this.staleCache.get(def.registerAddress);
      if (cached) return cached;
    }

    const metrics: RegisterRead['metrics'] = {};
    for (const metric of def.metrics) {
      metrics[metric.id] = this.metricValue(def, metric, mode);
    }

    const read: RegisterRead = {
      register: def.id,
      address: def.registerAddress,
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
    if (this.controls.bool('mcu.registers.write_reject')) {
      throw new SpiError('MCU rejected the register write', 'nack');
    }
    const def = this.resolveRegister(key);
    if (!def) throw new SpiError(`unknown register: ${key}`, 'nack');

    const written: string[] = [];
    for (const [metricId, value] of Object.entries(values)) {
      if (!def.metrics.some((m) => m.id === metricId)) continue;
      this.controls.set(`mcu.register.${def.registerAddress}.${metricId}`, value);
      written.push(metricId);
    }
    return { register: def.id, written };
  }

  /** All registers in the 1 Hz cyclic group -- the real-time data path. */
  readCyclic(): RegisterRead[] {
    return this.model.cyclic.map((def) => this.readRegister(def.registerAddress));
  }

  /**
   * Per-register mode, with the global sweep and freeze knobs layered on top.
   *
   * A per-register override still wins, so a sweep can be run while pinning one
   * register to a specific value.
   */
  private effectiveMode(def: RegisterDef): string {
    const perRegister = this.controls.str(`mcu.register.${def.registerAddress}.mode`) || 'normal';
    if (perRegister !== 'normal') return perRegister;
    if (this.controls.bool('mcu.registers.freeze')) return 'stale';
    switch (this.controls.str('mcu.registers.boundary_mode')) {
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
  ): number | string | boolean | null {
    // 1. Explicit override wins over everything.
    const overrideId = `mcu.register.${def.registerAddress}.${metric.id}`;
    const override = this.controls.has(overrideId) ? this.controls.get(overrideId) : null;
    if (override !== null && override !== undefined) return override as number;

    // 2. Boundary modes, generated from the register map's own bounds.
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

    // 3. Plant-derived values for metrics that represent real power flow.
    const derived = this.fromPlant(metric.id);
    if (derived !== undefined) return derived;

    const p = metric.metricProfile;
    if (p.defaultValue !== undefined) return p.defaultValue as number;
    if (p.dataType === 'string') return '';
    if (p.dataType === 'boolean') return false;
    return 0;
  }

  /**
   * Bridge the physical model into named metrics.
   *
   * Matching is by suffix because the factory map uses long qualified names
   * (`Instantaneous_Ext_Consumption_L2_Active_Power`) whose meaning is carried
   * by the tail of the identifier.
   */
  private fromPlant(metricId: string): number | undefined {
    const s = this.plant.snapshot();
    const id = metricId.toLowerCase();

    if (id.includes('soc')) return s.socPct;
    if (id.includes('soh')) return s.sohPct;
    if (id.includes('grid') && id.includes('freq')) return s.gridFrequencyHz;
    if (id.includes('grid') && id.includes('volt')) return s.gridVoltageV;
    if (id.includes('batt') && id.includes('temp')) return s.batteryTempC;
    if (id.includes('off_grid_state')) return s.gridStatus;

    // Only real (active) power maps to the plant. Reactive and apparent power
    // are derived from it so a register dump stays internally consistent
    // instead of reporting the same number under three different names.
    const isPower = id.includes('power') || id.includes('_w');
    if (!isPower) return undefined;

    let active: number | undefined;
    if (id.includes('batt')) active = s.batteryW;
    else if (id.includes('pv') || id.includes('solar') || id.includes('production')) active = s.totalPvW;
    else if (id.includes('grid') || id.includes('import') || id.includes('export')) active = s.gridW;
    else if (id.includes('consumption') || id.includes('load')) active = s.loadW;
    if (active === undefined) return undefined;

    // cos(phi) 0.98 is a representative residential power factor.
    if (id.includes('reactive')) return round2(active * 0.203);
    if (id.includes('apparent') || id.includes('va')) return round2(active / 0.98);
    return active;
  }
}
