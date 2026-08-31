<script setup lang="ts">
/**
 * Faults, in both of the forms the hardware actually has them.
 *
 * The EMS codebook is a list of named codes with a device and a severity. The
 * g4 CAN map is not: its faults are bits in flag bytes, 768 per PCS unit, most
 * of them unnamed. Gen1's HMI needed two tabs for this and it was right to --
 * a taxonomy always lags the firmware, so the raw byte grid is kept as the
 * escape hatch for conditions nobody has named yet.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client.js';
import { cliFor } from '../api/actions.js';
import { rig, describe } from '../api/rig.js';
import CliHint from './CliHint.vue';

interface FaultDef {
  code: string;
  device: string;
  level: string;
  bucket?: string;
  description: string;
}

const catalog = ref<FaultDef[]>([]);
const query = ref('');
const device = ref('');
const level = ref('');
const error = ref<string | null>(null);

const canFlags = ref<{
  active: string[];
  bytes: Record<string, Record<string, string>>;
  domains: string[];
  severities: string[];
  totalAddressableBits?: number;
} | null>(null);
const flagCodeInput = ref('');
const activeCodes = computed(() => new Set(rig.state.value?.faults.map((f) => f.code) ?? []));

onMounted(async () => {
  await Promise.all([loadCatalog(), loadCanFlags()]);
});

async function loadCatalog(): Promise<void> {
  try {
    const body = await api.faults();
    catalog.value = (body.catalog as FaultDef[]) ?? [];
  } catch (err) {
    error.value = describe(err);
  }
}

async function loadCanFlags(): Promise<void> {
  try {
    canFlags.value = (await api.canFaults()) as typeof canFlags.value;
  } catch (err) {
    error.value = describe(err);
  }
}

const devices = computed(() => [...new Set(catalog.value.map((f) => f.device))].sort());

const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  return catalog.value.filter((f) => {
    if (device.value && f.device !== device.value) return false;
    if (level.value && f.level !== level.value) return false;
    if (!q) return true;
    return f.code.toLowerCase().includes(q) || f.description.toLowerCase().includes(q);
  });
});

async function run(fn: () => Promise<unknown>): Promise<void> {
  error.value = null;
  try {
    await fn();
  } catch (err) {
    error.value = describe(err);
  }
}

const inject = (f: FaultDef) => run(() => api.injectFault(f.code, { device: f.device, level: f.level as 'W' }));
const clear = (code: string) => run(() => api.clearFault(code));
const clearAll = () => run(() => api.clearAllFaults());

// --- CAN flags ------------------------------------------------------------
const setFlagCodes = () =>
  run(async () => {
    const codes = flagCodeInput.value.split(/[\s,]+/).filter(Boolean);
    if (codes.length === 0) return;
    await api.setControl('can.flag.set', codes);
    await loadCanFlags();
  });

const clearFlagCodes = () =>
  run(async () => {
    const codes = flagCodeInput.value.split(/[\s,]+/).filter(Boolean);
    if (codes.length === 0) return;
    await api.setControl('can.flag.clear', codes);
    await loadCanFlags();
  });

const clearAllFlags = () =>
  run(async () => {
    await api.setControl('can.flag.clear_all', true);
    await loadCanFlags();
  });

/** Write one raw flag byte, the Gen1 hex-grid path. */
const setByte = (pcs: string, metric: string, hex: string) =>
  run(async () => {
    // `P01` + `Grid_Fault_Flag3` is the wire naming; the control id that writes
    // it is `can.flag.byte.1.Grid.Fault.3`.
    const m = /^(\w+)_(\w+)_Flag(\d+)$/.exec(metric);
    if (!m) throw new Error(`unparsable flag metric: ${metric}`);
    const unit = Number(pcs.replace(/\D/g, ''));
    const value = Number.parseInt(hex.replace(/^0x/i, ''), 16);
    if (Number.isNaN(value)) throw new Error(`not a hex byte: ${hex}`);
    await api.setControl(`can.flag.byte.${unit}.${m[1]}.${m[2]}.${m[3]}`, value);
    await loadCanFlags();
  });
</script>

<template>
  <div class="faults">
    <section class="panel active">
      <h2>Active ({{ rig.state.value?.faults.length ?? 0 }})</h2>
      <div class="actions">
        <button class="danger" @click="clearAll">clear all</button>
        <CliHint :command="cliFor('fault.clearAll')" />
      </div>
      <p v-if="(rig.state.value?.faults.length ?? 0) === 0" class="muted">none</p>
      <ul v-else class="active-list">
        <li v-for="f in rig.state.value?.faults ?? []" :key="f.code">
          <span class="mono">{{ f.code }}</span>
          <span class="muted">{{ f.device }}</span>
          <span class="level" :class="`level-${f.level}`">{{ f.level }}</span>
          <button class="link" @click="clear(f.code)">clear</button>
        </li>
      </ul>
    </section>

    <section class="panel catalog">
      <h2>Codebook ({{ visible.length }} of {{ catalog.length }})</h2>
      <div class="toolbar">
        <input v-model="query" type="search" placeholder="search code or description" />
        <select v-model="device">
          <option value="">all devices</option>
          <option v-for="d in devices" :key="d" :value="d">{{ d }}</option>
        </select>
        <select v-model="level">
          <option value="">all levels</option>
          <option value="F">F — fault</option>
          <option value="A">A — alarm</option>
          <option value="W">W — warning</option>
        </select>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
      <div class="rows">
        <div v-for="f in visible" :key="f.code" class="row" :class="{ on: activeCodes.has(f.code) }">
          <span class="mono code">{{ f.code }}</span>
          <span class="level" :class="`level-${f.level}`">{{ f.level }}</span>
          <span class="muted dev">{{ f.device }}</span>
          <span class="desc">{{ f.description }}</span>
          <button v-if="activeCodes.has(f.code)" class="link" @click="clear(f.code)">clear</button>
          <button v-else class="link" @click="inject(f)">inject</button>
        </div>
      </div>
    </section>

    <section class="panel can">
      <h2>
        CAN flag bits
        <span class="muted">
          — {{ canFlags?.active.length ?? 0 }} set of {{ canFlags?.totalAddressableBits ?? '…' }}
        </span>
      </h2>
      <p class="muted note">
        Codes are <span class="mono">{G|P|D|M}{PCS}{bit}{F|W|A}</span>: domain, unit, bit index,
        severity. Every bit is settable <em>and</em> clearable, which the Gen1 panel could not do.
      </p>

      <div class="toolbar">
        <input
          v-model="flagCodeInput"
          type="text"
          class="mono"
          placeholder="G01001F P01502W  (space or comma separated)"
        />
        <button @click="setFlagCodes">set</button>
        <button @click="clearFlagCodes">clear</button>
        <button class="danger" @click="clearAllFlags">clear all bits</button>
      </div>

      <div v-if="canFlags?.active.length" class="active-codes">
        <button
          v-for="code in canFlags.active"
          :key="code"
          class="chip"
          title="put this code in the box"
          @click="flagCodeInput = code"
        >
          {{ code }}
        </button>
      </div>

      <h3>Raw bytes</h3>
      <p v-if="!canFlags || Object.keys(canFlags.bytes).length === 0" class="muted">
        no flag bytes set — write a code above, or type a hex byte below once bits exist
      </p>
      <div v-for="(metrics, pcs) in canFlags?.bytes ?? {}" :key="pcs" class="unit">
        <h4 class="mono">{{ pcs }}</h4>
        <div class="bytes">
          <label v-for="(hex, metric) in metrics" :key="metric" class="byte">
            <span class="mono muted">{{ metric }}</span>
            <input
              class="mono"
              :value="hex"
              @change="setByte(String(pcs), String(metric), ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.faults {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.can {
  grid-column: 1 / -1;
}

.active {
  position: sticky;
  top: 12px;
}

.active-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.active-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  padding: 3px 0;
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.toolbar input[type='search'],
.toolbar input[type='text'] {
  flex: 1;
  min-width: 220px;
}

.rows {
  max-height: 58vh;
  overflow: auto;
}

.row {
  display: grid;
  grid-template-columns: 70px 26px 90px 1fr 54px;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--line);
}

.row.on {
  background: rgba(229, 84, 75, 0.1);
}

.desc {
  color: var(--muted);
}

.level {
  font-size: 10px;
  border-radius: 3px;
  padding: 0 4px;
  border: 1px solid var(--line);
  text-align: center;
}

.level-F {
  color: var(--err);
  border-color: var(--err);
}

.level-A {
  color: var(--warn);
  border-color: var(--warn);
}

.active-codes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
}

.chip {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 6px;
  background: transparent;
  border: 1px solid var(--err);
  color: var(--err);
}

.unit {
  margin-top: 10px;
}

.bytes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 6px;
}

.byte {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
}

.byte input {
  width: 70px;
}

.note {
  font-size: 11px;
  margin-top: -4px;
}

h3,
h4 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 14px 0 6px;
}
</style>
