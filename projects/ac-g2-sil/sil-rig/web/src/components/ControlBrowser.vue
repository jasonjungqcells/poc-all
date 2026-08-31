<script setup lang="ts">
/**
 * The control browser.
 *
 * Edits stage locally and commit as one `PATCH /control`. That is not a UI
 * nicety: the control API validates a patch in full before committing any of
 * it, so a batch of forty with one bad value leaves the rig untouched instead
 * of half-applied, and the whole change lands as a single entry in the diff.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client.js';
import { cliFor } from '../api/actions.js';
import { rig, describe } from '../api/rig.js';
import type { ControlValue } from '../api/types.js';
import ControlWidget from './ControlWidget.vue';
import CliHint from './CliHint.vue';

const query = ref('');
const activeGroup = ref<string | null>(null);
const showDirtyOnly = ref(false);
const staged = ref<Record<string, unknown>>({});
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(() => {
  if (rig.controls.value.length === 0) void rig.refreshControls();
});

const groupCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const c of rig.controls.value) counts.set(c.group, (counts.get(c.group) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
});

const visible = computed<ControlValue[]>(() => {
  const q = query.value.trim().toLowerCase();
  const dirty = rig.diff.value;
  return rig.controls.value.filter((c) => {
    if (showDirtyOnly.value && !(c.id in dirty) && !(c.id in staged.value)) return false;
    // A search is a search: typing narrows across every group, because the id
    // of a control is usually remembered before the group it lives in.
    if (activeGroup.value && !q && c.group !== activeGroup.value) return false;
    if (!q) return true;
    return c.id.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
  });
});

const stagedCount = computed(() => Object.keys(staged.value).length);

function stage(id: string, value: unknown): void {
  const control = rig.controls.value.find((c) => c.id === id);
  // Staging a value equal to the live one is a no-op that would otherwise show
  // as a pending edit and land as an empty patch.
  if (control && rig.valueOf(control) === value) {
    const { [id]: _dropped, ...rest } = staged.value;
    staged.value = rest;
    return;
  }
  staged.value = { ...staged.value, [id]: value };
}

function valueFor(control: ControlValue): unknown {
  return control.id in staged.value ? staged.value[control.id] : rig.valueOf(control);
}

async function apply(): Promise<void> {
  if (stagedCount.value === 0) return;
  busy.value = true;
  error.value = null;
  try {
    await api.patchControls(staged.value);
    staged.value = {};
    await rig.refreshDiff();
  } catch (err) {
    error.value = describe(err);
  } finally {
    busy.value = false;
  }
}

async function invoke(id: string): Promise<void> {
  error.value = null;
  try {
    await api.setControl(id, true);
  } catch (err) {
    error.value = describe(err);
  }
}

async function revert(id: string): Promise<void> {
  const control = rig.controls.value.find((c) => c.id === id);
  if (!control) return;
  try {
    await api.setControl(id, control.default ?? null);
    await rig.refreshDiff();
  } catch (err) {
    error.value = describe(err);
  }
}

async function resetAll(): Promise<void> {
  if (!confirm('Reset every control to its default? Faults and latched flags clear too.')) return;
  try {
    await api.resetControls();
    staged.value = {};
    await rig.refreshControls();
  } catch (err) {
    error.value = describe(err);
  }
}

const patchCli = computed(() => cliFor('control.patch', { json: JSON.stringify(staged.value) }));
</script>

<template>
  <div class="browser">
    <aside class="groups panel">
      <h2>Groups</h2>
      <button class="group" :class="{ on: activeGroup === null }" @click="activeGroup = null">
        <span>all</span><span class="mono muted">{{ rig.controls.value.length }}</span>
      </button>
      <button
        v-for="[group, count] in groupCounts"
        :key="group"
        class="group"
        :class="{ on: activeGroup === group }"
        @click="activeGroup = group"
      >
        <span class="mono">{{ group }}</span><span class="mono muted">{{ count }}</span>
      </button>
    </aside>

    <section class="list panel">
      <div class="toolbar">
        <input v-model="query" type="search" placeholder="search id or description" class="search" />
        <label class="check">
          <input v-model="showDirtyOnly" type="checkbox" />
          changed only ({{ rig.diffCount.value }})
        </label>
        <span class="spacer" />
        <button :disabled="busy || stagedCount === 0" class="primary" @click="apply">
          apply {{ stagedCount || '' }} {{ stagedCount === 1 ? 'edit' : 'edits' }}
        </button>
        <button :disabled="stagedCount === 0" @click="staged = {}">discard</button>
        <button class="danger" @click="resetAll">reset all</button>
      </div>

      <div v-if="stagedCount > 0" class="staged-bar">
        <CliHint :command="patchCli" />
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <p v-if="rig.loading.value" class="muted">loading controls…</p>
      <p v-else-if="visible.length === 0" class="muted">nothing matches</p>

      <ControlWidget
        v-for="control in visible"
        :key="control.id"
        :control="control"
        :value="valueFor(control)"
        :staged="control.id in staged"
        @stage="stage"
        @invoke="invoke"
      />
    </section>

    <aside class="diff panel">
      <h2>Changed from default ({{ rig.diffCount.value }})</h2>
      <p class="muted hint">
        This is the whole bug report: everything here differs from a fresh rig.
      </p>
      <p v-if="rig.diffCount.value === 0" class="muted">nothing — this is a default rig</p>
      <ul v-else>
        <li v-for="(value, id) in rig.diff.value" :key="id">
          <button class="link" :title="`show ${id}`" @click="query = String(id)">
            <code>{{ id }}</code>
          </button>
          <span class="mono val">{{ JSON.stringify(value) }}</span>
          <button class="link revert" title="restore default" @click="revert(String(id))">revert</button>
        </li>
      </ul>
    </aside>
  </div>
</template>

<style scoped>
.browser {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 260px;
  gap: 14px;
  align-items: start;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: sticky;
  top: 12px;
}

.group {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  background: transparent;
  border: 0;
  text-align: left;
  padding: 4px 6px;
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
}

.group.on {
  background: rgba(77, 163, 255, 0.14);
  color: var(--accent);
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.search {
  min-width: 220px;
  flex: 1;
}

.check {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  gap: 5px;
  align-items: center;
}

.spacer {
  flex: 1;
}

.staged-bar {
  margin-bottom: 8px;
}

.diff {
  position: sticky;
  top: 12px;
  max-height: 80vh;
  overflow: auto;
}

.diff ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.diff li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 5px;
}

.diff code {
  font-size: 11px;
  word-break: break-all;
}

.val {
  grid-column: 1 / -1;
  color: var(--accent);
  font-size: 11px;
}

.hint {
  font-size: 11px;
  margin-top: -4px;
}

.revert {
  font-size: 11px;
}
</style>
