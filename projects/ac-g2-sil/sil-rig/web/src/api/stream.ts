import { onScopeDispose, ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import type { LiveState, RigEventName, RigEvents, ScenarioState } from './types.js';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

type Handlers = { [K in RigEventName]?: Array<(payload: RigEvents[K]) => void> };

export interface RigStream {
  status: Ref<ConnectionStatus>;
  state: ShallowRef<LiveState | null>;
  scenario: ShallowRef<ScenarioState | null>;
  seed: Ref<number | null>;
  /** Server-side coalescing cadence, reported by `hello`. */
  flushMs: Ref<number>;
  lastEventAt: Ref<number | null>;
  on<K extends RigEventName>(event: K, handler: (payload: RigEvents[K]) => void): () => void;
  close(): void;
}

/**
 * Subscribe to the rig's event stream.
 *
 * The stream is the console's source of truth for anything that changes on a
 * tick. Nothing derived from it is cached across a reconnect: `EventSource`
 * reconnects on its own, every reconnect delivers a fresh `hello` carrying a
 * full snapshot, and the view is rebuilt from that. A client-side cache that
 * survived a reconnect would be a second copy of the rig's state, and a second
 * copy is a copy that can be wrong.
 */
export function useRigStream(path = '/events'): RigStream {
  const status = ref<ConnectionStatus>('connecting');
  const state = shallowRef<LiveState | null>(null);
  const scenario = shallowRef<ScenarioState | null>(null);
  const seed = ref<number | null>(null);
  const flushMs = ref(250);
  const lastEventAt = ref<number | null>(null);

  const handlers: Handlers = {};
  const source = new EventSource(path);

  function emit<K extends RigEventName>(event: K, payload: RigEvents[K]): void {
    lastEventAt.value = Date.now();
    for (const handler of handlers[event] ?? []) handler(payload);
  }

  function listen<K extends RigEventName>(event: K, apply: (payload: RigEvents[K]) => void): void {
    source.addEventListener(event, (raw) => {
      let payload: RigEvents[K];
      try {
        payload = JSON.parse((raw as MessageEvent<string>).data) as RigEvents[K];
      } catch (err) {
        // A malformed frame must not take the stream down with it; the next
        // flush is 250 ms away and will be well-formed.
        console.error(`[sil] bad ${event} frame`, err);
        return;
      }
      apply(payload);
      emit(event, payload);
    });
  }

  listen('hello', (hello) => {
    status.value = 'live';
    seed.value = hello.seed;
    flushMs.value = hello.flushMs;
    state.value = hello.state;
    scenario.value = hello.scenario;
  });
  listen('tick', (live) => {
    state.value = live;
  });
  listen('reset', (payload) => {
    state.value = payload.state;
  });
  listen('scenario', (payload) => {
    scenario.value = payload;
  });
  listen('fault', (payload) => {
    // Faults arrive out of band from ticks, so the active list is folded into
    // the current state rather than waiting for the next tick to reveal it.
    if (state.value) state.value = { ...state.value, faults: payload.active };
  });
  listen('control', () => undefined);
  listen('action', () => undefined);

  source.addEventListener('open', () => {
    status.value = 'live';
  });
  source.addEventListener('error', () => {
    // EventSource retries by itself using the server's `retry:` hint; this is
    // a status change, not a failure to handle.
    status.value = source.readyState === EventSource.CLOSED ? 'offline' : 'connecting';
  });

  function close(): void {
    source.close();
    status.value = 'offline';
  }

  onScopeDispose(close);

  return {
    status,
    state,
    scenario,
    seed,
    flushMs,
    lastEventAt,
    on(event, handler) {
      const list = (handlers[event] ??= []);
      list.push(handler as never);
      return () => {
        const at = list.indexOf(handler as never);
        if (at >= 0) list.splice(at, 1);
      };
    },
    close,
  };
}
