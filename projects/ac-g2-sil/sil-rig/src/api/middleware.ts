import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { RigContext } from '../core/context.js';
import { fail, send } from './envelope.js';

/** Signing key for locally-issued tokens. Not a secret -- this is a simulator. */
const SIGNING_KEY = 'sil-rig-local-development-only';

declare module 'express-serve-static-core' {
  interface Request {
    /** Route slug used to look up `api.route.{route}.*` controls. */
    silRoute?: string;
  }
}

export function issueToken(ctx: RigContext, subject: string): { token: string; expiresIn: number } {
  const ttl = ctx.controls.num('api.auth.token_ttl_s');
  const token = jwt.sign({ sub: subject, iss: 'sil-rig' }, SIGNING_KEY, { expiresIn: ttl });
  return { token, expiresIn: ttl };
}

export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, SIGNING_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Tag a request with its route slug so fault controls can target it. */
export function tagRoute(route: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.silRoute = route;
    next();
  };
}

/**
 * Transport-level fault injection.
 *
 * Runs before every handler so latency, forced statuses, hangs and random
 * failures apply uniformly. This is what lets a scenario say "make
 * /telemetry hang" without any endpoint knowing such a thing is possible.
 */
export function faultInjection(ctx: RigContext) {
  const rng = ctx.rng.derive('api_faults');

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { controls } = ctx;
    const route = req.silRoute;

    // Still booting. A real board answers its port before it is ready to be
    // commissioned, so clients must handle 503 rather than assuming that a
    // reachable device is a usable one.
    const bootDelayS = controls.num('sim.boot_delay_s');
    if (bootDelayS > 0 && ctx.clock.elapsedMs() < bootDelayS * 1000 && route !== 'version') {
      send(ctx, res, 503, fail(ctx, 4604, 'device not ready (booting)'), route);
      return;
    }

    // Never respond at all. Clients must fall back to their own timeout.
    if (route && controls.bool(`api.route.${route}.hang`)) {
      ctx.log('warn', `hanging request by control: ${req.method} ${req.path}`);
      return;
    }

    const globalLatency = controls.num('api.latency_ms');
    const routeLatency = route ? controls.num(`api.route.${route}.latency_ms`) : 0;
    const jitter = controls.num('api.jitter_ms');
    const delayMs = Math.max(globalLatency, routeLatency) + (jitter > 0 ? rng.int(0, jitter) : 0);
    if (delayMs > 0) await sleep(delayMs);

    const forcedStatus = route ? controls.num(`api.route.${route}.status`) : 0;
    if (forcedStatus >= 400) {
      send(ctx, res, forcedStatus, fail(ctx, forcedStatus, `forced by api.route.${route}.status`), route);
      return;
    }

    if (rng.chance(controls.num('api.fail_rate_pct'))) {
      const status = controls.num('api.fail_status');
      send(ctx, res, status, fail(ctx, status, 'injected failure (api.fail_rate_pct)'), route);
      return;
    }

    const forcedBody = route ? controls.get(`api.route.${route}.body`) : null;
    if (forcedBody !== null && forcedBody !== undefined) {
      send(ctx, res, 200, forcedBody, route);
      return;
    }

    next();
  };
}

/**
 * Bearer auth.
 *
 * `api.auth.reject` forces a permanent 401, and a short `api.auth.token_ttl_s`
 * makes tokens expire naturally mid-flow -- the two halves of testing a
 * client's refresh logic.
 */
export function requireAuth(ctx: RigContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (ctx.controls.bool('api.auth.reject')) {
      send(ctx, res, 401, fail(ctx, 4001, 'unauthorized (api.auth.reject)'), req.silRoute);
      return;
    }

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token || !verifyToken(token)) {
      send(ctx, res, 401, fail(ctx, 4002, 'missing or expired token'), req.silRoute);
      return;
    }
    next();
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
