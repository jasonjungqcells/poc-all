import { Router } from 'express';
import type { RigContext } from '../core/context.js';
import { ControlError } from '../core/controls.js';
import { parseDuration } from '../core/clock.js';
import { ALL_FAULTS, CLOUD_ERROR_CODES } from '../faults/codebook.js';
import {
  CMD,
  FW_ADDR,
  buildStatusPayload,
  decodeFrame,
  encodeFrame,
  FOURK_FRAME_LEN,
  STANDARD_FRAME_LEN,
} from '../mcu/frame.js';
import { SpiError } from '../mcu/virtual-mcu.js';
import { CanError } from '../can/virtual-can.js';
import { CAN_FLAG_DOMAINS, CAN_SEVERITIES, allFlagRefs } from '../can/flags.js';
import type { ScenarioEngine } from '../scenario/engine.js';

/**
 * The control plane.
 *
 * Every lever in the rig is reachable here, and nothing bypasses it. That is the
 * parity rule from the design: a GUI panel, if one is ever built, must be a thin
 * client of these routes, so anything clickable is also scriptable and anything
 * scriptable is reproducible in CI.
 */
export function buildControlApi(ctx: RigContext, scenarios: ScenarioEngine): Router {
  const router = Router();

  // ------------------------------------------------------------- controls
  router.get('/control', (req, res) => {
    const group = req.query.group ? String(req.query.group) : undefined;
    const all = ctx.controls.list();
    res.json({
      groups: ctx.controls.groups(),
      count: all.length,
      controls: group ? all.filter((c) => c.group === group) : all,
    });
  });

  router.get('/control/diff', (_req, res) => {
    res.json({ controls: ctx.controls.diff() });
  });

  router.get('/control/:id', (req, res) => {
    const id = String(req.params.id);
    const def = ctx.controls.definition(id);
    if (!def) {
      res.status(404).json({ error: `unknown control: ${id}` });
      return;
    }
    res.json({ ...def, id, value: ctx.controls.get(id) });
  });

  router.put('/control/:id', (req, res) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const value = 'value' in body ? body.value : body;
    try {
      ctx.controls.set(id, value);
      res.json({ id, value: ctx.controls.get(id) });
    } catch (err) {
      respondControlError(res, err);
    }
  });

  router.patch('/control', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const map = (body.controls ?? body) as Record<string, unknown>;
    try {
      const changes = ctx.controls.patch(map);
      res.json({ changed: changes.length, changes });
    } catch (err) {
      respondControlError(res, err);
    }
  });

  router.post('/control/reset', (_req, res) => {
    ctx.controls.reset();
    res.json({ reset: true });
  });

  // ---------------------------------------------------------------- clock
  router.post('/clock/step', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = body.ms ?? body.duration ?? body.by ?? 1000;
    try {
      const ms = parseDuration(raw as string | number);
      ctx.clock.step(ms);
      res.json({ steppedMs: ms, now: ctx.clock.nowIso(), tick: ctx.clock.tickCount() });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.post('/clock/pause', (_req, res) => {
    ctx.controls.set('sim.clock.rate', 0);
    res.json({ paused: true, now: ctx.clock.nowIso() });
  });

  router.post('/clock/resume', (req, res) => {
    const rate = Number((req.body as Record<string, unknown>)?.rate ?? 1);
    ctx.controls.set('sim.clock.rate', rate);
    res.json({ paused: false, rate, now: ctx.clock.nowIso() });
  });

  router.get('/clock', (_req, res) => {
    res.json({
      now: ctx.clock.nowIso(),
      mode: ctx.clock.getMode(),
      rate: ctx.clock.getRate(),
      tickMs: ctx.clock.getTickMs(),
      tick: ctx.clock.tickCount(),
      elapsedMs: ctx.clock.elapsedMs(),
    });
  });

  // -------------------------------------------------------------- scenarios
  router.get('/scenarios', (_req, res) => {
    res.json({ scenarios: scenarios.list() });
  });

  router.get('/scenarios/:name', (req, res) => {
    const doc = scenarios.get(String(req.params.name));
    if (!doc) {
      res.status(404).json({ error: `unknown scenario: ${req.params.name}` });
      return;
    }
    res.json(doc);
  });

  router.post('/scenarios/:name/load', (req, res) => {
    try {
      const result = scenarios.load(String(req.params.name));
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get('/scenario/state', (_req, res) => {
    res.json(scenarios.state());
  });

  // ----------------------------------------------------------------- faults
  router.get('/fault', (_req, res) => {
    res.json({ active: ctx.faults.list(), catalog: ALL_FAULTS, cloudErrorCodes: CLOUD_ERROR_CODES });
  });

  router.post('/fault/inject', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body.code ?? '');
    if (!code) {
      res.status(400).json({ error: 'code is required' });
      return;
    }
    const fault = ctx.faults.inject(code, {
      device: body.device ? String(body.device) : undefined,
      level: body.level as 'W' | 'A' | 'F' | undefined,
    });
    res.json(fault);
  });

  router.post('/fault/clear', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body.code ?? '');
    if (!code || code === 'all') {
      ctx.faults.clearAll();
      res.json({ cleared: 'all' });
      return;
    }
    const cleared = ctx.faults.clear(code);
    if (!cleared) {
      res.status(404).json({ error: `fault not active: ${code}` });
      return;
    }
    res.json(cleared);
  });

  // -------------------------------------------------------------- snapshots
  router.get('/snapshot', (_req, res) => {
    res.json(buildSnapshot(ctx, scenarios));
  });

  router.post('/snapshot/restore', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const controls = (body.controls ?? {}) as Record<string, unknown>;
    try {
      ctx.controls.restore(controls);
      if (body.clock && typeof body.clock === 'object') {
        const clock = body.clock as Record<string, unknown>;
        if (clock.now) ctx.clock.setNow(String(clock.now));
      }
      res.json({ restored: true, controls: Object.keys(controls).length });
    } catch (err) {
      respondControlError(res, err);
    }
  });

  // -------------------------------------------------------------------- spi
  // Wire-level view of the MPU-MCU link, equivalent to the SPI debugger used on
  // real hardware. Without this the framing layer is untestable, because the
  // REST surface only ever shows decoded values.
  router.get('/spi/status', (_req, res) => {
    const mode4k = ctx.controls.bool('mcu.spi.mode_4k');
    const payload = buildStatusPayload({
      eraseDone: ctx.controls.bool('mcu.fw.erase_ok'),
      crcPass: ctx.controls.bool('mcu.fw.crc_pass'),
    });
    const frame = encodeFrame(CMD.CMD_ACK, FW_ADDR.STATUS, payload, mode4k ? '4k' : 'standard');
    res.json({
      mode: mode4k ? '4k' : 'standard',
      expectedLength: mode4k ? FOURK_FRAME_LEN : STANDARD_FRAME_LEN,
      actualLength: frame.length,
      hex: Buffer.from(frame).toString('hex'),
      decoded: describeFrame(frame),
    });
  });

  router.get('/spi/read/:register', (req, res) => {
    const mode4k = ctx.controls.bool('mcu.spi.mode_4k');
    try {
      const read = ctx.mcu.readRegister(String(req.params.register));
      const json = Buffer.from(JSON.stringify(read.metrics), 'utf8');
      const frame = encodeFrame(CMD.ACK, Number.parseInt(read.address, 16), json, mode4k ? '4k' : 'standard');
      res.json({
        register: read.register,
        address: read.address,
        mode: mode4k ? '4k' : 'standard',
        frameLength: frame.length,
        hex: Buffer.from(frame.subarray(0, 96)).toString('hex'),
        decoded: describeFrame(frame),
        metrics: read.metrics,
      });
    } catch (err) {
      if (err instanceof SpiError) {
        res.status(502).json({ error: err.kind, message: err.message });
        return;
      }
      respondControlError(res, err);
    }
  });

  // -------------------------------------------------------------------- can
  // The g4 CAN bus is inspectable on the same terms as SPI. `/can/faults` is
  // the surface both Gen1 HMI fault tabs mapped onto: named bits and raw bytes.
  router.get('/can/status', (_req, res) => {
    res.json(ctx.can.summary());
  });

  router.get('/can/faults', (_req, res) => {
    res.json({
      active: ctx.can.activeFlags(),
      bytes: ctx.can.flagSnapshot(),
      domains: CAN_FLAG_DOMAINS,
      severities: CAN_SEVERITIES,
      codeFormat: '{G|P|D|M}{PCS:2}{bit:3}{F|W|A}',
      totalAddressableBits: allFlagRefs().length * ctx.can.pcsCount(),
    });
  });

  router.get('/can/read/:register', (req, res) => {
    try {
      res.json(ctx.can.readRegister(String(req.params.register)));
    } catch (err) {
      if (err instanceof CanError) {
        res.status(502).json({ error: err.kind, message: err.message });
        return;
      }
      respondControlError(res, err);
    }
  });

  router.post('/can/write/:register', (req, res) => {
    try {
      res.json(ctx.can.writeRegister(String(req.params.register), req.body ?? {}));
    } catch (err) {
      if (err instanceof CanError) {
        res.status(502).json({ error: err.kind, message: err.message });
        return;
      }
      respondControlError(res, err);
    }
  });

  router.get('/can/registers', (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase();
    const all = [...ctx.can.model.byName.values()];
    const hits = q ? all.filter((d) => d.id.toLowerCase().includes(q)) : all;
    res.json({
      total: all.length,
      matched: hits.length,
      registers: hits.slice(0, 200).map((d) => ({
        id: d.id,
        address: d.registerAddress,
        group: d.groupId,
        metrics: d.metrics.length,
      })),
    });
  });

  // ------------------------------------------------------------------ state
  router.get('/state', (_req, res) => {
    res.json({
      clock: {
        now: ctx.clock.nowIso(),
        rate: ctx.clock.getRate(),
        tick: ctx.clock.tickCount(),
        skewSeconds: ctx.clock.skewSeconds(),
        timezone: ctx.controls.str('sim.timezone'),
        locale: ctx.controls.str('sim.locale'),
      },
      plant: ctx.plant.snapshot(),
      faults: ctx.faults.list(),
      mcu: {
        online: ctx.controls.bool('mcu.online'),
        fwVersion: ctx.controls.str('mcu.fw_version'),
        uptimeMs: ctx.mcu.uptimeMs(),
        registerMap: ctx.mcu.model.stats,
      },
      site: {
        serialNumber: ctx.controls.str('site.serial_number'),
        emsType: ctx.controls.str('site.ems_type'),
        commissioningStatus: ctx.controls.str('site.commissioning_status'),
        miDiscovered: ctx.mi.length,
      },
      firmware: [...ctx.fwSessions.values()],
      // The rig has no BLE radio, so these levers are published for the client's
      // own BLE mock to consume. Keeping them in the same control registry means
      // one scenario file still describes the whole run.
      ble: {
        enabled: ctx.controls.bool('ble.enabled'),
        mtu: ctx.controls.num('ble.mtu'),
        failReason: ctx.controls.str('ble.pair.fail_reason'),
        handshakeDelayMs: ctx.controls.num('ble.handshake_delay_ms'),
        disconnectAfterS: ctx.controls.num('ble.disconnect_after_s'),
        errorCode: ctx.controls.str('ble.error_code'),
        errorSweep: ctx.controls.bool('ble.error_sweep'),
        ackTimeout: ctx.controls.bool('ble.ack_timeout'),
      },
      scenario: scenarios.state(),
    });
  });

  return router;
}

function describeFrame(frame: Uint8Array): Record<string, unknown> {
  const decoded = decodeFrame(frame);
  return {
    sync: `0x${decoded.sync.toString(16).toUpperCase()}`,
    cmd: `0x${decoded.cmd.toString(16).toUpperCase()}`,
    address: `0x${decoded.address.toString(16).toUpperCase()}`,
    payloadLen: decoded.payloadLen,
    crc: `0x${decoded.crc.toString(16).toUpperCase().padStart(4, '0')}`,
    crcValid: decoded.crcValid,
  };
}

export function buildSnapshot(ctx: RigContext, scenarios: ScenarioEngine): Record<string, unknown> {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    seed: ctx.controls.num('sim.seed'),
    clock: { now: ctx.clock.nowIso(), rate: ctx.clock.getRate(), tick: ctx.clock.tickCount() },
    scenario: scenarios.state(),
    controls: ctx.controls.snapshot(),
    diff: ctx.controls.diff(),
    plant: ctx.plant.snapshot(),
    faults: ctx.faults.list(),
  };
}

function respondControlError(res: import('express').Response, err: unknown): void {
  if (err instanceof ControlError) {
    res.status(400).json({ error: err.message, control: err.controlId });
    return;
  }
  res.status(500).json({ error: String(err) });
}
