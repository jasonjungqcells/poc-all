import { EventEmitter } from 'node:events';

export type ControlType =
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'string'
  | 'duration'
  | 'json'
  | 'action';

export interface ControlDef {
  id: string;
  group: string;
  type: ControlType;
  description: string;
  default?: unknown;
  unit?: string;
  min?: number;
  max?: number;
  values?: readonly (string | number)[];
  /** Derived by the plant/engine each tick; writes are advisory only. */
  readOnly?: boolean;
  /** Free-form pointers to what this control affects (telemetry point, register, endpoint). */
  appliesTo?: readonly string[];
}

export interface ControlChange {
  id: string;
  previous: unknown;
  value: unknown;
}

export class ControlError extends Error {
  constructor(message: string, readonly controlId: string) {
    super(message);
    this.name = 'ControlError';
  }
}

/**
 * The control registry.
 *
 * Design rule: there is exactly one of these, and every surface -- REST control
 * API, CLI, scenario loader, tests, any future HMI panel -- mutates simulation
 * behaviour only by going through it. If a behaviour is not reachable here, it
 * does not exist. That constraint is what keeps the CLI and the GUI at parity
 * and what makes `GET /control/diff` a complete bug repro.
 */
export class ControlRegistry extends EventEmitter {
  private readonly defs = new Map<string, ControlDef>();
  private readonly values = new Map<string, unknown>();
  /** Definitions whose id contains `{...}`, matched by pattern for dynamic keys. */
  private readonly patterns: ControlDef[] = [];

  define(def: ControlDef): void {
    if (this.defs.has(def.id)) throw new Error(`duplicate control: ${def.id}`);
    this.defs.set(def.id, def);
    if (def.id.includes('{')) {
      this.patterns.push(def);
    } else if (def.type !== 'action') {
      this.values.set(def.id, def.default);
    }
  }

  defineAll(defs: readonly ControlDef[]): void {
    for (const d of defs) this.define(d);
  }

  has(id: string): boolean {
    return this.defs.has(id) || this.matchPattern(id) !== undefined;
  }

  definition(id: string): ControlDef | undefined {
    return this.defs.get(id) ?? this.matchPattern(id);
  }

  get<T = unknown>(id: string): T {
    if (this.values.has(id)) return this.values.get(id) as T;
    const def = this.definition(id);
    if (!def) throw new ControlError(`unknown control: ${id}`, id);
    return def.default as T;
  }

  num(id: string): number {
    return Number(this.get(id) ?? 0);
  }

  bool(id: string): boolean {
    return Boolean(this.get(id));
  }

  str(id: string): string {
    return String(this.get(id) ?? '');
  }

  /**
   * Write one control. Validates against the definition and emits `change`.
   * `internal` marks writes made by the plant for derived values, which must not
   * be reported by `diff()` as operator intent.
   */
  set(id: string, value: unknown, opts: { internal?: boolean } = {}): void {
    const def = this.definition(id);
    if (!def) throw new ControlError(`unknown control: ${id}`, id);
    if (def.readOnly && !opts.internal) {
      throw new ControlError(
        `${id} is derived and cannot be set directly; set its causes instead`,
        id,
      );
    }
    // Actions hold no state, so writing one fires it. This keeps scenarios and
    // the CLI from needing a second verb for the handful of controls that are
    // verbs rather than settings.
    if (def.type === 'action') {
      this.invoke(id);
      return;
    }
    const coerced = coerce(def, value);
    const previous = this.values.get(id);
    if (previous === coerced) return;
    this.values.set(id, coerced);
    if (!opts.internal) this.dirty.add(id);
    this.emit('change', { id, previous, value: coerced } satisfies ControlChange);
    this.emit(`change:${id}`, coerced, previous);
  }

  /**
   * Fire an action control.
   *
   * Actions are one-shot verbs -- reboot, clear-all -- with no value to read
   * back. They emit on a separate channel so a `change` listener never sees a
   * phantom state transition for something that has no state.
   */
  invoke(id: string): void {
    const def = this.definition(id);
    if (!def) throw new ControlError(`unknown control: ${id}`, id);
    if (def.type !== 'action') {
      throw new ControlError(`${id} is not an action; use set() instead`, id);
    }
    this.emit('action', { id });
    this.emit(`action:${id}`);
  }

  /** Atomic bulk write: validate everything first, then commit. */
  patch(map: Record<string, unknown>, opts: { internal?: boolean } = {}): ControlChange[] {
    const staged: Array<[string, unknown]> = [];
    const actions: string[] = [];
    for (const [id, value] of Object.entries(map)) {
      const def = this.definition(id);
      if (!def) throw new ControlError(`unknown control: ${id}`, id);
      if (def.type === 'action') {
        actions.push(id);
        continue;
      }
      staged.push([id, coerce(def, value)]);
    }
    const changes: ControlChange[] = [];
    for (const [id, value] of staged) {
      const previous = this.values.get(id);
      if (previous === value) continue;
      this.values.set(id, value);
      if (!opts.internal) this.dirty.add(id);
      const change: ControlChange = { id, previous, value };
      changes.push(change);
      this.emit('change', change);
      this.emit(`change:${id}`, value, previous);
    }
    if (changes.length > 0) this.emit('patch', changes);
    // Actions fire after the value writes land, so an action that reacts to
    // state in the same patch sees the new state, not the old.
    for (const id of actions) this.invoke(id);
    return changes;
  }

  private readonly dirty = new Set<string>();

  /**
   * Controls explicitly set away from their default.
   *
   * This is the bug-report primitive: fiddle until reproduced, dump the diff,
   * attach it as a scenario. Reproduction becomes a file, not a paragraph.
   */
  diff(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const id of [...this.dirty].sort()) {
      const def = this.definition(id);
      const current = this.values.get(id);
      if (def && Object.is(current, def.default)) continue;
      out[id] = current;
    }
    return out;
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  restore(snapshot: Record<string, unknown>): void {
    this.reset();
    this.patch(snapshot);
  }

  reset(): void {
    this.dirty.clear();
    // Restoring a default is a change like any other. Emitting per-control
    // events keeps side effects wired to `change:{id}` -- the clock's tick
    // interval, for one -- in step with the values. Writing the map silently
    // leaves those listeners holding the previous scenario's settings while
    // the control reports the default, which is very hard to spot.
    const changed: Array<{ id: string; previous: unknown; value: unknown }> = [];
    for (const def of this.defs.values()) {
      if (def.type === 'action' || def.id.includes('{')) continue;
      const previous = this.values.get(def.id);
      if (previous === def.default) continue;
      this.values.set(def.id, def.default);
      changed.push({ id: def.id, previous, value: def.default });
    }
    // Dynamic pattern instances have no default; drop them entirely.
    for (const id of [...this.values.keys()]) {
      if (!this.defs.has(id)) this.values.delete(id);
    }
    // A throwing listener must not abort the rest of the restore. Without this
    // guard one bad handler leaves the registry half-reset and, worse, skips
    // the final `reset` event that subsystems rely on to clear their state.
    const failures: Array<{ id: string; error: unknown }> = [];
    for (const change of changed) {
      try {
        this.emit('change', change satisfies ControlChange);
        this.emit(`change:${change.id}`, change.value, change.previous);
      } catch (error) {
        failures.push({ id: change.id, error });
      }
    }
    this.emit('reset');
    if (failures.length > 0) {
      this.emit('reset:errors', failures);
    }
  }

  list(): Array<ControlDef & { value?: unknown }> {
    const out: Array<ControlDef & { value?: unknown }> = [];
    for (const def of this.defs.values()) {
      out.push({ ...def, value: this.values.has(def.id) ? this.values.get(def.id) : def.default });
    }
    // Dynamic instances created at runtime.
    for (const [id, value] of this.values) {
      if (this.defs.has(id)) continue;
      const def = this.matchPattern(id);
      if (def) out.push({ ...def, id, value });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  groups(): string[] {
    return [...new Set([...this.defs.values()].map((d) => d.group))].sort();
  }

  /**
   * Resolve `mcu.register.0x8224.mode` against the `mcu.register.{addr}.mode`
   * definition. Dynamic ids exist because the register map contributes 4,411
   * metrics -- enumerating them as static defs would be unusable.
   */
  private matchPattern(id: string): ControlDef | undefined {
    for (const def of this.patterns) {
      const re = new RegExp(
        '^' +
          def.id
            .split(/(\{[^}]+\})/)
            .map((part) =>
              part.startsWith('{') ? '([^.]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            )
            .join('') +
          '$',
      );
      if (re.test(id)) return { ...def, id };
    }
    return undefined;
  }
}

function coerce(def: ControlDef, raw: unknown): unknown {
  let value = raw;

  switch (def.type) {
    case 'boolean':
      if (typeof value === 'string') value = value === 'true' || value === '1' || value === 'yes';
      return Boolean(value);

    case 'integer':
    case 'number': {
      const n = typeof value === 'string' ? Number(value) : (value as number);
      if (typeof n !== 'number' || Number.isNaN(n)) {
        throw new ControlError(`${def.id} expects a number, got ${JSON.stringify(raw)}`, def.id);
      }
      const rounded = def.type === 'integer' ? Math.round(n) : n;
      if (def.min !== undefined && rounded < def.min) {
        throw new ControlError(`${def.id} below min ${def.min}: ${rounded}`, def.id);
      }
      if (def.max !== undefined && rounded > def.max) {
        throw new ControlError(`${def.id} above max ${def.max}: ${rounded}`, def.id);
      }
      return rounded;
    }

    case 'enum': {
      if (!def.values) return value;
      // Enum members may be numeric (e.g. energy_control 0/1/3/4); compare loosely
      // so `"1"` from a query string and `1` from YAML both resolve.
      const hit = def.values.find((v) => String(v) === String(value));
      if (hit === undefined) {
        throw new ControlError(
          `${def.id} expects one of [${def.values.join(', ')}], got ${JSON.stringify(raw)}`,
          def.id,
        );
      }
      return hit;
    }

    case 'duration':
      return typeof value === 'string' ? value : Number(value);

    case 'string':
      return value === null || value === undefined ? '' : String(value);

    case 'json':
    case 'action':
    default:
      return value;
  }
}
