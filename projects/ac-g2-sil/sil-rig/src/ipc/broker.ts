import { EventEmitter } from 'node:events';

/**
 * In-process MQTT-shaped IPC bus.
 *
 * UniEP's IPC is MQTT with the topic pattern `<app>/<req|res|noti>/<service>`,
 * so a virtual device app is just another client on that bus -- no LD_PRELOAD
 * and no patched binaries required. Modelling it in-process keeps the topic
 * grammar identical while removing the broker dependency.
 */

export type IpcKind = 'req' | 'res' | 'noti';

export interface IpcEnvelope {
  headers?: { authorization?: string };
  tid?: string;
  service: string;
  timestamp?: string;
  context?: unknown;
}

export interface IpcMessage {
  topic: string;
  app: string;
  kind: IpcKind;
  service: string;
  payload: IpcEnvelope;
}

export type RequestHandler = (payload: IpcEnvelope) => Promise<unknown> | unknown;

export function topicFor(app: string, kind: IpcKind, service: string): string {
  return `${app}/${kind}/${service}`;
}

/**
 * Cache Manager.
 *
 * Mirrors UniEP's behaviour of retaining the most recent Response and
 * Notification value per topic, which is what `GET /notifications/{name}` and
 * the WebSocket `cached-memory` service read from. Serving both surfaces from
 * one store is deliberate: a poller and a subscriber observing different values
 * is a real device bug, and it must only ever happen when a scenario asks for it.
 */
export class CacheManager {
  private readonly responses = new Map<string, unknown>();
  private readonly notifications = new Map<string, unknown>();

  putResponse(topic: string, value: unknown): void {
    this.responses.set(topic, value);
  }

  putNotification(name: string, value: unknown): void {
    this.notifications.set(name, value);
  }

  getResponse(topic: string): unknown {
    return this.responses.get(topic);
  }

  getNotification(name: string): unknown {
    return this.notifications.get(name);
  }

  notificationNames(): string[] {
    return [...this.notifications.keys()].sort();
  }

  snapshot(): { responses: Record<string, unknown>; notifications: Record<string, unknown> } {
    return {
      responses: Object.fromEntries(this.responses),
      notifications: Object.fromEntries(this.notifications),
    };
  }

  clear(): void {
    this.responses.clear();
    this.notifications.clear();
  }
}

export class IpcBroker extends EventEmitter {
  readonly cache = new CacheManager();
  private readonly handlers = new Map<string, RequestHandler>();

  /** Register `<app>/req/<service>`. Duplicate registration is a programming error. */
  handle(app: string, service: string, handler: RequestHandler): void {
    const key = topicFor(app, 'req', service);
    if (this.handlers.has(key)) throw new Error(`duplicate IPC handler: ${key}`);
    this.handlers.set(key, handler);
  }

  hasHandler(app: string, service: string): boolean {
    return this.handlers.has(topicFor(app, 'req', service));
  }

  services(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * Issue a request and await its response, caching the result the way the real
   * Cache Manager does.
   */
  async request(app: string, service: string, payload: IpcEnvelope): Promise<unknown> {
    const reqTopic = topicFor(app, 'req', service);
    this.emitMessage({ topic: reqTopic, app, kind: 'req', service, payload });

    const handler = this.handlers.get(reqTopic);
    if (!handler) throw new IpcServiceNotFound(app, service);

    const result = await handler(payload);
    const resTopic = topicFor(app, 'res', service);
    this.cache.putResponse(resTopic, result);
    this.emitMessage({
      topic: resTopic,
      app,
      kind: 'res',
      service,
      payload: { ...payload, service, context: result },
    });
    return result;
  }

  /** Publish an asynchronous notification, e.g. `swupdate_progress`. */
  notify(app: string, service: string, context: unknown): void {
    const topic = topicFor(app, 'noti', service);
    this.cache.putNotification(service, context);
    this.emitMessage({
      topic,
      app,
      kind: 'noti',
      service,
      payload: { service, timestamp: new Date().toISOString(), context },
    });
  }

  private emitMessage(msg: IpcMessage): void {
    this.emit('message', msg);
    this.emit(msg.topic, msg);
  }
}

export class IpcServiceNotFound extends Error {
  constructor(readonly app: string, readonly service: string) {
    super(`no IPC handler for ${app}/req/${service}`);
    this.name = 'IpcServiceNotFound';
  }
}
