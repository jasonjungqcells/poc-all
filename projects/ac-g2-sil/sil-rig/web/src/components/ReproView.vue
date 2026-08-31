<script setup lang="ts">
/**
 * Turning a session into something someone else can run.
 *
 * This view is where the parity rule pays for itself. A bug found by clicking
 * is worth very little; the same bug as a scenario file is worth a lot, because
 * it runs in CI, on another machine, and after the code that caused it has
 * changed. Both artifacts here are produced by the control plane, not by the
 * browser -- the console only asks for them.
 */
import { computed, ref } from 'vue';
import { api } from '../api/client.js';
import { cliFor } from '../api/actions.js';
import { rig, describe } from '../api/rig.js';
import CliHint from './CliHint.vue';

const name = ref('');
const description = ref('');
const yaml = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const restored = ref<string | null>(null);

async function run(fn: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await fn();
  } catch (err) {
    error.value = describe(err);
  } finally {
    busy.value = false;
  }
}

const exportScenario = () =>
  run(async () => {
    const body = await api.exportScenario({
      name: name.value || undefined,
      description: description.value || undefined,
    });
    yaml.value = body.yaml;
    name.value = body.name;
  });

function download(filename: string, content: string, type = 'text/yaml'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const saveSnapshot = () =>
  run(async () => {
    const snap = await api.snapshot();
    download(`snapshot-${Date.now()}.json`, JSON.stringify(snap, null, 2), 'application/json');
  });

async function restore(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await run(async () => {
    const body = JSON.parse(await file.text()) as Record<string, unknown>;
    const result = await api.restoreSnapshot(body);
    restored.value = `restored ${result.controls} controls from ${file.name}`;
    await rig.refreshControls();
  });
}

const exportCli = computed(() => cliFor('scenario.export', { file: `${name.value || 'repro'}.yaml` }));
</script>

<template>
  <div class="repro">
    <section class="panel">
      <h2>Export this session as a scenario</h2>
      <p class="muted note">
        Everything currently differing from a default rig ({{ rig.diffCount.value }} controls) plus
        the seed, the clock, and any active faults. Reloading the file reproduces this rig exactly;
        attach it to the ticket instead of a screenshot.
      </p>
      <div class="fields">
        <label>
          name
          <input v-model="name" type="text" class="mono" placeholder="repro_20260830_2210" />
        </label>
        <label>
          description
          <input v-model="description" type="text" placeholder="what went wrong" />
        </label>
      </div>
      <div class="actions">
        <button class="primary" :disabled="busy" @click="exportScenario">export</button>
        <button v-if="yaml" @click="download(`${name || 'repro'}.yaml`, yaml)">download</button>
        <CliHint :command="exportCli" />
      </div>
      <pre v-if="yaml" class="yaml mono">{{ yaml }}</pre>
    </section>

    <section class="panel">
      <h2>Snapshots</h2>
      <p class="muted note">
        A snapshot is the heavier artifact: every control value, the plant state, the clock and the
        active faults, as JSON. Use it to park a rig mid-investigation; use a scenario to describe
        one.
      </p>
      <div class="actions">
        <button :disabled="busy" @click="saveSnapshot">save</button>
        <CliHint :command="cliFor('snapshot.save', { file: 'snapshot.json' })" />
      </div>
      <div class="actions">
        <label class="file">
          restore…
          <input type="file" accept="application/json,.json" @change="restore" />
        </label>
        <CliHint :command="cliFor('snapshot.restore', { file: 'snapshot.json' })" />
      </div>
      <p v-if="restored" class="ok">{{ restored }}</p>
      <p v-if="error" class="err">{{ error }}</p>
    </section>
  </div>
</template>

<style scoped>
.repro {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.fields {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
}

.fields label {
  display: grid;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.file {
  border: 1px solid var(--line);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.file input {
  display: none;
}

.yaml {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  max-height: 50vh;
  overflow: auto;
  white-space: pre-wrap;
}

.note {
  font-size: 12px;
}

.ok {
  color: var(--ok);
}
</style>
