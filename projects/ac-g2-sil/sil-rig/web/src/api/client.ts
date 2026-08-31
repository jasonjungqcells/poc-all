import type {
  ControlChange,
  ControlListResponse,
  ControlValue,
  ClockState,
  LiveState,
  ScenarioState,
  ScenarioFacets,
  ScenarioSummary,
} from './types.js';

/**
 * Typed client for the control plane.
 *
 * This is the console's only way to reach the rig. There is no second channel
 * and no direct engine import, which is what makes the parity rule checkable
 * (`AC-GEN2-SIL-CONTROL-PLANE.md` §18) and what lets the console point at a rig
 * running on another machine without changing a line.
 *
 * Every method names the route it calls, so the mapping from a click to a
 * `curl` -- and from there to a `sil ctl` command -- stays legible.
 */

/** Base URL. Empty in production: the console is served by the control server. */
const BASE = import.meta.env.VITE_CONTROL_BASE ?? '';

export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    readonly control?: string,
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const payload = text.length > 0 ? safeParse(text) : undefined;

  if (!res.ok) {
    const record = (payload ?? {}) as Record<string, unknown>;
    // The control API answers with `{ error, control? }`; surfacing the control
    // id lets a form highlight the field that was rejected rather than showing
    // a toast that says something went wrong somewhere.
    throw new ControlApiError(
      res.status,
      path,
      String(record.error ?? record.message ?? `${method} ${path} failed (${res.status})`),
      record.control === undefined ? undefined : String(record.control),
    );
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);

export const api = {
  // ------------------------------------------------------------- controls
  listControls: (group?: string) =>
    get<ControlListResponse>(`/control${group ? `?group=${encodeURIComponent(group)}` : ''}`),
  getControl: (id: string) => get<ControlValue>(`/control/${encodeURIComponent(id)}`),
  setControl: (id: string, value: unknown) =>
    put<{ id: string; value: unknown }>(`/control/${encodeURIComponent(id)}`, { value }),
  /** Batched write: one atomic change, one line in the diff. */
  patchControls: (controls: Record<string, unknown>) =>
    patch<{ changed: number; changes: ControlChange[] }>('/control', { controls }),
  controlDiff: () => get<{ controls: Record<string, unknown> }>('/control/diff'),
  resetControls: () => post<{ reset: boolean }>('/control/reset'),

  // ---------------------------------------------------------------- clock
  clock: () => get<ClockState>('/clock'),
  stepClock: (ms: number | string) =>
    post<{ steppedMs: number; now: string; tick: number }>('/clock/step', { ms }),
  pauseClock: () => post<{ paused: boolean; now: string }>('/clock/pause'),
  resumeClock: (rate = 1) => post<{ paused: boolean; rate: number; now: string }>('/clock/resume', { rate }),

  // ------------------------------------------------------------ scenarios
  listScenarios: () => get<{ scenarios: ScenarioSummary[]; facets: ScenarioFacets }>('/scenarios'),
  getScenario: (name: string) => get<Record<string, unknown>>(`/scenarios/${encodeURIComponent(name)}`),
  loadScenario: (name: string) =>
    post<Record<string, unknown>>(`/scenarios/${encodeURIComponent(name)}/load`),
  stopScenario: () =>
    post<{ stopped: boolean; scenario: string | null; droppedSteps: number; droppedExpectations: number }>(
      '/scenarios/stop',
    ),
  reloadScenarios: () => post<{ reloaded: boolean; scenarios: number }>('/scenarios/reload'),
  scenarioState: () => get<ScenarioState>('/scenario/state'),
  /** Render the current session as a runnable scenario file. */
  exportScenario: (opts: { name?: string; description?: string; tags?: string[] } = {}) =>
    post<{ name: string; controls: number; faults: number; yaml: string }>('/scenario/export', opts),

  // --------------------------------------------------------------- faults
  faults: () =>
    get<{ active: unknown[]; catalog: unknown[]; cloudErrorCodes: unknown }>('/fault'),
  injectFault: (code: string, opts: { device?: string; level?: 'W' | 'A' | 'F' } = {}) =>
    post<Record<string, unknown>>('/fault/inject', { code, ...opts }),
  clearFault: (code: string) => post<Record<string, unknown>>('/fault/clear', { code }),
  clearAllFaults: () => post<Record<string, unknown>>('/fault/clear', { code: 'all' }),

  // ------------------------------------------------------------- snapshot
  snapshot: () => get<Record<string, unknown>>('/snapshot'),
  restoreSnapshot: (snapshot: Record<string, unknown>) =>
    post<{ restored: boolean; controls: number }>('/snapshot/restore', snapshot),

  // ---------------------------------------------------------------- state
  state: () => get<Record<string, unknown>>('/state'),
  liveState: () => get<LiveState>('/state') as Promise<LiveState>,

  // ----------------------------------------------------------- spi / can
  spiStatus: () => get<Record<string, unknown>>('/spi/status'),
  spiRead: (register: string) => get<Record<string, unknown>>(`/spi/read/${encodeURIComponent(register)}`),
  canStatus: () => get<Record<string, unknown>>('/can/status'),
  canFaults: () => get<Record<string, unknown>>('/can/faults'),
  canRegisters: (q?: string) =>
    get<Record<string, unknown>>(`/can/registers${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  canRead: (register: string) => get<Record<string, unknown>>(`/can/read/${encodeURIComponent(register)}`),
  canWrite: (register: string, body: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/can/write/${encodeURIComponent(register)}`, body),

  // --------------------------------------------------------------- events
  eventStats: () => get<{ clients: number; eventsSent: number; flushMs: number }>('/events/stats'),
};

export type ControlApi = typeof api;
