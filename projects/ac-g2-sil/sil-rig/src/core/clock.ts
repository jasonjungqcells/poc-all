import { EventEmitter } from 'node:events';

export type ClockMode = 'virtual' | 'wall';

/**
 * Virtual clock.
 *
 * In `virtual` mode time only advances when the clock ticks, and it advances by
 * exactly `tickMs * rate` regardless of how long the tick took in real terms.
 * That is what makes a run reproducible: the simulation is a pure function of
 * (scenario, seed, tick count) and never of host scheduling.
 *
 * `rate` 0 pauses. `step()` advances deliberately while paused, which is how the
 * CLI and any GUI scrub through a scenario.
 */
export class Clock extends EventEmitter {
  private mode: ClockMode = 'virtual';
  private nowMs: number;
  private rate = 1;
  private tickMs = 1000;
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private skewMs = 0;
  private readonly startMs: number;
  /**
   * Monotonic virtual time accumulated by ticking. Deliberately *not* derived
   * from `nowMs`: `setNow()` jumps the wall date (a scenario pinning itself to
   * a winter evening, say) and that must not look like elapsed time, or the
   * scenario engine -- which schedules timelines off this value -- would see
   * every step become due at once, or never.
   */
  private elapsed = 0;

  constructor(startIso?: string) {
    super();
    this.nowMs = startIso ? Date.parse(startIso) : Date.now();
    if (Number.isNaN(this.nowMs)) throw new Error(`invalid clock start: ${startIso}`);
    this.startMs = this.nowMs;
  }

  now(): Date {
    return new Date((this.mode === 'wall' ? Date.now() : this.nowMs) + this.skewMs);
  }

  /**
   * Offset between the device clock and the reference timeline.
   *
   * A device whose clock disagrees with the phone's is common in the field and
   * is invisible unless it is modelled, because every timestamp still looks
   * individually well-formed.
   */
  setSkewSeconds(seconds: number): void {
    this.skewMs = Math.round(seconds * 1000);
  }

  skewSeconds(): number {
    return this.skewMs / 1000;
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Virtual milliseconds elapsed since the scenario began. Never negative. */
  elapsedMs(): number {
    return this.mode === 'wall' ? Date.now() - this.startMs : this.elapsed;
  }

  tickCount(): number {
    return this.ticks;
  }

  getRate(): number {
    return this.rate;
  }

  getTickMs(): number {
    return this.tickMs;
  }

  getMode(): ClockMode {
    return this.mode;
  }

  setMode(mode: ClockMode): void {
    this.mode = mode;
  }

  setRate(rate: number): void {
    this.rate = Math.max(0, rate);
    if (this.timer) this.restart();
  }

  setTickMs(ms: number): void {
    this.tickMs = Math.max(10, ms);
    if (this.timer) this.restart();
  }

  setNow(iso: string): void {
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) throw new Error(`invalid clock time: ${iso}`);
    this.nowMs = parsed;
    this.emit('jump', this.now());
  }

  start(): void {
    if (this.timer) return;
    // Real interval is fixed; `rate` scales how much virtual time each tick buys.
    // Decoupling the two keeps virtual duration independent of host load.
    this.timer = setInterval(() => this.advanceOne(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private restart(): void {
    this.stop();
    this.start();
  }

  /** Advance N virtual milliseconds immediately, emitting every intermediate tick. */
  step(ms: number): void {
    const steps = Math.max(1, Math.round(ms / this.tickMs));
    for (let i = 0; i < steps; i++) this.advanceOne(true);
  }

  private advanceOne(forced = false): void {
    if (!forced && this.rate === 0) return;
    const deltaMs = this.tickMs * (forced ? 1 : this.rate);
    this.nowMs += deltaMs;
    this.elapsed += deltaMs;
    this.ticks++;
    this.emit('tick', { now: this.now(), deltaMs, tick: this.ticks });
  }
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** Parse `500ms` / `30s` / `5m` / `2h` / `1d`, or a bare number treated as ms. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input;
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // Support compound forms like `5m10s`.
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    matched = true;
    total += Number(m[1]) * unitMs(m[2] as Unit);
  }
  if (matched) return total;

  const single = DURATION_RE.exec(trimmed);
  if (!single) throw new Error(`invalid duration: ${input}`);
  return Number(single[1]) * unitMs(single[2] as Unit);
}

type Unit = 'ms' | 's' | 'm' | 'h' | 'd';

function unitMs(unit: Unit): number {
  switch (unit) {
    case 'ms': return 1;
    case 's': return 1000;
    case 'm': return 60_000;
    case 'h': return 3_600_000;
    case 'd': return 86_400_000;
  }
}
