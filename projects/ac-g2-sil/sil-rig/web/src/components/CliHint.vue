<script setup lang="ts">
/**
 * The CLI equivalent of whatever was just done.
 *
 * Present on every mutating surface, because the parity rule is only real if
 * the terminal form of an action is visible at the moment of taking it. It
 * also teaches the CLI by using the console, which is the direction people
 * actually travel.
 */
import { ref } from 'vue';

const props = defineProps<{ command: string; label?: string }>();
const copied = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.command);
  } catch {
    // Clipboard access is denied over plain HTTP on some browsers, and the rig
    // serves the console over plain HTTP by design. The command is on screen
    // regardless, so this is not worth an error state.
  }
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}
</script>

<template>
  <button class="cli" :title="`copy: ${command}`" @click="copy">
    <span class="mono">{{ copied ? 'copied' : command }}</span>
  </button>
</template>

<style scoped>
.cli {
  background: transparent;
  border: 1px dashed var(--line);
  color: var(--muted);
  font-size: 11px;
  padding: 2px 8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cli:hover {
  color: var(--text);
  border-color: var(--accent);
}
</style>
