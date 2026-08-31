import express from 'express';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import selfsigned from 'selfsigned';

import { Clock } from './core/clock.js';
import { ControlRegistry } from './core/controls.js';
import { CONTROL_DEFS } from './core/control-defs.js';
import { Rng } from './core/rng.js';
import type { RigContext } from './core/context.js';
import { Plant } from './plant/plant.js';
import { FaultManager } from './faults/manager.js';
import { IpcBroker } from './ipc/broker.js';
import { registerApps } from './ipc/apps.js';
import { VirtualMcu } from './mcu/virtual-mcu.js';
import { VirtualCan } from './can/virtual-can.js';
import { registerCanControls } from './can/wiring.js';
import { buildDeviceApi } from './api/device-api.js';
import { faultInjection } from './api/middleware.js';
import { attachWsBridge } from './ws/bridge.js';
import { buildControlApi } from './control/api.js';
import { buildEventStream } from './control/events.js';
import { ScenarioEngine } from './scenario/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface RigOptions {
  /** Local device API port. 9112 matches the board's UniEP proxy. */
  port?: number;
  /** Control plane port. Kept separate so it can be firewalled independently. */
  controlPort?: number;
  seed?: number;
  scenario?: string;
  scenarioDir?: string;
  registerMap?: string;
  /** Serve TLS. The real board is HTTPS with a self-signed cert. */
  tls?: boolean;
  host?: string;
  quiet?: boolean;
  autoplay?: boolean;
  /**
   * Built web console assets. Defaults to `dist/web`; the console is optional,
   * and when the directory is absent the control API serves as it always has.
   */
  webDir?: string;
}

export interface Rig {
  ctx: RigContext;
  scenarios: ScenarioEngine;
  deviceServer: Server;
  controlServer: Server;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createRig(options: RigOptions = {}): Rig {
  const {
    port = 9112,
    controlPort = 9114,
    seed = 1,
    scenarioDir = resolve(HERE, '..', 'scenarios'),
    registerMap,
    tls = true,
    host = '0.0.0.0',
    quiet = false,
  } = options;

  const log: RigContext['log'] = (level, msg, extra) => {
    if (quiet && level === 'debug') return;
    const line = `[sil ${level}] ${msg}`;
    if (level === 'error') console.error(line, extra ?? '');
    else if (level === 'warn') console.warn(line, extra ?? '');
    else console.log(line, extra !== undefined ? extra : '');
  };

  // ---- core ---------------------------------------------------------------
  const controls = new ControlRegistry();
  controls.defineAll(CONTROL_DEFS);
  controls.set('sim.seed', seed);

  const clock = new Clock();
  const rng = new Rng(seed);
  const plant = new Plant(controls, clock, rng.derive('plant'));
  const faults = new FaultManager(controls, clock, rng);
  const ipc = new IpcBroker();
  const mcu = new VirtualMcu(controls, clock, plant, rng, registerMap);
  const can = new VirtualCan(controls, clock, plant, rng, registerMap);

  const ctx: RigContext = {
    controls,
    clock,
    rng,
    plant,
    faults,
    ipc,
    mcu,
    can,
    db: { device_info: {}, system_setting: {} },
    fwSessions: new Map(),
    mi: [],
    log,
  };

  registerApps(ctx);
  registerCanControls(ctx);
  const scenarios = new ScenarioEngine(ctx, scenarioDir);

  // ---- control-driven engine settings -------------------------------------
  // Clock parameters live in the registry like everything else, so a scenario
  // changing the rate goes through exactly the same path as a CLI write.
  controls.on('change:sim.clock.rate', (rate) => clock.setRate(Number(rate)));
  controls.on('change:sim.tick_ms', (ms) => clock.setTickMs(Number(ms)));
  controls.on('change:sim.clock_skew_s', (s) => clock.setSkewSeconds(Number(s)));
  controls.on('change:sim.clock.mode', (mode) => clock.setMode(mode === 'wall' ? 'wall' : 'virtual'));
  controls.on('change:sim.clock.now', (iso) => {
    if (typeof iso === 'string' && iso.length > 0) clock.setNow(iso);
  });
  // Action controls are verbs. `mcu.reboot` was declared but unreachable until
  // the registry grew an invoke path; wire it to the thing it names.
  controls.on('action:mcu.reboot', () => {
    mcu.reboot();
    log('info', 'virtual MCU rebooted');
  });
  controls.on('action:can.reboot', () => {
    can.reboot();
    log('info', 'virtual CAN bus reset');
  });

  controls.on('change:sim.seed', (value) => {
    // Reseeding mid-run is legal but must be explicit: it restarts every stream.
    log('warn', `sim.seed changed to ${value}; RNG streams reset`);
  });

  // ---- simulation loop ----------------------------------------------------
  // `controls.reset()` only restores control *values*. Subsystems that carry
  // their own state machines (grid ride-through phase, latched CAN flag bits,
  // active faults) must be cleared too, or state leaks across scenario loads
  // and two identical runs can disagree depending on what ran before them.
  controls.on('reset:errors', (failures: Array<{ id: string; error: unknown }>) => {
    for (const { id, error } of failures) {
      log('error', `reset listener failed for ${id}`, error);
    }
  });

  controls.on('reset', () => {
    plant.gridSupport.reset();
    can.clearFlags();
    faults.clearAll();
  });

  // Each subsystem is isolated. A throw in the plant must not stop the scenario
  // engine from advancing: that failure mode is silent, looks like "the
  // scenario did nothing", and is very expensive to diagnose.
  const subsystems: Array<[string, (deltaMs: number) => void]> = [
    ['plant', (d) => plant.tick(d)],
    ['faults', (d) => faults.tick(d)],
    ['scenarios', () => scenarios.tick()],
    ['telemetry', () => publishCyclic(ctx)],
  ];
  const failed = new Set<string>();

  clock.on('tick', ({ deltaMs }: { deltaMs: number }) => {
    for (const [name, fn] of subsystems) {
      try {
        fn(deltaMs);
      } catch (err) {
        if (controls.bool('sim.strict')) throw err;
        // Log the first failure per subsystem at error, then stay quiet: a
        // per-tick error is otherwise thousands of identical lines.
        if (!failed.has(name)) {
          failed.add(name);
          log('error', `tick failed in ${name} (further occurrences suppressed)`, err);
        }
      }
    }
  });

  // ---- device API ---------------------------------------------------------
  const deviceApp = express();
  deviceApp.disable('x-powered-by');
  deviceApp.use(express.json({ limit: '64mb' }));
  // Firmware chunks arrive as raw octet-stream, so a permissive raw parser must
  // sit alongside the JSON one rather than replacing it.
  deviceApp.use(express.raw({ type: 'application/octet-stream', limit: '64mb' }));
  deviceApp.use(cors());
  deviceApp.use(faultInjection(ctx));
  deviceApp.use(buildDeviceApi(ctx));
  deviceApp.use((_req, res) => res.status(404).json({ code: 4040, message: 'not found' }));

  const deviceServer = tls
    ? createHttpsServer(generateCert(), deviceApp)
    : createHttpServer(deviceApp);

  attachWsBridge(ctx, deviceServer);

  // ---- control API --------------------------------------------------------
  const controlApp = express();
  controlApp.disable('x-powered-by');
  controlApp.use(express.json({ limit: '16mb' }));
  controlApp.use(cors());
  controlApp.use(buildControlApi(ctx, scenarios));
  controlApp.use(buildEventStream(ctx, scenarios));
  // The console is mounted last so it can never shadow a control route: the API
  // is the product, the console is a client of it.
  const webRoot = resolveWebRoot(options.webDir);
  if (webRoot) {
    controlApp.use(express.static(webRoot, { index: 'index.html', maxAge: 0 }));
    controlApp.use(spaFallback(webRoot));
  } else {
    controlApp.get('/', (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('web console not built\n\n  npm run web:build   # then reload\n');
    });
  }
  controlApp.use((_req, res) => res.status(404).json({ error: 'not found' }));
  const controlServer = createHttpServer(controlApp);

  return {
    ctx,
    scenarios,
    deviceServer,
    controlServer,

    async start(): Promise<void> {
      if (options.scenario) scenarios.load(options.scenario);

      await Promise.all([
        listen(deviceServer, port, host),
        listen(controlServer, controlPort, host),
      ]);

      clock.setRate(controls.num('sim.clock.rate'));
      clock.setTickMs(controls.num('sim.tick_ms'));
      const autoplay = options.autoplay ?? controls.bool('sim.autoplay');
      if (autoplay) clock.start();

      const scheme = tls ? 'https' : 'http';
      log('info', `device API   ${scheme}://${host}:${port}   (point installer apps here)`);
      log('info', `websocket    ${tls ? 'wss' : 'ws'}://${host}:${port}/ws`);
      log('info', `control API  http://${host}:${controlPort}/control`);
      log('info', `event stream http://${host}:${controlPort}/events`);
      log(
        'info',
        webRoot
          ? `web console  http://${host}:${controlPort}/`
          : 'web console  not built (npm run web:build)',
      );
      log('info', `register map ${mcu.model.stats.registerCount} registers / ${mcu.model.stats.metricCount} metrics, ${mcu.model.stats.cyclicCount} cyclic`);
      log('info', `seed ${seed}${options.scenario ? `, scenario ${options.scenario}` : ''}${autoplay ? '' : ' (clock paused)'}`);
    },

    async stop(): Promise<void> {
      clock.stop();
      await Promise.all([close(deviceServer), close(controlServer)]);
    },
  };
}

/**
 * Publish the 1 Hz cyclic register group onto the IPC bus.
 *
 * This is the real-time data path: the `read` group in the factory register map
 * carries periodMs 1000, and clients subscribe to it rather than polling.
 */
function publishCyclic(ctx: RigContext): void {
  if (!ctx.controls.bool('mcu.online')) return;
  try {
    ctx.ipc.notify('realtime_monitor', 'realtime_data', {
      timestamp: ctx.clock.nowIso(),
      plant: ctx.plant.snapshot(),
      faults: ctx.faults.list(),
    });
  } catch (err) {
    ctx.log('debug', 'cyclic publish skipped', err);
  }
}

/**
 * Locate the built web console.
 *
 * Two layouts must both work: running from source with `tsx` (this file is in
 * `src/`, the build is in `../dist/web`) and running the compiled rig (this
 * file is in `dist/`, the build is in `./web`). Guessing wrong is a silent
 * failure -- the console 404s and the rig looks broken -- so both are probed
 * and the presence of `index.html`, not of the directory, is the test.
 */
function resolveWebRoot(explicit?: string): string | null {
  const candidates = explicit
    ? [resolve(explicit)]
    : [resolve(HERE, '..', 'dist', 'web'), resolve(HERE, 'web')];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Serve `index.html` for client-side routes.
 *
 * Restricted to HTML GETs so that a mistyped API path still returns the JSON
 * 404 the CLI and tests expect, rather than a page of markup.
 */
function spaFallback(webRoot: string) {
  const index = join(webRoot, 'index.html');
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!req.accepts('html')) return next();
    if (req.path.includes('.')) return next();
    res.sendFile(index);
  };
}

/** Permissive CORS: the rig is a local development tool, not a production edge. */
function cors() {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/**
 * Generate a self-signed certificate at startup.
 *
 * The board serves HTTPS with a self-signed cert and both installer apps ship a
 * trust-all client for it. Serving plain HTTP here would force an app-side code
 * change and destroy the "runs unmodified" property that justifies this seam.
 */
function generateCert(): { key: string; cert: string } {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'sil-rig.local' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 2, value: 'sil-rig.local' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '192.168.100.1' },
        ],
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => res());
  });
}

function close(server: Server): Promise<void> {
  return new Promise((res) => {
    if (!server.listening) return res();
    server.close(() => res());
  });
}

export { join };
