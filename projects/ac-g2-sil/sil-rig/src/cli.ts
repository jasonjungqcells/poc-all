#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { createRig } from './server.js';

const program = new Command();
program
  .name('sil')
  .description('AC Gen2 EMS+ software-in-the-loop rig')
  .version('0.1.0');

const DEFAULT_CONTROL_URL = process.env.SIL_CONTROL_URL ?? 'http://127.0.0.1:9114';

program
  .command('serve')
  .description('Run the rig: local device API, WebSocket bridge, and control plane')
  .option('-p, --port <n>', 'device API port', (v) => Number(v), 9112)
  .option('-c, --control-port <n>', 'control API port', (v) => Number(v), 9114)
  .option('-s, --seed <n>', 'RNG seed; identical seeds reproduce a run exactly', (v) => Number(v), 1)
  .option('-S, --scenario <name>', 'scenario to load at startup')
  .option('--scenario-dir <path>', 'scenario directory')
  .option('--register-map <path>', 'path to factory_register_map.json')
  .option('--no-tls', 'serve plain HTTP instead of HTTPS')
  .option('--host <addr>', 'bind address', '0.0.0.0')
  .option('--paused', 'start with the clock paused')
  .action(async (opts) => {
    const rig = createRig({
      port: opts.port,
      controlPort: opts.controlPort,
      seed: opts.seed,
      scenario: opts.scenario,
      scenarioDir: opts.scenarioDir,
      registerMap: opts.registerMap,
      tls: opts.tls,
      host: opts.host,
      autoplay: !opts.paused,
    });

    const shutdown = async () => {
      await rig.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await rig.start();
  });

// ------------------------------------------------------------------ ctl
const ctl = program.command('ctl').description('Read and write controls on a running rig');

ctl
  .command('list [group]')
  .description('List controls, optionally filtered to one group')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (group, opts) => {
    const url = group ? `${opts.url}/control?group=${group}` : `${opts.url}/control`;
    const body = (await getJson(url)) as { controls: Array<Record<string, unknown>> };
    for (const c of body.controls) {
      const value = JSON.stringify(c.value);
      console.log(`${String(c.id).padEnd(42)} ${String(value).padEnd(24)} ${c.description}`);
    }
  });

ctl
  .command('get <id>')
  .description('Read one control')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (id, opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/control/${id}`), null, 2));
  });

ctl
  .command('set <id> <value>')
  .description('Write one control')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (id, value, opts) => {
    const parsed = parseScalar(value);
    console.log(JSON.stringify(await sendJson('PUT', `${opts.url}/control/${id}`, { value: parsed }), null, 2));
  });

ctl
  .command('patch [file]')
  .description('Bulk-write controls from a YAML or JSON file')
  // Accepts the path either positionally or via -f, matching `snapshot save`.
  .option('-f, --file <path>', 'file containing a control map')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (file, opts) => {
    const path = file ?? opts.file;
    if (!path) throw new Error('a file path is required, positionally or with -f');
    const map = YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    console.log(JSON.stringify(await sendJson('PATCH', `${opts.url}/control`, { controls: map }), null, 2));
  });

ctl
  .command('diff')
  .description('Show controls that differ from their defaults, ready to paste into a scenario')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .option('--yaml', 'emit YAML instead of JSON')
  .action(async (opts) => {
    const body = (await getJson(`${opts.url}/control/diff`)) as { controls: Record<string, unknown> };
    console.log(opts.yaml ? YAML.stringify({ controls: body.controls }) : JSON.stringify(body.controls, null, 2));
  });

ctl
  .command('reset')
  .description('Reset every control to its default')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/control/reset`, {}), null, 2));
  });

// ---------------------------------------------------------------- clock
const clock = program.command('clock').description('Control virtual time');

// Bare `sil clock` reports rather than printing usage: inspecting the clock is
// the first thing anyone does when time appears stuck, so it should be the
// default rather than something you have to know a subcommand for.
clock
  .command('status', { isDefault: true })
  .description('Show the current time, rate, tick interval and tick count')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await sendJson('GET', `${opts.url}/clock`, undefined), null, 2));
  });

clock
  .command('step <duration>')
  .description('Advance virtual time, e.g. 30s, 5m, 1h')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (duration, opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/clock/step`, { duration }), null, 2));
  });

clock
  .command('pause')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/clock/pause`, {}), null, 2));
  });

clock
  .command('resume [rate]')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (rate, opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/clock/resume`, { rate: Number(rate ?? 1) }), null, 2));
  });

// ------------------------------------------------------------- scenario
const scenario = program.command('scenario').description('Load and inspect scenarios');

scenario
  .command('list')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .option('-t, --tag <tag>', 'filter by tag')
  .action(async (opts) => {
    const body = (await getJson(`${opts.url}/scenarios`)) as {
      scenarios: Array<{ name: string; description?: string; tags?: string[] }>;
    };
    const filtered = opts.tag
      ? body.scenarios.filter((s) => s.tags?.includes(opts.tag))
      : body.scenarios;
    for (const s of filtered) {
      console.log(`${s.name.padEnd(36)} ${(s.tags ?? []).join(',').padEnd(28)} ${s.description ?? ''}`);
    }
    console.log(`\n${filtered.length} scenario(s)`);
  });

scenario
  .command('show <name>')
  .description('Print a scenario with its `extends` chain fully resolved')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (name, opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/scenarios/${name}`), null, 2));
  });

scenario
  .command('load <name>')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (name, opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/scenarios/${name}/load`, {}), null, 2));
  });

scenario
  .command('state')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/scenario/state`), null, 2));
  });

// ---------------------------------------------------------------- fault
const fault = program.command('fault').description('Inject and clear device faults');

fault
  .command('inject <code>')
  .option('-d, --device <device>', 'device the fault belongs to')
  .option('-l, --level <level>', 'W, A, or F')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (code, opts) => {
    console.log(
      JSON.stringify(
        await sendJson('POST', `${opts.url}/fault/inject`, { code, device: opts.device, level: opts.level }),
        null,
        2,
      ),
    );
  });

fault
  .command('clear <code>')
  .description('Clear one fault, or "all"')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (code, opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/fault/clear`, { code }), null, 2));
  });

fault
  .command('list')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    const body = (await getJson(`${opts.url}/fault`)) as { active: unknown[] };
    console.log(JSON.stringify(body.active, null, 2));
  });

// ------------------------------------------------------------- snapshot
const snapshot = program.command('snapshot').description('Capture and restore full rig state');

snapshot
  .command('save <file>')
  .description('Write a snapshot; attach it to a bug report for exact reproduction')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (file, opts) => {
    const body = await getJson(`${opts.url}/snapshot`);
    writeFileSync(file, JSON.stringify(body, null, 2));
    console.log(`snapshot written to ${file}`);
  });

snapshot
  .command('restore <file>')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (file, opts) => {
    const body = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/snapshot/restore`, body), null, 2));
  });

program
  .command('state')
  .description('Print current rig state')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/state`), null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});

// ------------------------------------------------------------------ helpers

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function sendJson(method: string, url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(parsed)}`);
  return parsed;
}

/** Coerce CLI strings so `set x true` and `set x 42` do the obvious thing. */
function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
