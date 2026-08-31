import { computed, effectScope, reactive, ref, shallowRef } from 'vue';
import { api, ControlApiError } from './client.js';
import { useRigStream, type RigStream } from './stream.js';
import type { ControlValue, ScenarioFacets, ScenarioSummary } from './types.js';

/**
 * The console's shared connection to one rig.
 *
 * A singleton because there is one rig and one event stream: every view reads
 * the same live state rather than opening its own SSE connection and drifting.
 * Created inside an `effectScope` so the stream's lifecycle hooks have a scope
 * to attach to outside of any component.
 */
const scope = effectScope(true);
let stream!: RigStream;
scope.run(() => {
  stream = useRigStream();
});

/** Controls, loaded once and refreshed on the events that can invalidate them. */
const controls = shallowRef<ControlValue[]>([]);
const groups = shallowRef<string[]>([]);
const diff = shallowRef<Record<string, unknown>>({});
const scenarios = shallowRef<ScenarioSummary[]>([]);
/** Filter definitions, counted by the rig: the console never derives its own. */
const scenarioFacets = shallowRef<ScenarioFacets | null>(null);
const loading = ref(false);
const lastError = ref<string | null>(null);

/** Values written since the last refresh, applied over the loaded list. */
const liveValues = reactive(new Map<string, unknown>());

export async function refreshControls(): Promise<void> {
  loading.value = true;
  try {
    const [list, d] = await Promise.all([api.listControls(), api.controlDiff()]);
    controls.value = list.controls;
    groups.value = list.groups;
    diff.value = d.controls;
    liveValues.clear();
  } catch (err) {
    lastError.value = describe(err);
  } finally {
    loading.value = false;
  }
}

export async function refreshDiff(): Promise<void> {
  try {
    diff.value = (await api.controlDiff()).controls;
  } catch (err) {
    lastError.value = describe(err);
  }
}

export async function refreshScenarios(): Promise<void> {
  try {
    const body = await api.listScenarios();
    scenarios.value = body.scenarios;
    scenarioFacets.value = body.facets;
  } catch (err) {
    lastError.value = describe(err);
  }
}

export function describe(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Keep control values current without refetching 197 of them on every write.
 *
 * The stream reports each change, so the list is patched in place. A full
 * refetch on every tick would be a request per second for data that mostly
 * did not change; a refetch on nothing at all would leave the browser showing
 * values a scenario has since overwritten.
 */
stream.on('control', ({ changes }) => {
  for (const change of changes) liveValues.set(change.id, change.value);
  // The diff is derived server-side, and a scenario step can change dozens of
  // controls at once, so it is refetched rather than recomputed here.
  scheduleDiffRefresh();
});
stream.on('reset', () => {
  liveValues.clear();
  void refreshControls();
});
stream.on('hello', (hello) => {
  diff.value = hello.diff;
});

let diffTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDiffRefresh(): void {
  if (diffTimer) return;
  diffTimer = setTimeout(() => {
    diffTimer = null;
    void refreshDiff();
  }, 500);
}

/** Current value of a control: the stream's view if it has one, else the load. */
export function valueOf(control: ControlValue): unknown {
  return liveValues.has(control.id) ? liveValues.get(control.id) : control.value;
}

export const rig = {
  stream,
  controls,
  groups,
  diff,
  scenarios,
  scenarioFacets,
  loading,
  lastError,
  liveValues,
  state: stream.state,
  scenario: stream.scenario,
  status: stream.status,
  seed: stream.seed,
  diffCount: computed(() => Object.keys(diff.value).length),
  refreshControls,
  refreshDiff,
  refreshScenarios,
  valueOf,
};
