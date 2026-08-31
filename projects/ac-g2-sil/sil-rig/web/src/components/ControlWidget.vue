<script setup lang="ts">
/**
 * One control, rendered from its definition.
 *
 * Widgets are generated rather than written per control: there are 197 today,
 * the register maps keep growing, and a hand-written panel would be out of date
 * the first time someone adds a lever. A new control appears here as soon as it
 * exists in `CONTROL_DEFS`, with its bounds and units already enforced.
 */
import { computed } from 'vue';
import type { ControlValue } from '../api/types.js';

const props = defineProps<{
  control: ControlValue;
  value: unknown;
  staged: boolean;
}>();

const emit = defineEmits<{
  (e: 'stage', id: string, value: unknown): void;
  (e: 'invoke', id: string): void;
}>();

const def = computed(() => props.control);

const asNumber = computed(() => (props.value === undefined ? '' : Number(props.value)));
const asString = computed(() => (props.value === undefined || props.value === null ? '' : String(props.value)));
const asJson = computed(() => {
  try {
    return JSON.stringify(props.value ?? null, null, 2);
  } catch {
    return String(props.value);
  }
});

const bounds = computed(() => {
  const { min, max, unit } = def.value;
  const parts: string[] = [];
  if (min !== undefined || max !== undefined) parts.push(`${min ?? '−∞'} … ${max ?? '∞'}`);
  if (unit) parts.push(unit);
  return parts.join(' ');
});

function stageNumber(raw: string): void {
  if (raw === '') return;
  emit('stage', def.value.id, Number(raw));
}

function stageJson(raw: string): void {
  try {
    emit('stage', def.value.id, JSON.parse(raw));
  } catch {
    // Invalid JSON is a half-typed object, not a mistake worth interrupting
    // for; the field keeps its text and nothing is staged until it parses.
  }
}
</script>

<template>
  <div class="control" :class="{ staged, readonly: def.readOnly }">
    <div class="meta">
      <code class="id">{{ def.id }}</code>
      <span class="desc muted">{{ def.description }}</span>
      <span v-if="bounds" class="bounds muted mono">{{ bounds }}</span>
      <span v-if="def.appliesTo?.length" class="applies muted" :title="def.appliesTo.join(', ')">
        → {{ def.appliesTo[0] }}{{ def.appliesTo.length > 1 ? ` +${def.appliesTo.length - 1}` : '' }}
      </span>
    </div>

    <div class="widget">
      <!-- Derived values are shown, never offered for editing: the plant solves
           for them, and a write would be silently refused by the registry. -->
      <span v-if="def.readOnly" class="mono derived-value">{{ asString || '—' }}</span>

      <button v-else-if="def.type === 'action'" class="primary" @click="emit('invoke', def.id)">
        invoke
      </button>

      <label v-else-if="def.type === 'boolean'" class="toggle">
        <input
          type="checkbox"
          :checked="value === true"
          @change="emit('stage', def.id, ($event.target as HTMLInputElement).checked)"
        />
        <span class="mono">{{ value === true ? 'true' : 'false' }}</span>
      </label>

      <select
        v-else-if="def.type === 'enum'"
        :value="asString"
        @change="emit('stage', def.id, ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="option in def.values ?? []" :key="String(option)" :value="String(option)">
          {{ option }}
        </option>
      </select>

      <input
        v-else-if="def.type === 'number' || def.type === 'integer'"
        type="number"
        class="mono"
        :value="asNumber"
        :min="def.min"
        :max="def.max"
        :step="def.type === 'integer' ? 1 : 'any'"
        @change="stageNumber(($event.target as HTMLInputElement).value)"
      />

      <textarea
        v-else-if="def.type === 'json'"
        class="mono json"
        rows="3"
        :value="asJson"
        @change="stageJson(($event.target as HTMLTextAreaElement).value)"
      />

      <input
        v-else
        type="text"
        class="mono"
        :value="asString"
        :placeholder="def.type === 'duration' ? '30s, 5m, 1h' : ''"
        @change="emit('stage', def.id, ($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.control {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: 12px;
  align-items: start;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}

.control.staged {
  background: rgba(77, 163, 255, 0.08);
  box-shadow: inset 2px 0 0 var(--accent);
}

.control.readonly {
  opacity: 0.75;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}

.id {
  font-family: var(--mono);
  color: var(--text);
}

.desc {
  font-size: 12px;
}

.bounds,
.applies {
  font-size: 11px;
}

.widget {
  display: flex;
  justify-content: flex-end;
}

.widget input[type='number'],
.widget input[type='text'],
.widget select,
.widget textarea {
  width: 100%;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
}

.json {
  resize: vertical;
}
</style>
