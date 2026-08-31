<script setup lang="ts">
/**
 * Live state, straight from the event stream.
 *
 * Power flows are shown with battery and grid marked derived, because the plant
 * model conserves energy and solves for them. Gen1's panel let all four be set
 * independently and would happily hold PV 6 kW, load 1 kW and grid import 5 kW
 * at once; showing them as ordinary editable numbers here would invite exactly
 * that misreading.
 */
import { computed } from 'vue';
import { rig } from '../api/rig.js';

const state = rig.state;
const plant = computed(() => state.value?.plant ?? null);
const faults = computed(() => state.value?.faults ?? []);

const watts = (w: number | undefined | null): string =>
  w === undefined || w === null ? '—' : `${w < 0 ? '−' : ''}${Math.abs(Math.round(w))} W`;

const gridLabel = computed(() => {
  const w = plant.value?.gridW;
  if (w === undefined) return '—';
  if (Math.abs(w) < 1) return '0 W';
  return `${watts(Math.abs(w))} ${w > 0 ? 'import' : 'export'}`;
});

const batteryLabel = computed(() => {
  const w = plant.value?.batteryW;
  if (w === undefined) return '—';
  if (Math.abs(w) < 1) return '0 W idle';
  return `${watts(Math.abs(w))} ${w > 0 ? 'discharge' : 'charge'}`;
});

const gridStatus = computed(() => {
  const s = plant.value?.gridStatus;
  return s === undefined ? '—' : s === 0 ? 'on-grid' : `off-grid (${s})`;
});
</script>

<template>
  <div class="grid">
    <section class="panel">
      <h2>Power flow</h2>
      <dl>
        <dt>PV</dt>
        <dd>{{ watts(plant?.totalPvW) }}</dd>
        <dt>load</dt>
        <dd>{{ watts(plant?.loadW) }}</dd>
        <dt>battery</dt>
        <dd class="derived-value">{{ batteryLabel }}</dd>
        <dt>grid</dt>
        <dd class="derived-value">{{ gridLabel }}</dd>
        <dt>curtailed</dt>
        <dd>{{ watts(plant?.curtailedW) }}</dd>
        <dt>reactive</dt>
        <dd>{{ plant ? Math.round(plant.reactiveVar) + ' var' : '—' }}</dd>
      </dl>
    </section>

    <section class="panel">
      <h2>Battery &amp; grid</h2>
      <dl>
        <dt>SoC</dt>
        <dd>{{ plant ? plant.socPct.toFixed(1) + ' %' : '—' }}</dd>
        <dt>SoH</dt>
        <dd>{{ plant ? plant.sohPct.toFixed(1) + ' %' : '—' }}</dd>
        <dt>cell temp</dt>
        <dd>{{ plant ? plant.batteryTempC.toFixed(1) + ' °C' : '—' }}</dd>
        <dt>grid status</dt>
        <dd>{{ gridStatus }}</dd>
        <dt>voltage</dt>
        <dd>{{ plant ? plant.gridVoltageV.toFixed(1) + ' V' : '—' }}</dd>
        <dt>frequency</dt>
        <dd>{{ plant ? plant.gridFrequencyHz.toFixed(2) + ' Hz' : '—' }}</dd>
      </dl>
    </section>

    <section class="panel">
      <h2>IEEE 1547 ride-through</h2>
      <dl>
        <dt>phase</dt>
        <dd>{{ plant?.gridSupport.phase ?? '—' }}</dd>
        <dt>elapsed</dt>
        <dd>{{ plant ? plant.gridSupport.elapsedS.toFixed(1) + ' s' : '—' }}</dd>
        <dt>power limit</dt>
        <dd>{{ plant ? (plant.gridSupport.powerLimit * 100).toFixed(0) + ' %' : '—' }}</dd>
        <dt>var target</dt>
        <dd>{{ plant ? plant.gridSupport.varTarget.toFixed(2) : '—' }}</dd>
        <dt>reason</dt>
        <dd>{{ plant?.gridSupport.reason ?? 'none' }}</dd>
      </dl>
    </section>

    <section class="panel">
      <h2>Device</h2>
      <dl>
        <dt>MCU</dt>
        <dd :class="state?.mcu.online ? '' : 'err'">{{ state?.mcu.online ? 'online' : 'offline' }}</dd>
        <dt>firmware</dt>
        <dd>{{ state?.mcu.fwVersion ?? '—' }}</dd>
        <dt>uptime</dt>
        <dd>{{ state ? Math.round(state.mcu.uptimeMs / 1000) + ' s' : '—' }}</dd>
        <dt>serial</dt>
        <dd>{{ state?.site.serialNumber ?? '—' }}</dd>
        <dt>EMS type</dt>
        <dd>{{ state?.site.emsType ?? '—' }}</dd>
        <dt>commissioning</dt>
        <dd>{{ state?.site.commissioningStatus ?? '—' }}</dd>
      </dl>
    </section>

    <section class="panel wide">
      <h2>Active faults ({{ faults.length }})</h2>
      <p v-if="faults.length === 0" class="muted">none</p>
      <ul v-else class="faults">
        <li v-for="f in faults" :key="f.code">
          <span class="mono code">{{ f.code }}</span>
          <span class="level" :class="`level-${f.level}`">{{ f.level }}</span>
          <span class="muted">{{ f.device }}</span>
          <span class="muted mono raised">{{ f.raisedAt }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.wide {
  grid-column: 1 / -1;
}

.faults {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.faults li {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.code {
  min-width: 80px;
}

.level {
  font-size: 10px;
  border-radius: 3px;
  padding: 1px 5px;
  border: 1px solid var(--line);
}

.level-F {
  color: var(--err);
  border-color: var(--err);
}

.level-A {
  color: var(--warn);
  border-color: var(--warn);
}

.level-W {
  color: var(--muted);
}

.raised {
  margin-left: auto;
  font-size: 11px;
}
</style>
