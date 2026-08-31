<script setup lang="ts">
/**
 * The console shell.
 *
 * Routing is hash-based and hand-rolled: six views do not justify a router, and
 * a hash keeps a view linkable ("look at the fault tab on my rig") without any
 * server-side route handling, which matters because the console is served by
 * the control API and not by a web server that knows about it.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { rig } from './api/rig.js';
import TransportBar from './components/TransportBar.vue';
import StatePanel from './components/StatePanel.vue';
import ControlBrowser from './components/ControlBrowser.vue';
import ScenarioView from './components/ScenarioView.vue';
import FaultView from './components/FaultView.vue';
import ReproView from './components/ReproView.vue';
import BusView from './components/BusView.vue';

const TABS = [
  { id: 'state', label: 'State' },
  { id: 'controls', label: 'Controls' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'faults', label: 'Faults' },
  { id: 'repro', label: 'Repro' },
  { id: 'bus', label: 'Buses' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const tab = ref<TabId>(readHash());

function readHash(): TabId {
  const id = window.location.hash.replace('#', '') as TabId;
  return TABS.some((t) => t.id === id) ? id : 'state';
}

function onHashChange(): void {
  tab.value = readHash();
}

function select(id: TabId): void {
  tab.value = id;
  window.location.hash = id;
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange);
  void rig.refreshControls();
  void rig.refreshScenarios();
});
onUnmounted(() => window.removeEventListener('hashchange', onHashChange));

const clock = computed(() => rig.state.value?.clock ?? null);
const localTime = computed(() => {
  const now = clock.value?.now;
  if (!now) return '—';
  // The rig's clock is the device's clock, and a scenario may have set it to a
  // winter evening in another timezone. Showing it verbatim rather than in the
  // browser's locale keeps it the device's time, not the viewer's.
  return now.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
});
</script>

<template>
  <div class="app">
    <header class="bar">
      <h1>SIL rig console</h1>

      <span class="status">
        <span class="dot" :class="rig.status.value" />
        <span class="muted">{{ rig.status.value }}</span>
      </span>

      <span class="mono time">{{ localTime }}</span>

      <span class="muted">seed <span class="mono">{{ rig.seed.value ?? '—' }}</span></span>

      <span class="muted">
        scenario
        <span class="mono">{{ rig.scenario.value?.current ?? 'none' }}</span>
        <span v-if="rig.scenario.value?.current" class="mono">
          ({{ rig.scenario.value.completedSteps }}/{{ rig.scenario.value.stepCount }})
        </span>
      </span>

      <span class="muted">
        changed <span class="mono">{{ rig.diffCount.value }}</span>
      </span>

      <span class="spacer" />
      <TransportBar />
    </header>

    <nav class="tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        :class="{ on: tab === t.id }"
        @click="select(t.id)"
      >
        {{ t.label }}
      </button>
    </nav>

    <p v-if="rig.status.value === 'offline'" class="err offline">
      The event stream is closed. The rig may have stopped; the console reconnects on its own when
      it comes back.
    </p>

    <main>
      <StatePanel v-if="tab === 'state'" />
      <ControlBrowser v-else-if="tab === 'controls'" />
      <ScenarioView v-else-if="tab === 'scenarios'" />
      <FaultView v-else-if="tab === 'faults'" />
      <ReproView v-else-if="tab === 'repro'" />
      <BusView v-else-if="tab === 'bus'" />
    </main>

    <footer class="muted">
      A thin client of the control API on <span class="mono">:9114</span>. Everything here is also a
      <span class="mono">sil</span> command — nothing in this console can do what the CLI cannot.
    </footer>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
}

.time {
  font-size: 13px;
}

.spacer {
  flex: 1;
}

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
}

.tabs button {
  background: transparent;
  border: 1px solid transparent;
  border-bottom-color: var(--line);
  color: var(--muted);
  border-radius: 6px 6px 0 0;
  padding: 6px 14px;
}

.tabs button.on {
  color: var(--text);
  border-color: var(--line);
  border-bottom-color: transparent;
  background: var(--panel);
}

.offline {
  margin: 0 0 12px;
}

footer {
  margin-top: 28px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 11px;
}
</style>
