<script setup lang="ts">
/**
 * Transport bar.
 *
 * Time is the rig's most important control, so it lives in the chrome rather
 * than inside a panel someone has to navigate to. Every button here is a
 * `POST /clock/*` -- the same calls `sil clock` makes.
 */
import { computed, ref } from 'vue';
import { api } from '../api/client.js';
import { rig, describe } from '../api/rig.js';
import { cliFor } from '../api/actions.js';
import CliHint from './CliHint.vue';

const busy = ref(false);
const error = ref<string | null>(null);
const rate = ref(1);

const paused = computed(() => (rig.state.value?.clock.rate ?? 0) === 0);
const lastCli = ref<string>(cliFor('clock.pause'));

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await fn();
    lastCli.value = label;
  } catch (err) {
    error.value = describe(err);
  } finally {
    busy.value = false;
  }
}

const step = (by: string) =>
  run(cliFor('clock.step', { by }), () => api.stepClock(by));

const toggle = () =>
  paused.value
    ? run(cliFor('clock.resume', { rate: String(rate.value) }), () => api.resumeClock(rate.value))
    : run(cliFor('clock.pause'), () => api.pauseClock());

function setRate(next: number): void {
  rate.value = next;
  if (!paused.value) void run(cliFor('clock.resume', { rate: String(next) }), () => api.resumeClock(next));
}
</script>

<template>
  <div class="transport">
    <button :disabled="busy" class="primary" @click="toggle">
      {{ paused ? '▶ resume' : '⏸ pause' }}
    </button>
    <!-- Stepping is only meaningful while paused: with the clock running the
         rig is already advancing and a step just adds an unrepeatable jump. -->
    <span class="steps">
      <button v-for="by in ['1s', '1m', '15m', '1h']" :key="by" :disabled="busy" @click="step(by)">
        +{{ by }}
      </button>
    </span>
    <label class="rate">
      rate
      <select :value="rate" @change="setRate(Number(($event.target as HTMLSelectElement).value))">
        <option v-for="r in [0.5, 1, 2, 10, 60, 600]" :key="r" :value="r">{{ r }}×</option>
      </select>
    </label>
    <span class="mono muted tick">tick {{ rig.state.value?.clock.tick ?? '—' }}</span>
    <CliHint :command="lastCli" />
    <span v-if="error" class="err">{{ error }}</span>
  </div>
</template>

<style scoped>
.transport {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.steps {
  display: flex;
  gap: 4px;
}

.rate select {
  margin-left: 4px;
}

.tick {
  font-size: 12px;
}
</style>
