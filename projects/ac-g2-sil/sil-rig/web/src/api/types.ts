/**
 * Shapes returned by the control plane.
 *
 * `ControlDef` and `ControlChange` are imported from the engine itself rather
 * than restated here. They are type-only imports, erased at build time, so the
 * console still bundles nothing of the rig -- but a control gaining a field, or
 * `ControlType` gaining a member, becomes a console type error instead of a
 * widget that silently renders the wrong thing.
 */
export type { ControlDef, ControlType, ControlChange } from '../../../src/core/controls.js';

import type { ControlDef, ControlChange } from '../../../src/core/controls.js';

export interface ControlValue extends ControlDef {
  value: unknown;
}

export interface ControlListResponse {
  groups: string[];
  count: number;
  controls: ControlValue[];
}

export interface ClockState {
  now: string;
  mode: 'virtual' | 'wall';
  rate: number;
  tickMs: number;
  tick: number;
  elapsedMs: number;
  skewSeconds?: number;
}

export interface PlantSnapshot {
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
  reactiveVar: number;
  loadShedW: number;
  gridSupport: {
    phase: string;
    elapsedS: number;
    powerLimit: number;
    varTarget: number;
    reason: string | null;
  };
}

export interface ActiveFault {
  code: string;
  device?: string;
  level?: string;
  raisedAt?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface LiveState {
  clock: ClockState;
  plant: PlantSnapshot;
  faults: ActiveFault[];
  mcu: { online: boolean; fwVersion: string; uptimeMs: number };
  site: { serialNumber: string; emsType: string; commissioningStatus: string };
}

export type ScenarioKind =
  | 'baseline'
  | 'conformance'
  | 'endurance'
  | 'boundary'
  | 'failure'
  | 'degraded'
  | 'nominal';

export type ScenarioArea =
  | 'grid'
  | 'energy'
  | 'buses'
  | 'faults'
  | 'connectivity'
  | 'cloud'
  | 'setup'
  | 'app'
  | 'other';

export interface ScenarioSummary {
  name: string;
  description?: string;
  tags?: string[];
  extends?: string;
  kind: ScenarioKind;
  areas: ScenarioArea[];
  steps: number;
  expects: number;
  durationMs: number;
}

/** Filter definitions come from the rig, so the console cannot invent a filter. */
export interface FacetCount<T extends string> {
  id: T;
  label: string;
  hint: string;
  count: number;
}

export interface ScenarioFacets {
  total: number;
  kinds: Array<FacetCount<ScenarioKind>>;
  areas: Array<FacetCount<ScenarioArea>>;
}

export interface TimelineProgress {
  index: number;
  atMs: number;
  note?: string;
  summary: string;
  done: boolean;
}

export interface ExpectationProgress {
  index: number;
  atMs: number;
  that: string;
  expected: string;
  status: 'pending' | 'passed' | 'failed';
  actual?: unknown;
}

export interface ScenarioState {
  current: string | null;
  description?: string;
  tags: string[];
  offsetMs: number;
  stopped: boolean;
  stepCount: number;
  completedSteps: number;
  currentStep: number | null;
  durationMs: number;
  steps: TimelineProgress[];
  expectations: ExpectationProgress[];
  pendingSteps: number;
  pendingExpectations: number;
  results: Array<{ atMs: number; that: string; expected: string; actual: unknown; passed: boolean }>;
  passed: boolean;
}

/** The `hello` frame: enough to render a complete console without a second call. */
export interface HelloEvent {
  protocol: number;
  clientId: number;
  seed: number;
  flushMs: number;
  state: LiveState;
  scenario: ScenarioState;
  diff: Record<string, unknown>;
}

export interface RigEvents {
  hello: HelloEvent;
  tick: LiveState;
  control: { changes: ControlChange[] };
  action: { id: string; at: string };
  reset: { controls: Record<string, unknown>; state: LiveState };
  fault: { fault: ActiveFault; active: ActiveFault[] };
  scenario: ScenarioState;
}

export type RigEventName = keyof RigEvents;
