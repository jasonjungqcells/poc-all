/**
 * Every mutating thing the console can do, and the CLI command that does the
 * same thing.
 *
 * This table exists to make the parity rule checkable rather than aspirational
 * (`AC-GEN2-SIL-CONTROL-PLANE.md` §18). It has two consumers:
 *
 *  1. The console, which shows "copy as CLI" next to actions, so the terminal
 *     equivalent of a click is always one keystroke away.
 *  2. `test/parity.test.ts`, which asserts every entry names a route the
 *     control API actually serves and a command the CLI actually defines. A
 *     console-only capability fails the build.
 *
 * Adding a mutating call to the console without adding it here is therefore a
 * test failure, not a silent divergence.
 */

export interface RigAction {
  id: string;
  label: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Route on the control API, with `:params` left symbolic. */
  route: string;
  /** CLI command, with `<args>` left symbolic. Verified to exist by the test. */
  cli: string;
  /** Renders the concrete CLI invocation for a given set of arguments. */
  render: (args: Record<string, string>) => string;
}

const quote = (value: string): string =>
  /^[A-Za-z0-9_.:/=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

function action(
  id: string,
  label: string,
  method: RigAction['method'],
  route: string,
  cli: string,
  render: (args: Record<string, string>) => string,
): RigAction {
  return { id, label, method, route, cli, render };
}

export const ACTIONS: RigAction[] = [
  action('control.set', 'Set a control', 'PUT', '/control/:id', 'ctl set', (a) =>
    `sil ctl set ${a.id ?? '<id>'} ${quote(a.value ?? '<value>')}`),
  action('control.invoke', 'Fire an action control', 'PUT', '/control/:id', 'ctl set', (a) =>
    `sil ctl set ${a.id ?? '<id>'} true`),
  action('control.patch', 'Apply staged edits', 'PATCH', '/control', 'ctl patch', (a) =>
    `echo ${quote(a.json ?? '{}')} | sil ctl patch -`),
  action('control.reset', 'Reset all controls', 'POST', '/control/reset', 'ctl reset', () =>
    'sil ctl reset'),
  action('clock.step', 'Step the clock', 'POST', '/clock/step', 'clock step', (a) =>
    `sil clock step ${a.by ?? '1s'}`),
  action('clock.pause', 'Pause the clock', 'POST', '/clock/pause', 'clock pause', () =>
    'sil clock pause'),
  action('clock.resume', 'Resume the clock', 'POST', '/clock/resume', 'clock resume', (a) =>
    `sil clock resume${a.rate && a.rate !== '1' ? ` ${a.rate}` : ''}`),
  action('scenario.load', 'Load a scenario', 'POST', '/scenarios/:name/load', 'scenario load', (a) =>
    `sil scenario load ${a.name ?? '<name>'}`),
  action('scenario.stop', 'Stop the scenario', 'POST', '/scenarios/stop', 'scenario stop', () =>
    'sil scenario stop'),
  action('scenario.reload', 'Re-read the scenario directory', 'POST', '/scenarios/reload', 'scenario reload', () =>
    'sil scenario reload'),
  action('scenario.export', 'Export session as scenario', 'POST', '/scenario/export', 'scenario export', (a) =>
    `sil scenario export ${a.file ?? 'repro.yaml'}`),
  action('fault.inject', 'Inject a fault', 'POST', '/fault/inject', 'fault inject', (a) =>
    `sil fault inject ${a.code ?? '<code>'}${a.device ? ` -d ${a.device}` : ''}${a.level ? ` -l ${a.level}` : ''}`),
  action('fault.clear', 'Clear a fault', 'POST', '/fault/clear', 'fault clear', (a) =>
    `sil fault clear ${a.code ?? '<code>'}`),
  action('fault.clearAll', 'Clear all faults', 'POST', '/fault/clear', 'fault clear', () =>
    'sil fault clear all'),
  // Saving is a read of `/snapshot`; the artifact is produced by writing what
  // comes back to a file, which is what the CLI does too.
  action('snapshot.save', 'Save a snapshot', 'GET', '/snapshot', 'snapshot save', (a) =>
    `sil snapshot save ${a.file ?? 'snapshot.json'}`),
  action('snapshot.restore', 'Restore a snapshot', 'POST', '/snapshot/restore', 'snapshot restore', (a) =>
    `sil snapshot restore ${a.file ?? 'snapshot.json'}`),
  action('can.write', 'Write a CAN register', 'POST', '/can/write/:register', 'can write', (a) =>
    `sil can write ${a.register ?? '<register>'} ${quote(a.json ?? '{}')}`),
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/** The CLI equivalent of a console action, ready to paste into a terminal. */
export function cliFor(id: string, args: Record<string, string> = {}): string {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown action: ${id}`);
  return found.render(args);
}
