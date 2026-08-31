import { EventEmitter } from 'node:events';
import type { Clock } from '../core/clock.js';
import type { ControlRegistry } from '../core/controls.js';
import type { Rng } from '../core/rng.js';
import {
  ALL_FAULTS,
  faultsForDevice,
  faultsInBucket,
  lookupFault,
  type ActiveFault,
  type FaultBucket,
  type FaultDef,
  type FaultLevel,
} from './codebook.js';

/**
 * Fault manager.
 *
 * Faults are levers, not exceptions: raising e014 is a control write, and the
 * set of active faults is itself readable as `fault.active`. Random injection
 * draws from a derived Rng substream so that enabling chaos in one scenario
 * cannot shift the number sequence any other consumer sees.
 */
export class FaultManager extends EventEmitter {
  private active = new Map<string, ActiveFault>();
  private readonly rng: Rng;
  private carryMs = 0;
  private sweep: {
    queue: FaultDef[];
    index: number;
    heldMs: number;
    current?: FaultDef;
    /** The device+level the queue was built from, so a change re-selects it. */
    key: string;
  } | null = null;

  constructor(
    private readonly controls: ControlRegistry,
    private readonly clock: Clock,
    rng: Rng,
  ) {
    super();
    this.rng = rng.derive('faults');
  }

  inject(code: string, opts: { device?: string; level?: FaultLevel } = {}): ActiveFault {
    const def = lookupFault(code);
    const ttl = this.controls.num('fault.cache_ttl_s');
    const now = this.clock.now();
    const fault: ActiveFault = {
      code,
      device: opts.device ?? def?.device ?? 'ems',
      level: opts.level ?? def?.level ?? 'A',
      flag: 1,
      raisedAt: now.toISOString(),
      expiresAt: ttl > 0 ? new Date(now.getTime() + ttl * 1000).toISOString() : undefined,
    };
    this.active.set(code, fault);
    this.publish();
    this.emit('fault', fault);
    return fault;
  }

  /**
   * Clearing emits flag 0 rather than deleting silently -- clients need the
   * transition. `fault.suppress_clear` removes the fault from the active list
   * but withholds the notification, which is how a real client ends up showing
   * a fault forever.
   */
  clear(code: string): ActiveFault | undefined {
    const existing = this.active.get(code);
    if (!existing) return undefined;
    this.active.delete(code);
    const cleared: ActiveFault = { ...existing, flag: 0 };
    this.publish();
    if (!this.controls.bool('fault.suppress_clear')) this.emit('fault', cleared);
    return cleared;
  }

  clearAll(): void {
    const codes = [...this.active.keys()];
    for (const code of codes) this.clear(code);
  }

  list(): ActiveFault[] {
    return [...this.active.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  has(code: string): boolean {
    return this.active.has(code);
  }

  tick(deltaMs: number): void {
    this.expire();
    this.tickSweep(deltaMs);
    if (!this.controls.bool('fault.random.enabled')) return;

    const ratePerHour = this.controls.num('fault.random.rate_per_hour');
    if (ratePerHour <= 0) return;

    const buckets = this.controls.get<FaultBucket[]>('fault.random.buckets');
    const pool = Array.isArray(buckets) && buckets.length > 0
      ? buckets.flatMap((b) => faultsInBucket(b))
      : ALL_FAULTS;
    if (pool.length === 0) return;

    // Accumulate fractional expectation so low rates still fire deterministically
    // rather than being rounded away every tick.
    this.carryMs += deltaMs;
    const intervalMs = 3_600_000 / ratePerHour;
    while (this.carryMs >= intervalMs) {
      this.carryMs -= intervalMs;
      const maxActive = this.controls.num('fault.random.max_active');
      if (maxActive > 0 && this.active.size >= maxActive) continue;
      const pick = this.rng.pick(pool);
      if (pick && !this.active.has(pick.code)) {
        this.inject(pick.code, { device: pick.device, level: pick.level });
      }
    }
  }

  /**
   * Codebook sweep.
   *
   * Holds each code for `fault.sweep.hold_s`, clears it, then moves on. This is
   * the cheapest way to prove that every code in the codebook renders a
   * description and a how-to-fix string, and that every fault has a working
   * clear path -- the single most common gap in fault handling.
   */
  private tickSweep(deltaMs: number): void {
    if (!this.controls.bool('fault.sweep.enabled')) {
      if (this.sweep) {
        if (this.sweep.current) this.clear(this.sweep.current.code);
        this.sweep = null;
      }
      return;
    }

    const device = this.controls.str('fault.sweep.device');
    const level = this.controls.str('fault.sweep.level');
    const key = `${device}|${level}`;

    // Rebuild when the selection changes. Without this, narrowing the sweep
    // mid-run keeps walking the old queue, so the control appears to do
    // nothing -- the selection would only apply after disabling the sweep and
    // letting a tick tear it down.
    if (this.sweep && this.sweep.key !== key) {
      if (this.sweep.current) this.clear(this.sweep.current.code);
      this.sweep = null;
    }

    if (!this.sweep) {
      this.sweep = { queue: faultsForDevice(device, level), index: 0, heldMs: 0, key };
    }

    const holdMs = Math.max(1, this.controls.num('fault.sweep.hold_s') * 1000);
    this.sweep.heldMs += deltaMs;

    if (this.sweep.current && this.sweep.heldMs < holdMs) return;

    if (this.sweep.current) this.clear(this.sweep.current.code);
    this.sweep.heldMs = 0;

    const next = this.sweep.queue[this.sweep.index % Math.max(1, this.sweep.queue.length)];
    this.sweep.index += 1;
    if (!next) {
      this.sweep.current = undefined;
      return;
    }
    this.sweep.current = next;
    this.inject(next.code, { device: next.device, level: next.level });
  }

  private expire(): void {
    const now = this.clock.now().getTime();
    for (const [code, fault] of [...this.active]) {
      if (fault.expiresAt && Date.parse(fault.expiresAt) <= now) this.clear(code);
    }
  }

  private publish(): void {
    this.controls.set('fault.active', this.list(), { internal: true });
  }
}
