import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import YAML from 'yaml';
import { parseDuration } from '../core/clock.js';
import type { RigContext } from '../core/context.js';
import { AREAS, KINDS, areasOf, kindOf } from './facets.js';
import type { FacetDef, ScenarioArea, ScenarioKind } from './facets.js';

/** A catalog entry: enough to choose a scenario without opening it. */
export interface ScenarioSummary {
  name: string;
  description?: string;
  tags?: string[];
  extends?: string;
  kind: ScenarioKind;
  areas: ScenarioArea[];
  steps: number;
  expects: number;
  /** Virtual milliseconds from load to the last scheduled step or check. */
  durationMs: number;
}

export interface ScenarioFacets {
  total: number;
  kinds: Array<FacetDef<ScenarioKind> & { count: number }>;
  areas: Array<FacetDef<ScenarioArea> & { count: number }>;
}

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

/** A timeline step as reported to a client, with enough detail to render it. */
export interface TimelineProgress {
  index: number;
  atMs: number;
  note?: string;
  summary: string;
  done: boolean;
}

/** An expectation as reported to a client, before or after it resolves. */
export interface ExpectationProgress {
  index: number;
  atMs: number;
  that: string;
  expected: string;
  status: 'pending' | 'passed' | 'failed';
  actual?: unknown;
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
  /**
   * The full schedules as loaded, kept alongside the pending queues.
   *
   * The queues are consumed as they fire, so on their own they can only answer
   * "what is left" -- a timeline view needs to show the steps already taken and
   * where the run is within the whole, which is unrecoverable once shifted off.
   */
  private allSteps: Array<{ atMs: number; step: TimelineStep }> = [];
  private allExpectations: Array<{ atMs: number; expectation: Expectation }> = [];
  private stopped = false;
  private stoppedAtMs = 0;

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

  /**
   * The catalog, summarised.
   *
   * Name and tags alone are not enough to choose from 157 scenarios: the
   * decisive fact is usually whether a scenario is a static rig setup or a
   * timed run, and how long that run is. That is only knowable after `extends`
   * resolution, since a child inherits its parent's timeline unless it declares
   * its own, so this resolves before counting.
   */
  list(): ScenarioSummary[] {
    return [...this.docs.values()]
      .map((d) => {
        let resolved = d;
        try {
          resolved = this.resolve(d.name);
        } catch {
          // A broken `extends` chain is worth reporting from `load`, not worth
          // dropping the scenario out of the catalog that would explain it.
        }
        const steps = resolved.timeline ?? [];
        const expects = resolved.expect ?? [];
        const ends = [...steps, ...expects].map((s) => parseDuration(s.at));
        return {
          name: d.name,
          description: d.description,
          tags: d.tags,
          extends: d.extends,
          kind: kindOf(d.tags),
          areas: areasOf(d.tags),
          steps: steps.length,
          expects: expects.length,
          durationMs: ends.length > 0 ? Math.max(...ends) : 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Facet catalogs with counts, so a client can render filters without a tag table. */
  facets(): ScenarioFacets {
    const items = this.list();
    const count = <T extends string>(
      defs: ReadonlyArray<FacetDef<T>>,
      pick: (s: ScenarioSummary) => readonly T[],
    ): Array<FacetDef<T> & { count: number }> => {
      const tally = new Map<T, number>();
      for (const s of items) for (const id of pick(s)) tally.set(id, (tally.get(id) ?? 0) + 1);
      return defs.map((d) => ({ ...d, count: tally.get(d.id) ?? 0 }));
    };
    return {
      total: items.length,
      kinds: count(KINDS, (s) => [s.kind]),
      areas: count(AREAS, (s) => s.areas),
    };
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
    this.stopped = false;
    this.stoppedAtMs = 0;
    this.pendingSteps = (doc.timeline ?? [])
      .map((step) => ({ atMs: parseDuration(step.at), step }))
      .sort((a, b) => a.atMs - b.atMs);
    this.pendingExpectations = (doc.expect ?? [])
      .map((expectation) => ({ atMs: parseDuration(expectation.at), expectation }))
      .sort((a, b) => a.atMs - b.atMs);
    this.allSteps = [...this.pendingSteps];
    this.allExpectations = [...this.pendingExpectations];

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

  /**
   * Halt the running timeline, keeping the state it has already produced.
   *
   * Deliberately not a reset: the point of stopping is usually to freeze a rig
   * mid-scenario and look at it, or to take manual control from where the
   * scenario got to. Anyone wanting the controls back at defaults has
   * `POST /control/reset`, and conflating the two would make the destructive
   * option the only one.
   */
  stop(): { stopped: boolean; scenario: string | null; droppedSteps: number; droppedExpectations: number } {
    if (!this.current) {
      return { stopped: false, scenario: null, droppedSteps: 0, droppedExpectations: 0 };
    }
    const droppedSteps = this.pendingSteps.length;
    const droppedExpectations = this.pendingExpectations.length;
    this.pendingSteps = [];
    this.pendingExpectations = [];
    this.stopped = true;
    this.stoppedAtMs = this.ctx.clock.elapsedMs() - this.loadedAtMs;
    this.ctx.log('info', `scenario stopped: ${this.current.name}`, { droppedSteps, droppedExpectations });
    return { stopped: true, scenario: this.current.name, droppedSteps, droppedExpectations };
  }

  state(): Record<string, unknown> {
    const offsetMs = this.current
      ? this.stopped
        ? this.stoppedAtMs
        : this.ctx.clock.elapsedMs() - this.loadedAtMs
      : 0;
    const pendingStepSet = new Set(this.pendingSteps.map((s) => s.step));
    const resultsByKey = new Map(this.results.map((r) => [`${r.atMs}|${r.that}`, r]));

    const steps: TimelineProgress[] = this.allSteps.map(({ atMs, step }, index) => ({
      index,
      atMs,
      note: step.note,
      summary: describeStep(step),
      done: !pendingStepSet.has(step),
    }));

    const expectations: ExpectationProgress[] = this.allExpectations.map(
      ({ atMs, expectation }, index) => {
        const result = resultsByKey.get(`${atMs}|${expectation.that}`);
        return {
          index,
          atMs,
          that: expectation.that,
          expected: describeExpectation(expectation),
          status: result ? (result.passed ? 'passed' : 'failed') : 'pending',
          actual: result?.actual,
        };
      },
    );

    // `currentStep` is the last step that has fired, which is what a timeline
    // highlights: the step that explains the state on screen right now.
    let currentStep: number | null = null;
    for (const step of steps) if (step.done) currentStep = step.index;

    return {
      current: this.current?.name ?? null,
      description: this.current?.description,
      tags: this.current?.tags ?? [],
      offsetMs,
      stopped: this.stopped,
      stepCount: steps.length,
      completedSteps: steps.filter((s) => s.done).length,
      currentStep,
      durationMs: steps.length > 0 ? steps[steps.length - 1]!.atMs : 0,
      steps,
      expectations,
      pendingSteps: this.pendingSteps.length,
      pendingExpectations: this.pendingExpectations.length,
      results: this.results,
      passed: this.results.every((r) => r.passed),
    };
  }
}

/**
 * One-line summary of what a step does.
 *
 * A timeline that shows only times and notes is useless for the many scenarios
 * whose steps carry no note, and dumping the raw step object into a row is
 * unreadable at 40 steps.
 */
function describeStep(step: TimelineStep): string {
  const parts: string[] = [];
  if (step.set) {
    const keys = Object.keys(step.set);
    parts.push(
      keys.length <= 2
        ? keys.map((k) => `${k}=${JSON.stringify(step.set![k])}`).join(', ')
        : `set ${keys.length} controls`,
    );
  }
  if (step.inject) {
    const list = Array.isArray(step.inject) ? step.inject : [step.inject];
    parts.push(`inject ${list.map((f) => f.code).join(', ')}`);
  }
  if (step.clear) {
    const list = Array.isArray(step.clear) ? step.clear : [step.clear];
    parts.push(`clear ${list.join(', ')}`);
  }
  return parts.join(' · ') || step.note || 'no-op';
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
