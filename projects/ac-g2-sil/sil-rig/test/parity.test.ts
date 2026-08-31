import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { ACTIONS, cliFor } from '../web/src/api/actions.js';

/**
 * The parity rule, enforced.
 *
 *   "Any HMI/GUI panel must be a thin client of the control API. If the CLI
 *    can't do it, the panel doesn't get to either."
 *      -- AC-GEN2-SIL-CONTROL-PLANE.md §18
 *
 * The failure this prevents is specific and expensive: a QA engineer reproduces
 * a bug by clicking, files it as a screenshot, and nobody can run it again. The
 * console is only allowed to exist because every action it offers is also a
 * command, and a rule that is only written down is a rule that decays.
 *
 * So the console's action table is checked against the two things it claims
 * parity with -- the control API's routes and the CLI's commands. Adding a
 * mutating call to the console without a CLI equivalent fails the build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const controlApi = readFileSync(join(HERE, '..', 'src', 'control', 'api.ts'), 'utf8');
const eventsApi = readFileSync(join(HERE, '..', 'src', 'control', 'events.ts'), 'utf8');
const cliSource = readFileSync(join(HERE, '..', 'src', 'cli.ts'), 'utf8');

/** Every route the control plane registers, as `METHOD /path`. */
const routes = new Set<string>();
for (const source of [controlApi, eventsApi]) {
  for (const [, method, path] of source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
    routes.add(`${method!.toUpperCase()} ${path}`);
  }
}

/** Every command name the CLI defines, at any depth. */
const commands = new Set<string>();
for (const [, declaration] of cliSource.matchAll(/\.command\('([^']+)'/g)) {
  commands.add(declaration!.split(' ')[0]!);
}

test('the control plane serves every route the console calls', () => {
  for (const action of ACTIONS) {
    assert.ok(
      routes.has(`${action.method} ${action.route}`),
      `console action ${action.id} calls ${action.method} ${action.route}, which the control API does not serve`,
    );
  }
});

test('the CLI can do everything the console can', () => {
  for (const action of ACTIONS) {
    for (const word of action.cli.split(' ')) {
      assert.ok(
        commands.has(word),
        `console action ${action.id} claims "sil ${action.cli}", but the CLI has no "${word}" command`,
      );
    }
  }
});

test('every console action renders a runnable command', () => {
  for (const action of ACTIONS) {
    const rendered = cliFor(action.id, {
      id: 'plant.pv_w',
      value: '4000',
      name: 'grid_outage',
      code: 'e001',
      register: 'P01_PCS_Control',
      file: 'repro.yaml',
      by: '1m',
      rate: '2',
      json: '{"plant.pv_w":4000}',
    });
    assert.match(rendered, /^(sil|echo) /, `${action.id} rendered "${rendered}"`);
    // A rendered command with a placeholder left in it would paste into a
    // terminal and fail, which is worse than offering no command at all.
    assert.doesNotMatch(rendered, /<[a-z]+>/, `${action.id} left a placeholder in "${rendered}"`);
  }
});

test('action ids are unique', () => {
  const ids = ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate action id');
});

/**
 * The console is a client, not a second engine.
 *
 * Nothing under `web/` may import the rig's runtime: the moment it does, the
 * console stops being reproducible from the control API alone and starts being
 * a place where behaviour can hide. Type-only imports are fine -- they are
 * erased at build time and keep the widget generator honest about `ControlDef`.
 */
test('the console imports no rig runtime code', () => {
  const files = [
    'api/client.ts',
    'api/stream.ts',
    'api/rig.ts',
    'api/actions.ts',
    'api/types.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(HERE, '..', 'web', 'src', file), 'utf8');
    for (const [line] of source.matchAll(/^.*from '\.\.\/\.\.\/\.\.\/src\/.*$/gm)) {
      assert.match(
        line,
        /^\s*(export|import) type /,
        `${file} imports rig runtime code: ${line.trim()}`,
      );
    }
  }
});
