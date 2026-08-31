<script setup lang="ts">
/**
 * Scenarios: choosing one, and watching it run.
 *
 * The catalog is 157 files deep and the names are identifiers, not sentences,
 * so the first job of this view is to make a scenario legible before it is
 * loaded -- what kind of thing it is, what it touches, and whether it is a
 * static rig setup or a timed run. The second is to show the run in progress.
 *
 * Filters come from the rig (`GET /scenarios`), not from the tag list. Tags are
 * an author's vocabulary -- 88 of them, 80 appearing once or twice -- which
 * makes a filter list longer than the result list. The rig folds them onto two
 * short axes that map exactly onto `sil scenario list --kind --area`, so the
 * filter row is a visible form of a command rather than a browser-only trick.
 */
import { computed, onMounted, ref, watch } from 'vue';
import YAML from 'yaml';
import { api } from '../api/client.js';
import { cliFor } from '../api/actions.js';
import { rig, describe } from '../api/rig.js';
import type { ScenarioArea, ScenarioKind, ScenarioSummary } from '../api/types.js';
import CliHint from './CliHint.vue';

type Shape = 'any' | 'timed' | 'static';

const query = ref('');
const kind = ref<ScenarioKind | null>(null);
const area = ref<ScenarioArea | null>(null);
const shape = ref<Shape>('any');
const tag = ref<string | null>(null);
const selected = ref<string | null>(null);
const detail = ref<Record<string, unknown> | null>(null);
const showYaml = ref(false);
const showRun = ref(true);
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(() => {
  if (rig.scenarios.value.length === 0) void rig.refreshScenarios();
});

const facets = rig.scenarioFacets;
const state = rig.scenario;

const SHAPES: Array<{ id: Shape; label: string; hint: string }> = [
  { id: 'any', label: 'Any', hint: '' },
  { id: 'timed', label: 'Timed runs', hint: 'Scenarios with a timeline that plays out over virtual time' },
  { id: 'static', label: 'Static setups', hint: 'Scenarios that just put the rig in a state and stop there' },
];

/**
 * Facet counts are recomputed against the *other* active filters, so a chip
 * reading "12" always means twelve results if you click it. A static count is
 * a promise the list then breaks.
 */
function countBy<T extends string>(pick: (s: ScenarioSummary) => readonly T[], skip: 'kind' | 'area'): Map<T, number> {
  const tally = new Map<T, number>();
  for (const s of rig.scenarios.value) {
    if (!matches(s, { ignore: skip })) continue;
    for (const id of pick(s)) tally.set(id, (tally.get(id) ?? 0) + 1);
  }
  return tally;
}

function matches(s: ScenarioSummary, opts: { ignore?: 'kind' | 'area' } = {}): boolean {
  if (opts.ignore !== 'kind' && kind.value && s.kind !== kind.value) return false;
  if (opts.ignore !== 'area' && area.value && !s.areas.includes(area.value)) return false;
  if (shape.value === 'timed' && s.steps === 0) return false;
  if (shape.value === 'static' && s.steps > 0) return false;
  if (tag.value && !(s.tags ?? []).includes(tag.value)) return false;
  const q = query.value.trim().toLowerCase();
  if (q && !`${s.name} ${s.description ?? ''}`.toLowerCase().includes(q)) return false;
  return true;
}

const visible = computed(() => rig.scenarios.value.filter((s) => matches(s)));
const kindCounts = computed(() => countBy((s) => [s.kind], 'kind'));
const areaCounts = computed(() => countBy((s) => s.areas, 'area'));

const filtered = computed(
  () => Boolean(kind.value || area.value || tag.value || query.value.trim()) || shape.value !== 'any',
);

/** The one-line explanation of whatever is currently selected, in plain words. */
const activeHint = computed(() => {
  const parts: string[] = [];
  const k = facets.value?.kinds.find((f) => f.id === kind.value);
  const a = facets.value?.areas.find((f) => f.id === area.value);
  if (k) parts.push(k.hint);
  if (a) parts.push(a.hint);
  const sh = SHAPES.find((s) => s.id === shape.value);
  if (sh?.hint) parts.push(sh.hint);
  if (tag.value) parts.push(`Tagged \u201c${tag.value}\u201d`);
  return parts.join(' · ');
});

/** The same filter, as the command that produces it. */
const listCommand = computed(() => {
  const args = ['sil scenario list'];
  if (kind.value) args.push(`--kind ${kind.value}`);
  if (area.value) args.push(`--area ${area.value}`);
  if (tag.value) args.push(`--tag ${tag.value}`);
  if (shape.value === 'timed') args.push('--timed');
  const q = query.value.trim();
  if (q) args.push(`--search '${q}'`);
  return args.join(' ');
});

function clearFilters(): void {
  kind.value = null;
  area.value = null;
  tag.value = null;
  shape.value = 'any';
  query.value = '';
}

function kindLabel(id: ScenarioKind): string {
  return facets.value?.kinds.find((f) => f.id === id)?.label ?? id;
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = m / 60;
  return h < 48 ? `${h % 1 === 0 ? h : h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
}

/** What a scenario is, in one phrase. Two thirds of the corpus never runs. */
function shapeOf(s: ScenarioSummary): string {
  if (s.steps === 0) return 'static setup';
  const checks = s.expects > 0 ? ` · ${s.expects} check${s.expects === 1 ? '' : 's'}` : '';
  return `${humanMs(s.durationMs)} run · ${s.steps} step${s.steps === 1 ? '' : 's'}${checks}`;
}

// ------------------------------------------------------------------ detail

const detailDoc = computed(() => (detail.value ?? {}) as {
  description?: string;
  tags?: string[];
  extends?: string;
  clock?: { start?: string; rate?: number; timezone?: string; tickMs?: number };
  controls?: Record<string, unknown>;
  timeline?: Array<Record<string, unknown>>;
  expect?: Array<Record<string, unknown>>;
});

const selectedSummary = computed(() =>
  rig.scenarios.value.find((s) => s.name === selected.value) ?? null,
);

const detailControls = computed(() => Object.entries(detailDoc.value.controls ?? {}));

/**
 * A step, in words.
 *
 * This is generic rendering of the step object rather than a second copy of the
 * engine's summariser: it reads whatever keys are there. The authoritative
 * summary is the one the rig sends for the *running* scenario; this is a
 * preview of a file that has not been loaded yet.
 */
function stepWords(step: Record<string, unknown>): string {
  const parts: string[] = [];
  const set = step.set as Record<string, unknown> | undefined;
  if (set) {
    const keys = Object.keys(set);
    parts.push(
      keys.length <= 2
        ? keys.map((k) => `${k} = ${JSON.stringify(set[k])}`).join(', ')
        : `set ${keys.length} controls`,
    );
  }
  const inject = step.inject;
  if (inject) {
    const list = Array.isArray(inject) ? inject : [inject];
    parts.push(`inject ${list.map((f) => (f as { code: string }).code).join(', ')}`);
  }
  const clear = step.clear;
  if (clear) parts.push(`clear ${(Array.isArray(clear) ? clear : [clear]).join(', ')}`);
  return parts.join(' · ') || 'no-op';
}

function expectWords(e: Record<string, unknown>): string {
  if ('equals' in e) return `= ${JSON.stringify(e.equals)}`;
  if ('lessThan' in e) return `< ${e.lessThan}`;
  if ('greaterThan' in e) return `> ${e.greaterThan}`;
  if ('within' in e) return `within ${JSON.stringify(e.within)}`;
  return '';
}

const detailYaml = computed(() => (detail.value ? YAML.stringify(detail.value, { lineWidth: 96 }) : ''));

// ------------------------------------------------------------------- actions

async function select(name: string): Promise<void> {
  selected.value = name;
  detail.value = null;
  showYaml.value = false;
  try {
    detail.value = await api.getScenario(name);
  } catch (err) {
    error.value = describe(err);
  }
}

async function load(name: string): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await api.loadScenario(name);
    // Loading resets every control, so the browser's cached list is stale by
    // definition the moment this returns.
    await rig.refreshControls();
    showRun.value = true;
  } catch (err) {
    error.value = describe(err);
  } finally {
    busy.value = false;
  }
}

async function stop(): Promise<void> {
  try {
    await api.stopScenario();
  } catch (err) {
    error.value = describe(err);
  }
}

/** Pick up scenarios written since the rig started — an exported repro, usually. */
async function reload(): Promise<void> {
  try {
    await api.reloadScenarios();
    await rig.refreshScenarios();
  } catch (err) {
    error.value = describe(err);
  }
}

/** Arrow keys move through the results; Enter loads. */
function move(delta: number): void {
  const list = visible.value;
  if (list.length === 0) return;
  const at = list.findIndex((s) => s.name === selected.value);
  const next = list[Math.min(list.length - 1, Math.max(0, at + delta))] ?? list[0]!;
  void select(next.name);
  document.querySelector(`[data-scenario="${next.name}"]`)?.scrollIntoView({ block: 'nearest' });
}

// A filter change that hides the selection leaves the detail pane describing
// something no longer on screen.
watch(visible, (list) => {
  if (selected.value && !list.some((s) => s.name === selected.value)) selected.value = null;
});

// ---------------------------------------------------------------- run panel

const steps = computed(() => state.value?.steps ?? []);
const expectations = computed(() => state.value?.expectations ?? []);
const progressPct = computed(() => {
  const total = Number(state.value?.stepCount ?? 0);
  if (total === 0) return state.value?.current ? 100 : 0;
  return Math.round((Number(state.value?.completedSteps ?? 0) / total) * 100);
});
const runStatus = computed(() => {
  if (!state.value?.current) return { label: '', cls: '' };
  if (state.value.stopped) return { label: 'stopped', cls: 'warn' };
  if (state.value.stepCount === 0) return { label: 'loaded', cls: 'ok' };
  if (state.value.completedSteps >= state.value.stepCount) return { label: 'finished', cls: 'ok' };
  return { label: 'running', cls: 'live' };
});
const seconds = (ms: unknown): string => humanMs(Number(ms) || 0);
</script>

<template>
  <div class="scenarios">
    <!-- The run, when there is one. Full width, because it is the only thing
         on this screen that changes by itself. -->
    <section v-if="state?.current" class="panel run" :class="runStatus.cls">
      <header class="run-head">
        <div class="run-id">
          <span class="badge" :class="runStatus.cls">{{ runStatus.label }}</span>
          <span class="mono name">{{ state.current }}</span>
          <span v-if="state.description" class="muted desc">{{ state.description }}</span>
        </div>
        <div class="run-actions">
          <button :disabled="state.stopped" @click="stop">stop</button>
          <CliHint :command="cliFor('scenario.stop')" />
          <button v-if="state.stepCount" class="ghost" @click="showRun = !showRun">
            {{ showRun ? 'hide timeline' : 'show timeline' }}
          </button>
        </div>
      </header>

      <div class="progress"><div class="bar" :style="{ width: `${progressPct}%` }" /></div>
      <p class="run-meta muted">
        <span v-if="state.stepCount">step {{ state.completedSteps }} of {{ state.stepCount }}</span>
        <span v-else>no timeline — a static rig setup</span>
        <span>t+{{ seconds(state.offsetMs) }}</span>
        <span v-if="expectations.length" :class="state.passed ? 'ok' : 'err'">
          {{ state.passed ? 'all checks passing' : 'a check failed' }}
        </span>
      </p>

      <div v-if="showRun && (steps.length || expectations.length)" class="run-detail">
        <div v-if="steps.length">
          <h3>Timeline</h3>
          <ol class="timeline">
            <li
              v-for="step in steps"
              :key="String(step.index)"
              :class="{ done: step.done, now: step.index === state.currentStep }"
            >
              <span class="at mono">t+{{ seconds(step.atMs) }}</span>
              <span class="what">{{ step.note || step.summary }}</span>
              <span v-if="step.note && step.summary !== step.note" class="muted mono tiny">
                {{ step.summary }}
              </span>
            </li>
          </ol>
        </div>

        <div v-if="expectations.length">
          <h3>Checks</h3>
          <ul class="checks">
            <li v-for="e in expectations" :key="String(e.index)" :class="String(e.status)">
              <span class="at mono">t+{{ seconds(e.atMs) }}</span>
              <span class="mono grow">{{ e.that }} {{ e.expected }}</span>
              <span class="status">
                {{ e.status === 'pending' ? 'waiting' : e.status === 'passed' ? 'pass' : `fail — got ${JSON.stringify(e.actual)}` }}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- Browser -->
    <section class="panel browser">
      <header class="browser-head">
        <h2>Scenarios</h2>
        <input
          v-model="query"
          type="search"
          class="search"
          placeholder="search names and descriptions"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="selected && load(selected)"
        />
        <button class="ghost" title="Pick up scenario files written since the rig started" @click="reload">
          reload from disk
        </button>
        <CliHint :command="cliFor('scenario.reload')" />
      </header>

      <div class="facets">
        <div class="facet-row">
          <span class="facet-label">Kind</span>
          <button class="chip" :class="{ on: kind === null }" @click="kind = null">
            All <span class="n">{{ facets?.total ?? 0 }}</span>
          </button>
          <button
            v-for="f in facets?.kinds ?? []"
            :key="f.id"
            class="chip"
            :class="[f.id, { on: kind === f.id }]"
            :title="f.hint"
            :disabled="(kindCounts.get(f.id) ?? 0) === 0 && kind !== f.id"
            @click="kind = kind === f.id ? null : f.id"
          >
            {{ f.label }} <span class="n">{{ kindCounts.get(f.id) ?? 0 }}</span>
          </button>
        </div>

        <div class="facet-row">
          <span class="facet-label">Area</span>
          <button class="chip" :class="{ on: area === null }" @click="area = null">
            All <span class="n">{{ facets?.total ?? 0 }}</span>
          </button>
          <button
            v-for="f in facets?.areas ?? []"
            :key="f.id"
            class="chip"
            :class="{ on: area === f.id }"
            :title="f.hint"
            :disabled="(areaCounts.get(f.id) ?? 0) === 0 && area !== f.id"
            @click="area = area === f.id ? null : f.id"
          >
            {{ f.label }} <span class="n">{{ areaCounts.get(f.id) ?? 0 }}</span>
          </button>
        </div>

        <div class="facet-row">
          <span class="facet-label">Shape</span>
          <button
            v-for="s in SHAPES"
            :key="s.id"
            class="chip"
            :class="{ on: shape === s.id }"
            :title="s.hint"
            @click="shape = s.id"
          >
            {{ s.label }}
          </button>
          <button v-if="tag" class="chip tag on" @click="tag = null">tag: {{ tag }} ✕</button>
          <button v-if="filtered" class="chip clear" @click="clearFilters">clear filters</button>
        </div>

        <p v-if="activeHint" class="facet-hint">{{ activeHint }}</p>
        <div class="facet-cli">
          <span class="muted tiny">{{ visible.length }} of {{ facets?.total ?? 0 }} shown</span>
          <CliHint :command="listCommand" />
        </div>
      </div>

      <ul class="cards">
        <li v-for="s in visible" :key="s.name">
          <button
            class="card"
            :class="{ on: selected === s.name, running: state?.current === s.name }"
            :data-scenario="s.name"
            @click="select(s.name)"
            @dblclick="load(s.name)"
          >
            <span class="card-head">
              <span class="mono cname">{{ s.name }}</span>
              <span class="kind" :class="s.kind">{{ kindLabel(s.kind) }}</span>
            </span>
            <span class="cdesc">{{ s.description || 'No description.' }}</span>
            <span class="cmeta muted tiny">
              <span :class="{ timed: s.steps > 0 }">{{ shapeOf(s) }}</span>
              <span v-if="s.extends" class="mono">⇠ {{ s.extends }}</span>
              <span v-if="state?.current === s.name" class="ok">loaded</span>
            </span>
          </button>
        </li>
      </ul>

      <p v-if="visible.length === 0" class="empty muted">
        Nothing matches.
        <button class="ghost" @click="clearFilters">clear filters</button>
      </p>
      <p v-if="error" class="err">{{ error }}</p>
    </section>

    <!-- Inspector -->
    <aside class="panel inspect">
      <template v-if="selected">
        <h2 class="mono">{{ selected }}</h2>
        <p v-if="selectedSummary" class="badges">
          <span class="kind" :class="selectedSummary.kind">{{ kindLabel(selectedSummary.kind) }}</span>
          <span class="muted tiny">{{ shapeOf(selectedSummary) }}</span>
        </p>
        <p v-if="detailDoc.description" class="idesc">{{ detailDoc.description }}</p>

        <div class="actions">
          <button class="primary" :disabled="busy" @click="load(selected)">
            {{ busy ? 'loading…' : 'Load scenario' }}
          </button>
          <CliHint :command="cliFor('scenario.load', { name: selected })" />
        </div>
        <p class="muted tiny note">
          Loading resets every control first, so a scenario is a complete description of a rig and
          never a patch on whatever ran before it.
        </p>

        <template v-if="detailDoc.clock">
          <h3>Clock</h3>
          <p class="muted tiny">
            <span v-if="detailDoc.clock.start">starts {{ detailDoc.clock.start }}</span>
            <span v-if="detailDoc.clock.rate"> · {{ detailDoc.clock.rate }}× real time</span>
            <span v-if="detailDoc.clock.timezone"> · {{ detailDoc.clock.timezone }}</span>
          </p>
        </template>

        <template v-if="detailControls.length">
          <h3>Sets {{ detailControls.length }} control{{ detailControls.length === 1 ? '' : 's' }}</h3>
          <ul class="kv">
            <li v-for="[id, value] in detailControls" :key="id">
              <span class="mono k">{{ id }}</span>
              <span class="mono v">{{ JSON.stringify(value) }}</span>
            </li>
          </ul>
        </template>

        <template v-if="detailDoc.timeline?.length">
          <h3>Then, over time</h3>
          <ol class="preview">
            <li v-for="(step, i) in detailDoc.timeline" :key="i">
              <span class="at mono">t+{{ step.at }}</span>
              <span>
                {{ step.note || stepWords(step) }}
                <span v-if="step.note" class="muted tiny mono block">{{ stepWords(step) }}</span>
              </span>
            </li>
          </ol>
        </template>

        <template v-if="detailDoc.expect?.length">
          <h3>Checks</h3>
          <ol class="preview">
            <li v-for="(e, i) in detailDoc.expect" :key="i">
              <span class="at mono">t+{{ e.at }}</span>
              <span class="mono">{{ e.that }} {{ expectWords(e) }}</span>
            </li>
          </ol>
        </template>

        <template v-if="detailDoc.tags?.length">
          <h3>Tags</h3>
          <p class="tags">
            <button
              v-for="t in detailDoc.tags"
              :key="t"
              class="chip small"
              :class="{ on: tag === t }"
              title="Filter the list by this raw tag"
              @click="tag = tag === t ? null : t"
            >
              {{ t }}
            </button>
          </p>
        </template>

        <button class="ghost yaml-toggle" @click="showYaml = !showYaml">
          {{ showYaml ? 'hide' : 'show' }} resolved YAML
        </button>
        <pre v-if="showYaml" class="yaml mono">{{ detailYaml }}</pre>
      </template>

      <div v-else class="placeholder muted">
        <p>Pick a scenario to see what it does before you load it.</p>
        <p class="tiny">
          Filters narrow by what a scenario <em>is</em> and what it <em>touches</em>, not by raw
          tags. Every filter here is also a flag on <span class="mono">sil scenario list</span>.
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.scenarios {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 14px;
  align-items: start;
}

.run {
  grid-column: 1 / -1;
  border-left: 3px solid var(--line);
}

.run.live {
  border-left-color: var(--accent);
}

.run.ok {
  border-left-color: var(--ok);
}

.run.warn {
  border-left-color: var(--warn);
}

.run-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.run-id {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.run-id .name {
  font-size: 15px;
}

.run-id .desc {
  font-size: 12px;
}

.run-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
}

.badge.live {
  color: var(--accent);
}

.badge.ok {
  color: var(--ok);
}

.badge.warn {
  color: var(--warn);
}

.progress {
  height: 4px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
  margin: 10px 0 6px;
}

.bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s linear;
}

.run-meta {
  font-size: 12px;
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin: 0;
}

.run-detail {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 18px;
  margin-top: 10px;
}

/* ----------------------------------------------------------------- browser */

.browser-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.browser-head h2 {
  margin: 0;
}

.search {
  flex: 1;
  min-width: 200px;
}

.facets {
  margin: 12px 0 4px;
  padding: 10px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.facet-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.facet-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
  width: 42px;
  flex: none;
}

.chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--muted);
}

.chip:hover:not(:disabled) {
  border-color: var(--muted);
  color: var(--text);
}

.chip:disabled {
  opacity: 0.3;
}

.chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(77, 163, 255, 0.1);
}

.chip .n {
  opacity: 0.6;
  margin-left: 3px;
}

.chip.clear {
  border-style: dashed;
}

.chip.small {
  font-size: 10px;
}

.facet-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--muted);
  border-top: 1px solid var(--line);
  padding-top: 7px;
}

.facet-cli {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}

/* ------------------------------------------------------------------- cards */

.cards {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
  gap: 8px;
  max-height: 62vh;
  overflow: auto;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  height: 100%;
  text-align: left;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 10px;
  color: var(--text);
}

.card:hover {
  border-color: var(--muted);
}

.card.on {
  border-color: var(--accent);
  background: rgba(77, 163, 255, 0.08);
}

.card.running {
  box-shadow: inset 3px 0 0 var(--ok);
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.cname {
  font-size: 12px;
  word-break: break-word;
}

.cdesc {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.cmeta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: auto;
}

.cmeta .timed {
  color: var(--accent);
}

.kind {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid currentColor;
  color: var(--muted);
  white-space: nowrap;
  flex: none;
}

.kind.failure {
  color: var(--err);
}

.kind.boundary {
  color: var(--warn);
}

.kind.degraded {
  color: #d08770;
}

.kind.conformance {
  color: var(--accent);
}

.kind.endurance {
  color: #b48ead;
}

.kind.nominal {
  color: var(--ok);
}

.empty {
  margin-top: 16px;
  font-size: 13px;
}

/* --------------------------------------------------------------- inspector */

.inspect {
  position: sticky;
  top: 12px;
  max-height: 86vh;
  overflow: auto;
}

.inspect h2 {
  font-size: 13px;
  word-break: break-word;
  margin: 0 0 6px;
}

.badges {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
}

.idesc {
  font-size: 12px;
  line-height: 1.45;
  margin: 0 0 10px;
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin: 10px 0 4px;
}

.note {
  line-height: 1.4;
}

.kv {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 11px;
}

.kv li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0;
  border-bottom: 1px solid var(--line);
}

.kv .k {
  color: var(--muted);
  word-break: break-all;
}

.kv .v {
  color: var(--text);
  white-space: nowrap;
}

.preview {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 11px;
}

.preview li {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  line-height: 1.35;
}

.block {
  display: block;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
}

.yaml-toggle {
  margin-top: 14px;
}

.yaml {
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  margin-top: 8px;
}

.placeholder {
  font-size: 12px;
  line-height: 1.5;
}

/* -------------------------------------------------------- timeline / checks */

.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  border-left: 1px solid var(--line);
}

.timeline li {
  padding: 4px 0 4px 14px;
  position: relative;
  color: var(--muted);
  font-size: 12px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.timeline li::before {
  content: '';
  position: absolute;
  left: -4px;
  top: 11px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line);
}

.timeline li.done {
  color: var(--text);
}

.timeline li.done::before {
  background: var(--ok);
}

.timeline li.now::before {
  background: var(--accent);
  box-shadow: 0 0 0 3px rgba(77, 163, 255, 0.25);
}

.at {
  min-width: 52px;
  color: var(--muted);
  flex: none;
}

.checks {
  list-style: none;
  margin: 0;
  padding: 0;
}

.checks li {
  display: flex;
  gap: 10px;
  font-size: 12px;
  padding: 3px 0;
  align-items: baseline;
}

.grow {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.checks li.passed .status {
  color: var(--ok);
}

.checks li.failed .status {
  color: var(--err);
}

.checks li.pending .status {
  color: var(--muted);
}

.status {
  white-space: nowrap;
}

.tiny {
  font-size: 10px;
}

.ok {
  color: var(--ok);
}

h3 {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 16px 0 6px;
}

@media (max-width: 1100px) {
  .scenarios {
    grid-template-columns: minmax(0, 1fr);
  }

  .inspect {
    position: static;
    max-height: none;
  }
}
</style>
