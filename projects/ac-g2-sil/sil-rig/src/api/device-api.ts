import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { RigContext, FirmwareSession } from '../core/context.js';
import { fail, ok, send } from './envelope.js';
import { issueToken, requireAuth, tagRoute } from './middleware.js';
import { buildTelemetry, MQTT_TARGETS, SERVICES_BY_TARGET, type MqttTarget } from '../ipc/apps.js';
import { IpcServiceNotFound } from '../ipc/broker.js';

/**
 * The local device API.
 *
 * These are the eleven endpoints the iOS and Android installers actually call,
 * taken from EmbApi.kt. Serving this exact surface is the whole point of the
 * rig: an app pointed at the simulator needs no code changes, and iOS -- which
 * has no simulator of its own today -- gets one for free.
 */
export function buildDeviceApi(ctx: RigContext): Router {
  const router = Router();

  // ---------------------------------------------------------- GET /version/api
  router.get('/version/api', tagRoute('version'), (_req, res) => {
    send(ctx, res, 200, ok(ctx, {
      apiVersion: '1.0.0',
      simulator: true,
      rig: 'sil-rig',
      registerMapVersion: ctx.mcu.model.version ?? 'builtin',
      protocolVersion: ctx.mcu.model.protocolVersion ?? {},
    }), 'version');
  });

  // --------------------------------------------------------- POST /auth/token
  router.post('/auth/token', tagRoute('auth_token'), (req, res) => {
    if (ctx.controls.bool('api.auth.reject')) {
      send(ctx, res, 401, fail(ctx, 4001, 'unauthorized (api.auth.reject)'), 'auth_token');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subject = String(body.username ?? body.installerId ?? 'installer');
    const { token, expiresIn } = issueToken(ctx, subject);
    send(ctx, res, 200, ok(ctx, { accessToken: token, token, tokenType: 'Bearer', expiresIn }), 'auth_token');
  });

  // ---------------------------------------- POST /publish/{target}/{service}
  // The IPC RPC front door. Maps onto MQTT <target>/req/<service>.
  router.post(
    '/publish/:target/:service',
    tagRoute('publish'),
    requireAuth(ctx),
    async (req: Request, res: Response) => {
      const target = req.params.target as MqttTarget;
      const service = String(req.params.service);

      if (!MQTT_TARGETS.includes(target)) {
        send(ctx, res, 404, fail(ctx, 4040, `unknown IPC target: ${target}`), 'publish');
        return;
      }

      try {
        const result = await ctx.ipc.request(target, service, {
          headers: { authorization: req.headers.authorization },
          tid: String((req.body as Record<string, unknown>)?.tid ?? randomUUID()),
          service,
          timestamp: ctx.clock.nowIso(),
          context: (req.body as Record<string, unknown>)?.context ?? req.body,
        });
        send(ctx, res, 200, ok(ctx, { service, target, context: result }), 'publish');
      } catch (err) {
        if (err instanceof IpcServiceNotFound) {
          send(ctx, res, 404, fail(ctx, 4040, err.message), 'publish');
          return;
        }
        ctx.log('error', `IPC request failed: ${target}/${service}`, err);
        send(ctx, res, 500, fail(ctx, 5000, String(err)), 'publish');
      }
    },
  );

  // -------------------------------------------- GET /notifications/{name}
  router.get('/notifications/:name', tagRoute('notifications'), requireAuth(ctx), (req, res) => {
    const name = String(req.params.name);
    const cached = ctx.ipc.cache.getNotification(name);
    if (cached === undefined) {
      // A notification that has not fired yet is a 404, not an empty success --
      // clients distinguish "no data yet" from "value is empty".
      send(ctx, res, 404, fail(ctx, 4040, `no cached notification: ${name}`), 'notifications');
      return;
    }
    send(ctx, res, 200, ok(ctx, { name, message: cached, context: cached }), 'notifications');
  });

  // -------------------------------------------------------- GET /telemetry
  router.get('/telemetry', tagRoute('telemetry'), requireAuth(ctx), (_req, res) => {
    send(ctx, res, 200, ok(ctx, buildTelemetry(ctx)), 'telemetry');
  });

  // ---------------------------------------------- POST /product/serial-number
  router.post('/product/serial-number', tagRoute('serial_number'), requireAuth(ctx), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const serial = String(body.serialNumber ?? body.productSerialNumber ?? '');
    if (!serial) {
      send(ctx, res, 400, fail(ctx, 4011, 'serialNumber is required'), 'serial_number');
      return;
    }
    if (ctx.controls.bool('db.serial_mismatch')) {
      // The device reports a different serial than the one that was scanned.
      // Clients that trust the request echo rather than the response will bind
      // the wrong device.
      const stored = ctx.controls.str('site.serial_number');
      send(
        ctx,
        res,
        409,
        fail(ctx, 4090, `serial number mismatch: device reports ${stored}`),
        'serial_number',
      );
      return;
    }
    ctx.controls.set('site.serial_number', serial);
    ctx.db.device_info.product_serial_number = serial;
    send(ctx, res, 200, ok(ctx, { serialNumber: serial }), 'serial_number');
  });

  // --------------------------------------------------- POST /api/update/register
  router.post('/api/update/register', tagRoute('update_register'), requireAuth(ctx), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uploadId = randomUUID();
    const session: FirmwareSession = {
      uploadId,
      target: String(body.target ?? ctx.controls.str('fw.target')),
      fileName: String(body.fileName ?? 'firmware.bin'),
      totalBytes: Number(body.fileSize ?? body.totalBytes ?? 1_048_576),
      receivedBytes: 0,
      chunks: 0,
      status: 'registered',
      progressPct: 0,
      startedAt: ctx.clock.nowIso(),
    };
    ctx.fwSessions.set(uploadId, session);
    ctx.ipc.notify('sys_manager', 'swupdate_progress', { uploadId, progress: 0, status: 'registered' });
    send(ctx, res, 200, ok(ctx, { ...session }), 'update_register');
  });

  // ------------------------ POST /api/update/{uploadId}/chunk/{chunkIndex}
  router.post(
    '/api/update/:uploadId/chunk/:chunkIndex',
    tagRoute('update_chunk'),
    requireAuth(ctx),
    (req, res) => {
      const uploadId = String(req.params.uploadId);
      const chunkIndex = Number(req.params.chunkIndex);
      const session = ctx.fwSessions.get(uploadId);

      if (!session) {
        send(ctx, res, 404, fail(ctx, 4040, `unknown uploadId: ${uploadId}`), 'update_chunk');
        return;
      }
      if (chunkIndex === ctx.controls.num('fw.chunk_reject_index')) {
        session.status = 'failed';
        session.error = 'chunk_rejected';
        send(ctx, res, 400, fail(ctx, 4012, `chunk ${chunkIndex} rejected`), 'update_chunk');
        return;
      }
      // Chunk indices must be monotonic. The real updater is fire-and-forget and
      // does not wait for ACKs, which makes ordering bugs easy to introduce and
      // worth catching here.
      if (chunkIndex !== session.chunks) {
        send(
          ctx,
          res,
          400,
          fail(ctx, 4012, `out-of-order chunk: expected ${session.chunks}, got ${chunkIndex}`),
          'update_chunk',
        );
        return;
      }

      const size = Buffer.isBuffer(req.body) ? req.body.length : Number(req.headers['content-length'] ?? 0);
      session.chunks += 1;
      session.receivedBytes = Math.min(session.totalBytes, session.receivedBytes + size);
      session.status = 'transferring';

      const rawPct = session.totalBytes > 0
        ? Math.floor((session.receivedBytes / session.totalBytes) * 100)
        : 100;

      const stallAt = ctx.controls.num('fw.progress_stall_at_pct');
      session.progressPct = stallAt > 0 ? Math.min(rawPct, stallAt) : rawPct;

      const failAt = ctx.controls.num('fw.fail_at_pct');
      if (failAt > 0 && rawPct >= failAt) {
        const mode = ctx.controls.str('fw.fail_mode');
        session.status = 'failed';
        session.error = mode === 'none' ? 'transfer_failed' : mode;
        ctx.ipc.notify('sys_manager', 'swupdate_progress', {
          uploadId,
          progress: session.progressPct,
          status: 'failed',
          error: session.error,
        });
        send(ctx, res, 500, fail(ctx, 5000, `firmware update failed: ${session.error}`), 'update_chunk');
        return;
      }

      ctx.ipc.notify('sys_manager', 'swupdate_progress', {
        uploadId,
        progress: session.progressPct,
        status: session.status,
        chunkIndex,
      });
      send(ctx, res, 200, ok(ctx, { uploadId, chunkIndex, progress: session.progressPct }), 'update_chunk');
    },
  );

  // -------------------------------------------------- GET /api/update/sessions
  router.get('/api/update/sessions', tagRoute('update_sessions'), requireAuth(ctx), (_req, res) => {
    send(ctx, res, 200, ok(ctx, { sessions: [...ctx.fwSessions.values()] }), 'update_sessions');
  });

  // ------------------------------------------------- POST /api/update/finalize
  router.post('/api/update/finalize', tagRoute('update_finalize'), requireAuth(ctx), (_req, res) => {
    const sessions = [...ctx.fwSessions.values()];
    const active = sessions.find((s) => s.status === 'transferring' || s.status === 'registered');

    if (!active) {
      send(ctx, res, 400, fail(ctx, 4012, 'no active update session to finalize'), 'update_finalize');
      return;
    }

    const mode = ctx.controls.str('fw.fail_mode');
    // Erase and CRC are separate MCU-side gates; either can reject an image that
    // transferred perfectly, which is why they are distinct controls.
    if (!ctx.controls.bool('mcu.fw.erase_ok')) {
      active.status = 'failed';
      active.error = 'erase_failed';
    } else if (!ctx.controls.bool('mcu.fw.crc_pass') || mode === 'crc') {
      active.status = 'failed';
      active.error = 'crc_mismatch';
    } else if (mode === 'verify_fail' || mode === 'rollback' || mode === 'incompatible') {
      active.status = 'failed';
      active.error = mode;
    } else {
      active.status = 'completed';
      active.progressPct = 100;
      ctx.controls.set('mcu.fw_version', bumpVersion(ctx.controls.str('mcu.fw_version')));
    }

    ctx.ipc.notify('sys_manager', 'swupdate_progress', {
      uploadId: active.uploadId,
      progress: active.progressPct,
      status: active.status,
      error: active.error,
    });

    if (active.status === 'failed') {
      send(ctx, res, 500, fail(ctx, 5000, `finalize failed: ${active.error}`), 'update_finalize');
      return;
    }
    send(ctx, res, 200, ok(ctx, { uploadId: active.uploadId, status: active.status }), 'update_finalize');
  });

  // -------------------------------------------- POST /api/factory/installer-reset
  router.post('/api/factory/installer-reset', tagRoute('factory_reset'), requireAuth(ctx), (_req, res) => {
    ctx.fwSessions.clear();
    ctx.mi.length = 0;
    ctx.db.device_info = {};
    ctx.db.system_setting = {};
    ctx.faults.clearAll();
    ctx.ipc.cache.clear();
    ctx.controls.set('site.commissioning_status', 'NOT_STARTED');
    ctx.mcu.reboot();
    send(ctx, res, 200, ok(ctx, { reset: true }), 'factory_reset');
  });

  // Discovery aid. Not on the real board, but harmless and saves reading source.
  router.get('/_sil/services', (_req, res) => {
    send(ctx, res, 200, ok(ctx, { targets: MQTT_TARGETS, services: SERVICES_BY_TARGET }));
  });

  return router;
}

function bumpVersion(version: string): string {
  const parts = version.split('.').map((n) => Number(n) || 0);
  parts[parts.length - 1] = (parts[parts.length - 1] ?? 0) + 1;
  return parts.join('.');
}
