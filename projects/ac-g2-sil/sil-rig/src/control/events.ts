import { Router } from 'express';
import type { Response } from 'express';
import type { RigContext } from '../core/context.js';
import type { ControlChange } from '../core/controls.js';
import type { ScenarioEngine } from '../scenario/engine.js';

/**
 * How often buffered changes are flushed to clients, in real milliseconds.
 *
 * The clock ticks at `sim.tick_ms` and can be accelerated arbitrarily, so tick
 * events are not a rate a browser can absorb: a scenario running at 1000x
 * produces thousands of state updates per second. Clients see a coalesced view
 * at this cadence instead, which is fast enough to look live and slow enough to
 * render. It is deliberately *not* derived from the clock -- flushing on
 * virtual time would stall the feed entirely whenever the clock is paused, and
 * a paused rig still changes when someone writes a control.
 */
const FLUSH_MS = 250;

/** Comment frames that keep intermediaries from reaping an idle connection. */
const KEEPALIVE_MS = 15_000;

interface Client {
  res: Response;
  id: number;
}

/**
 * Live event stream for the control plane.
 *
 * One-way server push, so this is Server-Sent Events rather than a WebSocket:
 * it reconnects on its own, survives proxies that mangle upgrades, and can be
 * read with `curl -N`, which matters because the parity rule requires every
 * console capability to be reachable from a terminal.
 *
 * Listeners are attached to the engine once, not once per client, so a hundred
 * open tabs cost one subscription and cannot trip the emitter's leak warning.
 */
export function buildEventStream(ctx: RigContext, scenarios: ScenarioEngine): Router {
  const router = Router();
  const clients = new Set<Client>();

  let nextClientId = 1;
  let eventId = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;

  // Pending change ids, latest value wins: a control written ten times between
  // flushes is one line on the wire, not ten.
  const pendingControls = new Map<string, ControlChange>();
  let tickDirty = false;
  let lastScenarioSignature = scenarioSignature(scenarios);

  function send(client: Client, event: string, data: unknown): void {
    eventId += 1;
    client.res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(event: string, data: unknown): void {
    for (const client of clients) {
      try {
        send(client, event, data);
      } catch (err) {
        ctx.log('debug', 'event client write failed; dropping', err);
        drop(client);
      }
    }
  }

  function flush(): void {
    if (clients.size === 0) return;

    if (pendingControls.size > 0) {
      broadcast('control', { changes: [...pendingControls.values()] });
      pendingControls.clear();
    }

    // The scenario engine is not an emitter, so its progress is polled here
    // rather than instrumented. Comparing whole state would fire every flush,
    // because `offsetMs` advances with the clock; the signature is the set of
    // fields whose change actually means something happened.
    const signature = scenarioSignature(scenarios);
    if (signature !== lastScenarioSignature) {
      lastScenarioSignature = signature;
      broadcast('scenario', scenarios.state());
    }

    if (tickDirty) {
      tickDirty = false;
      broadcast('tick', liveState(ctx));
    }
  }

  function onControlChange(change: ControlChange): void {
    if (clients.size === 0) return;
    pendingControls.set(change.id, change);
  }

  function onControlPatch(changes: ControlChange[]): void {
    for (const change of changes) onControlChange(change);
  }

  function onControlAction({ id }: { id: string }): void {
    if (clients.size === 0) return;
    broadcast('action', { id, at: ctx.clock.nowIso() });
  }

  function onControlReset(): void {
    if (clients.size === 0) return;
    pendingControls.clear();
    broadcast('reset', { controls: ctx.controls.snapshot(), state: liveState(ctx) });
  }

  function onFault(fault: unknown): void {
    if (clients.size === 0) return;
    // Faults are rare and individually meaningful, so they are not coalesced:
    // a fault that appears and clears between two flushes is exactly the event
    // a client most needs to see, and collapsing it would erase it.
    broadcast('fault', { fault, active: ctx.faults.list() });
  }

  function onTick(): void {
    tickDirty = true;
  }

  function onClockJump(): void {
    tickDirty = true;
  }

  function attach(): void {
    ctx.controls.on('change', onControlChange);
    ctx.controls.on('patch', onControlPatch);
    ctx.controls.on('action', onControlAction);
    ctx.controls.on('reset', onControlReset);
    ctx.faults.on('fault', onFault);
    ctx.clock.on('tick', onTick);
    ctx.clock.on('jump', onClockJump);

    flushTimer = setInterval(flush, FLUSH_MS);
    keepaliveTimer = setInterval(() => {
      for (const client of clients) client.res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    // The rig must still exit when the clock stops; these timers are bookkeeping.
    flushTimer.unref?.();
    keepaliveTimer.unref?.();
  }

  function detach(): void {
    ctx.controls.off('change', onControlChange);
    ctx.controls.off('patch', onControlPatch);
    ctx.controls.off('action', onControlAction);
    ctx.controls.off('reset', onControlReset);
    ctx.faults.off('fault', onFault);
    ctx.clock.off('tick', onTick);
    ctx.clock.off('jump', onClockJump);

    if (flushTimer) clearInterval(flushTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    flushTimer = null;
    keepaliveTimer = null;
    pendingControls.clear();
    tickDirty = false;
  }

  function drop(client: Client): void {
    if (!clients.delete(client)) return;
    client.res.end();
    if (clients.size === 0) detach();
  }

  router.get('/events', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this an nginx in front of the rig buffers the stream and the
      // console looks frozen while the rig is in fact fine.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const client: Client = { res, id: nextClientId++ };
    if (clients.size === 0) attach();
    clients.add(client);

    // Retry hint plus a full snapshot, so a reconnecting client is correct
    // immediately rather than after the next thing happens to change.
    res.write('retry: 2000\n\n');
    send(client, 'hello', {
      protocol: 1,
      clientId: client.id,
      seed: ctx.controls.num('sim.seed'),
      flushMs: FLUSH_MS,
      state: liveState(ctx),
      scenario: scenarios.state(),
      diff: ctx.controls.diff(),
    });

    req.on('close', () => drop(client));
    req.on('error', () => drop(client));
  });

  /** Observability for the stream itself; cheap to expose, awkward to guess at. */
  router.get('/events/stats', (_req, res) => {
    res.json({ clients: clients.size, eventsSent: eventId, flushMs: FLUSH_MS });
  });

  return router;
}

/**
 * Fields whose change means the scenario actually progressed.
 *
 * Deliberately excludes `offsetMs`, which advances on every tick and would
 * make the signature useless as a change detector.
 */
function scenarioSignature(scenarios: ScenarioEngine): string {
  const s = scenarios.state();
  return JSON.stringify([
    s.current,
    s.stopped,
    s.completedSteps,
    s.pendingSteps,
    s.pendingExpectations,
    (s.results as unknown[] | undefined)?.length ?? 0,
    s.passed,
  ]);
}

/**
 * The compact live view: everything that changes on a tick and nothing that
 * doesn't. `GET /state` remains the full read; this is what streams.
 */
export function liveState(ctx: RigContext): Record<string, unknown> {
  return {
    clock: {
      now: ctx.clock.nowIso(),
      mode: ctx.clock.getMode(),
      rate: ctx.clock.getRate(),
      tickMs: ctx.clock.getTickMs(),
      tick: ctx.clock.tickCount(),
      elapsedMs: ctx.clock.elapsedMs(),
      skewSeconds: ctx.clock.skewSeconds(),
    },
    plant: ctx.plant.snapshot(),
    faults: ctx.faults.list(),
    mcu: {
      online: ctx.controls.bool('mcu.online'),
      fwVersion: ctx.controls.str('mcu.fw_version'),
      uptimeMs: ctx.mcu.uptimeMs(),
    },
    site: {
      serialNumber: ctx.controls.str('site.serial_number'),
      emsType: ctx.controls.str('site.ems_type'),
      commissioningStatus: ctx.controls.str('site.commissioning_status'),
    },
  };
}
