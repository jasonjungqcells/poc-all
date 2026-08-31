import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RigContext } from '../core/context.js';
import { issueToken, verifyToken } from '../api/middleware.js';
import { IpcServiceNotFound } from '../ipc/broker.js';
import type { MqttTarget } from '../ipc/apps.js';

/**
 * WsMqttBridge-compatible WebSocket endpoint.
 *
 * Mirrors edge_core_nodejs: services are `auth-token`, `subscribe`,
 * `unsubscribe`, `mqtt-request` and `cached-memory`, with the envelope
 * { headers, tid, service, timestamp, context }. `tid` correlates request to
 * response and is honoured even under the duplicate/out-of-order fault controls,
 * because a client that ignores tid should fail those scenarios.
 *
 * The handler name `ws-mqtt-bridge` is reserved on the real board and is not
 * used here for anything else.
 */
export function attachWsBridge(ctx: RigContext, server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const rng = ctx.rng.derive('ws');

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    if (ctx.controls.bool('api.ws.reject_upgrade')) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const subscriptions = new Set<string>();
    let authorized = false;

    const dropAfterS = ctx.controls.num('api.ws.drop_after_s');
    if (dropAfterS > 0) {
      const timer = setTimeout(() => ws.close(1001, 'dropped by api.ws.drop_after_s'), dropAfterS * 1000);
      timer.unref?.();
      ws.once('close', () => clearTimeout(timer));
    }

    const reply = (payload: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const text = JSON.stringify(payload);
      const emit = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      };
      // Reordering is simulated by deferring some replies a tick; duplication
      // resends the identical frame. Both target client-side tid handling.
      if (ctx.controls.bool('api.ws.out_of_order') && rng.chance(50)) {
        setTimeout(emit, rng.int(20, 200));
      } else {
        emit();
      }
      if (ctx.controls.bool('api.ws.duplicate_responses')) setTimeout(emit, 5);
    };

    // Forward bus traffic to subscribers.
    const onMessage = (msg: { topic: string; payload: unknown }): void => {
      if (!subscriptions.has(msg.topic)) return;
      reply({ service: 'notification', topic: msg.topic, timestamp: ctx.clock.nowIso(), context: msg.payload });
    };
    ctx.ipc.on('message', onMessage);
    ws.once('close', () => ctx.ipc.off('message', onMessage));

    ws.on('message', async (raw) => {
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        reply({ service: 'error', error: 'invalid JSON', timestamp: ctx.clock.nowIso() });
        return;
      }

      const service = String(envelope.service ?? '');
      const tid = String(envelope.tid ?? randomUUID());
      const context = (envelope.context ?? {}) as Record<string, unknown>;
      const headers = (envelope.headers ?? {}) as { authorization?: string };
      const base = { tid, service, timestamp: ctx.clock.nowIso() };

      const token = headers.authorization?.startsWith('Bearer ')
        ? headers.authorization.slice(7)
        : undefined;

      switch (service) {
        case 'auth-token': {
          if (ctx.controls.bool('api.auth.reject')) {
            reply({ ...base, code: 401, error: 'unauthorized (api.auth.reject)' });
            return;
          }
          const issued = issueToken(ctx, String(context.username ?? 'installer'));
          authorized = true;
          reply({ ...base, code: 200, context: issued });
          return;
        }

        case 'subscribe': {
          if (!ensureAuth()) return;
          const topics = normaliseTopics(context);
          for (const t of topics) subscriptions.add(t);
          reply({ ...base, code: 200, context: { subscribed: [...subscriptions] } });
          return;
        }

        case 'unsubscribe': {
          if (!ensureAuth()) return;
          for (const t of normaliseTopics(context)) subscriptions.delete(t);
          reply({ ...base, code: 200, context: { subscribed: [...subscriptions] } });
          return;
        }

        case 'mqtt-request': {
          if (!ensureAuth()) return;
          const target = String(context.target ?? context.app ?? '') as MqttTarget;
          const svc = String(context.service ?? '');
          try {
            const result = await ctx.ipc.request(target, svc, {
              headers,
              tid,
              service: svc,
              timestamp: ctx.clock.nowIso(),
              context: context.payload ?? context.context ?? {},
            });
            reply({ ...base, code: 200, context: result });
          } catch (err) {
            const code = err instanceof IpcServiceNotFound ? 404 : 500;
            reply({ ...base, code, error: String(err) });
          }
          return;
        }

        case 'cached-memory': {
          if (!ensureAuth()) return;
          const name = context.name ? String(context.name) : undefined;
          const snapshot = ctx.ipc.cache.snapshot();
          reply({
            ...base,
            code: 200,
            context: name
              ? { name, value: ctx.ipc.cache.getNotification(name) ?? ctx.ipc.cache.getResponse(name) ?? null }
              : snapshot,
          });
          return;
        }

        default:
          reply({ ...base, code: 404, error: `unknown service: ${service}` });
      }

      function ensureAuth(): boolean {
        if (ctx.controls.bool('api.auth.reject')) {
          reply({ ...base, code: 401, error: 'unauthorized (api.auth.reject)' });
          return false;
        }
        if (!authorized && !(token && verifyToken(token))) {
          reply({ ...base, code: 401, error: 'not authenticated; call auth-token first' });
          return false;
        }
        return true;
      }
    });
  });

  return wss;
}

function normaliseTopics(context: Record<string, unknown>): string[] {
  if (Array.isArray(context.topics)) return context.topics.map(String);
  if (context.topic) return [String(context.topic)];
  return [];
}
