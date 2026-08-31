import type { Response } from 'express';
import type { RigContext } from '../core/context.js';

/**
 * EmbResponse envelope.
 *
 * The installer apps branch on this shape, so it must match the board exactly.
 * Getting the envelope subtly wrong is the single fastest way to make a
 * simulator worse than no simulator: clients would pass against the rig and
 * fail against hardware.
 */
export interface EmbResponse<T> {
  code: number;
  message: string;
  data?: T;
  timestamp: string;
}

export function ok<T>(ctx: RigContext, data: T, message = 'success'): EmbResponse<T> {
  return { code: 200, message, data, timestamp: ctx.clock.nowIso() };
}

export function fail(ctx: RigContext, code: number, message: string): EmbResponse<never> {
  return { code, message, timestamp: ctx.clock.nowIso() };
}

/**
 * Send a response, honouring `api.malformed_json` and per-route truncation.
 *
 * These two controls exist because "the server returned something that isn't
 * valid JSON" and "the body stopped halfway" are real field conditions that
 * almost no client handles, and neither is reachable by returning a normal
 * error status.
 */
export function send(ctx: RigContext, res: Response, status: number, body: unknown, route?: string): void {
  const truncate = route ? ctx.controls.bool(`api.route.${route}.truncate`) : false;
  const malformed = ctx.controls.bool('api.malformed_json');

  if (malformed) {
    res.status(status).type('application/json').send('{"code":200,"data":{"unterminated": ');
    return;
  }

  const serialized = JSON.stringify(body);
  if (truncate) {
    res.status(status).type('application/json').send(serialized.slice(0, Math.floor(serialized.length / 2)));
    return;
  }

  res.status(status).type('application/json').send(serialized);
}
