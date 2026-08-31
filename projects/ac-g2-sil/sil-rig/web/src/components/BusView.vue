<script setup lang="ts">
/**
 * Wire-level views of the two buses.
 *
 * The REST surface only ever shows decoded values, which makes the framing
 * layer itself untestable: a CRC that is wrong in the sixteenth byte looks
 * exactly like a CRC that is right until you look at the bytes. This is the
 * equivalent of the SPI debugger used on real hardware, and the CAN register
 * browser the g4 map otherwise hides behind 833 names.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client.js';
import { cliFor } from '../api/actions.js';
import { describe } from '../api/rig.js';
import CliHint from './CliHint.vue';

const spi = ref<Record<string, unknown> | null>(null);
const spiRegister = ref('0x80');
const spiRead = ref<Record<string, unknown> | null>(null);

const canSummary = ref<Record<string, unknown> | null>(null);
const canQuery = ref('');
const canRegisters = ref<Array<{ id: string; address: string; group: string; metrics: number }>>([]);
const canSelected = ref<string | null>(null);
const canRead = ref<Record<string, unknown> | null>(null);
const canWriteBody = ref('{}');

const error = ref<string | null>(null);

onMounted(async () => {
  await Promise.all([loadSpi(), loadCan(), searchRegisters()]);
});

async function run(fn: () => Promise<unknown>): Promise<void> {
  error.value = null;
  try {
    await fn();
  } catch (err) {
    error.value = describe(err);
  }
}

const loadSpi = () => run(async () => (spi.value = await api.spiStatus()));
const loadCan = () => run(async () => (canSummary.value = await api.canStatus()));

const readSpi = () =>
  run(async () => {
    spiRead.value = await api.spiRead(spiRegister.value);
  });

const searchRegisters = () =>
  run(async () => {
    const body = (await api.canRegisters(canQuery.value || undefined)) as {
      registers: Array<{ id: string; address: string; group: string; metrics: number }>;
    };
    canRegisters.value = body.registers;
  });

const readRegister = (id: string) =>
  run(async () => {
    canSelected.value = id;
    canRead.value = await api.canRead(id);
  });

const writeRegister = () =>
  run(async () => {
    if (!canSelected.value) return;
    const body = JSON.parse(canWriteBody.value) as Record<string, unknown>;
    canRead.value = await api.canWrite(canSelected.value, body);
  });

/** Hex dumps read far better in fixed 16-byte rows than as one long string. */
function hexRows(hex: unknown): string[] {
  const text = String(hex ?? '');
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += 32) {
    const row = text.slice(i, i + 32);
    rows.push(`${(i / 2).toString(16).padStart(4, '0')}  ${row.match(/.{1,2}/g)?.join(' ') ?? ''}`);
  }
  return rows;
}

const spiDecoded = computed(() => (spi.value?.decoded ?? {}) as Record<string, unknown>);
const readDecoded = computed(() => (spiRead.value?.decoded ?? {}) as Record<string, unknown>);
</script>

<template>
  <div class="bus">
    <section class="panel">
      <h2>SPI — MPU ↔ MCU</h2>
      <dl>
        <dt>mode</dt>
        <dd>{{ spi?.mode ?? '—' }}</dd>
        <dt>frame length</dt>
        <dd>{{ spi?.actualLength ?? '—' }} / {{ spi?.expectedLength ?? '—' }}</dd>
        <dt>cmd</dt>
        <dd>{{ spiDecoded.cmd ?? '—' }}</dd>
        <dt>address</dt>
        <dd>{{ spiDecoded.address ?? '—' }}</dd>
        <dt>crc</dt>
        <!-- A frame whose length is right and whose CRC is wrong is the single
             most common framing bug, and the only place it is visible. -->
        <dd :class="spiDecoded.crcValid ? 'ok' : 'err'">
          {{ spiDecoded.crc ?? '—' }} {{ spiDecoded.crcValid ? 'valid' : 'INVALID' }}
        </dd>
      </dl>
      <pre class="hex mono">{{ hexRows(spi?.hex).join('\n') }}</pre>
      <div class="actions">
        <button @click="loadSpi">refresh</button>
        <CliHint command="sil spi status" />
      </div>

      <h3>Register read</h3>
      <div class="actions">
        <input v-model="spiRegister" class="mono" placeholder="0x80 or a name" />
        <button @click="readSpi">read</button>
        <CliHint :command="`sil spi read ${spiRegister}`" />
      </div>
      <template v-if="spiRead">
        <dl>
          <dt>register</dt>
          <dd>{{ spiRead.register }}</dd>
          <dt>address</dt>
          <dd>{{ spiRead.address }}</dd>
          <dt>crc</dt>
          <dd :class="readDecoded.crcValid ? 'ok' : 'err'">{{ readDecoded.crc }}</dd>
        </dl>
        <pre class="hex mono">{{ hexRows(spiRead.hex).join('\n') }}</pre>
        <pre class="json mono">{{ JSON.stringify(spiRead.metrics, null, 2) }}</pre>
      </template>
    </section>

    <section class="panel">
      <h2>CAN — MCU ↔ PCS / BDC / BMS</h2>
      <dl>
        <dt>online</dt>
        <dd :class="canSummary?.online ? 'ok' : 'err'">{{ canSummary?.online ? 'yes' : 'no' }}</dd>
        <dt>bus-off</dt>
        <dd :class="canSummary?.busOff ? 'err' : ''">{{ canSummary?.busOff ? 'yes' : 'no' }}</dd>
        <dt>PCS units</dt>
        <dd>{{ canSummary?.pcsCount ?? '—' }}</dd>
        <dt>uptime</dt>
        <dd>{{ canSummary ? Math.round(Number(canSummary.uptimeMs) / 1000) + ' s' : '—' }}</dd>
      </dl>

      <h3>Registers</h3>
      <div class="actions">
        <input
          v-model="canQuery"
          type="search"
          placeholder="search 833 registers"
          @keyup.enter="searchRegisters"
        />
        <button @click="searchRegisters">search</button>
      </div>
      <div class="registers">
        <button
          v-for="r in canRegisters"
          :key="r.id"
          class="reg"
          :class="{ on: canSelected === r.id }"
          @click="readRegister(r.id)"
        >
          <span class="mono">{{ r.id }}</span>
          <span class="muted mono">{{ r.address }} · {{ r.metrics }}</span>
        </button>
      </div>

      <template v-if="canSelected">
        <h3 class="mono">{{ canSelected }}</h3>
        <div class="actions">
          <CliHint :command="`sil can read ${canSelected}`" />
        </div>
        <pre class="json mono">{{ JSON.stringify(canRead, null, 2) }}</pre>
        <div class="actions">
          <input v-model="canWriteBody" class="mono grow" placeholder='{"Metric_Name": 42}' />
          <button @click="writeRegister">write</button>
          <CliHint :command="cliFor('can.write', { register: canSelected, json: canWriteBody })" />
        </div>
      </template>
    </section>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
.bus {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 14px;
  align-items: start;
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin: 8px 0;
}

.grow {
  flex: 1;
  min-width: 200px;
}

.hex,
.json {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  overflow: auto;
  max-height: 220px;
  margin: 8px 0 0;
}

.registers {
  display: grid;
  gap: 2px;
  max-height: 240px;
  overflow: auto;
}

.reg {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--line);
  color: var(--text);
  font-size: 11px;
  text-align: left;
  padding: 3px 4px;
}

.reg.on {
  background: rgba(77, 163, 255, 0.14);
}

.ok {
  color: var(--ok);
}

h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 16px 0 4px;
}
</style>
