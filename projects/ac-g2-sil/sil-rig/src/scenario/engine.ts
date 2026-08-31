import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import YAML from 'yaml';
import { parseDuration } from '../core/clock.js';
import type { RigContext } from '../core/context.js';

export interface TimelineStep {
  at: string | number;
  set?: Record<string, unknown>;
  inject?: { code: string; device?: string; level?: 'W' | 'A' | 'F' } | Array<{ code: string; device?: string; level?: 'W' | 'A' | 'F' }>;
  clear?: string[] | string;
  note?: string;
}

export interface Expectation {
  at: string | number;
  that: string;
  equals?: unknown;
  lessThan?: number;
  greaterThan?: number;
  within?: [number, number];
}

export interface ScenarioDoc {
  name: string;
  extends?: string;
  description?: string;
  tags?: string[];
  seed?: number;
  clock?: { start?: string; rate?: number; timezone?: string; tickMs?: number };
  controls?: Record<string, unknown>;
  timeline?: TimelineStep[];
  expect?: Expectation[];
}

export interface ExpectationResult {
  atMs: number;
  that: string;
  expected: string;
  actual: unknown;
  passed: boolean;
}

/**
 * Scenario engine.
 *
 * A scenario is deliberately nothing more than a bulk control write plus a
 * schedule of further writes. It cannot reach any behaviour an operator could
 * not reach by hand through the control API, which is what keeps `GET
 * /control/diff` a complete and honest bug report.
 */
export class ScenarioEngine {
  private readonly docs = new Map<string, ScenarioDoc>();
  private current?: ScenarioDoc;
  private loadedAtMs = 0;
  private pendingSteps: Array<{ atMs: number; step: TimelineStep }> = [];
  private pendingExpectations: Array<{ atMs: number; expectation: Expectation }> = [];
  private results: ExpectationResult[] = [];

  constructor(
    private readonly ctx: RigContext,
    private readonly dir: string,
  ) {
    this.reload();
  }

  reload(): void {
    this.docs.clear();
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      try {
        const doc = YAML.parse(readFileSync(join(this.dir, file), 'utf8')) as ScenarioDoc;
        if (!doc) continue;
        doc.name ??= basename(file).replace(/\.ya?ml$/, '');
        this.docs.set(doc.name, doc);
      } catch (err) {
        this.ctx.log('error', `failed to parse scenario ${file}`, err);
      }
    }
  }

  list(): Array<{ name: string; description?: string; tags?: string[]; extends?: string }> {
    return [...this.docs.values()]
      .map((d) => ({ name: d.name, description: d.description, tags: d.tags, extends: d.extends }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ScenarioDoc | undefined {
    return this.docs.get(name);
  }

  /** Resolve `extends` chains into a single flattened document. */
  resolve(name: string, seen = new Set<string>()): ScenarioDoc {
    const doc = this.docs.get(name);
    if (!doc) throw new Error(`unknown scenario: ${name}`);
    if (seen.has(name)) throw new Error(`circular scenario inheritance at: ${name}`);
    seen.add(name);

    if (!doc.extends) return { ...doc };

    const parent = this.resolve(doc.extends, seen);
    return {
      ...parent,
      ...doc,
      // Child control writes win over the parent's; the timeline is appended so
      // a derived scenario can add events without restating the base sequence.
      controls: { ...(parent.controls ?? {}), ...(doc.controls ?? {}) },
      timeline: [...(parent.timeline ?? []), ...(doc.timeline ?? [])],
      expect: [...(parent.expect ?? []), ...(doc.expect ?? [])],
      tags: [...new Set([...(parent.tags ?? []), ...(doc.tags ?? [])])],
      clock: { ...(parent.clock ?? {}), ...(doc.clock ?? {}) },
    };
  }

  load(name: string): { scenario: string; applied: number; timeline: number; expectations: number } {
    const doc = this.resolve(name);
    const { controls, clock } = this.ctx;

    controls.reset();
    this.results = [];

    if (doc.seed !== undefined) controls.set('sim.seed', doc.seed);
    if (doc.clock?.timezone) controls.set('sim.timezone', doc.clock.timezone);
    if (doc.clock?.tickMs) controls.set('sim.tick_ms', doc.clock.tickMs);
    // Set the absolute time before rate so profile-driven scenarios begin at the
    // intended hour rather than sampling the previous run's clock.
    if (doc.clock?.start) clock.setNow(new Date(doc.clock.start).toISOString());
    if (doc.clock?.rate !== undefined) controls.set('sim.clock.rate', doc.clock.rate);

    const applied = doc.controls ? controls.patch(doc.controls).length : 0;

    this.loadedAtMs = clock.elapsedMs();
    this.pendingSteps = (doc.timeline ?? [])
      .map((step) => ({ atMs: parseDuration(step.at), step }))
      .sort((a, b) => a.atMs - b.atMs);
    this.pendingExpectations = (doc.expect ?? [])
      .map((expectation) => ({ atMs: parseDuration(expectation.at), expectation }))
      .sort((a, b) => a.atMs - b.atMs);

    this.current = doc;
    this.ctx.log('info', `scenario loaded: ${doc.name}`, {
      applied,
      timeline: this.pendingSteps.length,
      expectations: this.pendingExpectations.length,
    });

    return {
      scenario: doc.name,
      applied,
      timeline: this.pendingSteps.length,
      expectations: this.pendingExpectations.length,
    };
  }

  /** Fire any timeline steps and expectations now due. */
  tick(): void {
    if (!this.current) return;
    const offsetMs = this.ctx.clock.elapsedMs() - this.loadedAtMs;

    while (this.pendingSteps.length > 0 && this.pendingSteps[0]!.atMs <= offsetMs) {
      const { step } = this.pendingSteps.shift()!;
      this.applyStep(step);
    }

    while (this.pendingExpectations.length > 0 && this.pendingExpectations[0]!.atMs <= offsetMs) {
      const { atMs, expectation } = this.pendingExpectations.shift()!;
      this.evaluate(atMs, expectation);
    }
  }

  private applyStep(step: TimelineStep): void {
    if (step.note) this.ctx.log('info', `scenario: ${step.note}`);

    if (step.set) {
      try {
        this.ctx.controls.patch(step.set);
      } catch (err) {
        this.ctx.log('error', 'scenario step failed', err);
      }
    }

    if (step.inject) {
      const list = Array.isArray(step.inject) ? step.inject : [step.inject];
      for (const f of list) this.ctx.faults.inject(f.code, { device: f.device, level: f.level });
    }

    if (step.clear) {
      const codes = Array.isArray(step.clear) ? step.clear : [step.clear];
      for (const code of codes) {
        if (code === 'all') this.ctx.faults.clearAll();
        else this.ctx.faults.clear(code);
      }
    }
  }

  private evaluate(atMs: number, expectation: Expectation): void {
    const actual = this.readPath(expectation.that);
    let passed = true;

    if (expectation.equals !== undefined) passed = String(actual) === String(expectation.equals);
    if (expectation.lessThan !== undefined) passed = passed && Number(actual) < expectation.lessThan;
    if (expectation.greaterThan !== undefined) passed = passed && Number(actual) > expectation.greaterThan;
    if (expectation.within) {
      const [lo, hi] = expectation.within;
      passed = passed && Number(actual) >= lo && Number(actual) <= hi;
    }

    const result: ExpectationResult = {
      atMs,
      that: expectation.that,
      expected: describeExpectation(expectation),
      actual,
      passed,
    };
    this.results.push(result);

    if (!passed) {
      this.ctx.log('error', `expectation failed: ${expectation.that}`, result);
      if (this.ctx.controls.bool('sim.strict')) {
        throw new Error(`expectation failed at ${atMs}ms: ${expectation.that}`);
      }
    }
  }

  /**
   * Resolve an assertion target.
   *
   * `telemetry.<point>` and `plant.<field>` read live state; anything else falls
   * back to the control registry, so assertions can target any lever.
   */
  private readPath(path: string): unknown {
    if (path.startsWith('telemetry.')) {
      const point = path.slice('telemetry.'.length);
      const s = this.ctx.plant.snapshot();
      const points: Record<string, unknown> = {
        pv_200_W: s.pvW,
        extpv_200_W: s.extPvW,
        grid_200_W: s.gridW,
        load_200_W: s.loadW,
        battery_200_W: s.batteryW,
        battery_713_SoC: s.socPct,
        battery_713_SoH: s.sohPct,
        Grid_Status: s.gridStatus,
        energyControl: s.energyControl,
      };
      return points[point];
    }

    if (path.startsWith('fault.')) {
      const code = path.slice('fault.'.length);
      return this.ctx.faults.has(code);
    }

    try {
      return this.ctx.controls.get(path);
    } catch {
      return undefined;
    }
  }

  state(): Record<string, unknown> {
    return {
      current: this.current?.name ?? null,
      description: this.current?.description,
      tags: this.current?.tags ?? [],
      offsetMs: this.current ? this.ctx.clock.elapsedMs() - this.loadedAtMs : 0,
      pendingSteps: this.pendingSteps.length,
      pendingExpectations: this.pendingExpectations.length,
      results: this.results,
      passed: this.results.every((r) => r.passed),
    };
  }
}

/**
 * Human-readable form of an expectation.
 *
 * Reporting the bare bound is ambiguous: "expected 0, actual 0, failed" reads
 * like a bug in the rig when it actually means "expected > 0".
 */
function describeExpectation(expectation: Expectation): string {
  const parts: string[] = [];
  if (expectation.equals !== undefined) parts.push(`== ${JSON.stringify(expectation.equals)}`);
  if (expectation.lessThan !== undefined) parts.push(`< ${expectation.lessThan}`);
  if (expectation.greaterThan !== undefined) parts.push(`> ${expectation.greaterThan}`);
  if (expectation.within) parts.push(`within [${expectation.within[0]}, ${expectation.within[1]}]`);
  return parts.join(' and ') || 'any';
}
