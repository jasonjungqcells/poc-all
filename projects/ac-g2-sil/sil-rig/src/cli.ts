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

interface ScenarioRow {
  name: string;
  description?: string;
  tags?: string[];
  kind?: string;
  areas?: string[];
  steps?: number;
  expects?: number;
  durationMs?: number;
}

/** Compact human duration: the scenario clock runs in minutes and hours, not ms. */
function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = m / 60;
  return h < 48 ? `${h % 1 === 0 ? h : h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
}

/**
 * What a scenario *is*, in one column: 96 of the 157 are static rig setups with
 * no timeline at all, and that is the first thing worth knowing about one.
 */
function scenarioShape(s: ScenarioRow): string {
  if (!s.steps) return 'static setup';
  const checks = s.expects ? `, ${s.expects} check${s.expects === 1 ? '' : 's'}` : '';
  return `${humanMs(s.durationMs ?? 0)} run, ${s.steps} step${s.steps === 1 ? '' : 's'}${checks}`;
}

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
    // `-` reads stdin, so a patch can be piped. The console's "copy as CLI"
    // emits exactly this form: a staged batch of edits is a JSON object, and
    // requiring it to be written to a file first would make the pasted command
    // a two-step instruction rather than a command.
    const source = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
    const map = YAML.parse(source) as Record<string, unknown>;
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
  .option('-t, --tag <tag>', 'filter by raw tag')
  .option('-k, --kind <kind>', 'filter by kind (see `scenario facets`)')
  .option('-a, --area <area>', 'filter by area (see `scenario facets`)')
  .option('-q, --search <text>', 'match name or description')
  .option('--timed', 'only scenarios that have a timeline')
  .action(async (opts) => {
    const body = (await getJson(`${opts.url}/scenarios`)) as { scenarios: ScenarioRow[] };
    const q = String(opts.search ?? '').toLowerCase();
    const filtered = body.scenarios.filter((s) => {
      if (opts.tag && !(s.tags ?? []).includes(opts.tag)) return false;
      if (opts.kind && s.kind !== opts.kind) return false;
      if (opts.area && !(s.areas ?? []).includes(opts.area)) return false;
      if (opts.timed && !s.steps) return false;
      if (q && !`${s.name} ${s.description ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    for (const s of filtered) {
      console.log(
        `${s.name.padEnd(34)} ${String(s.kind ?? '').padEnd(12)} ${scenarioShape(s).padEnd(24)} ${s.description ?? ''}`,
      );
    }
    console.log(`\n${filtered.length} of ${body.scenarios.length} scenario(s)`);
  });

scenario
  .command('facets')
  .description('The kind and area filters, with counts — what the console filters by')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    const f = (await getJson(`${opts.url}/scenarios/facets`)) as {
      total: number;
      kinds: Array<{ id: string; label: string; hint: string; count: number }>;
      areas: Array<{ id: string; label: string; hint: string; count: number }>;
    };
    for (const [title, defs, flag] of [
      ['KIND', f.kinds, '--kind'],
      ['AREA', f.areas, '--area'],
    ] as const) {
      console.log(`\n${title}`);
      for (const d of defs) {
        console.log(`  ${String(d.count).padStart(4)}  ${flag} ${d.id.padEnd(13)} ${d.hint}`);
      }
    }
    console.log(`\n${f.total} scenario(s). Every scenario has one kind and any number of areas.`);
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

scenario
  .command('stop')
  .description('Halt the running timeline, leaving the state it produced in place')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/scenarios/stop`, {}), null, 2));
  });

scenario
  .command('reload')
  .description('Re-read the scenario directory, picking up newly written files')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/scenarios/reload`, {}), null, 2));
  });

scenario
  .command('export [file]')
  .description('Write the current session as a runnable scenario file')
  .option('-n, --name <name>', 'scenario name')
  .option('-d, --description <text>', 'scenario description')
  .option('-t, --tag <tag...>', 'scenario tags')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (file, opts) => {
    const body = (await sendJson('POST', `${opts.url}/scenario/export`, {
      name: opts.name,
      description: opts.description,
      tags: opts.tag,
    })) as { name: string; yaml: string; controls: number; faults: number };
    if (file) {
      writeFileSync(file, body.yaml);
      console.log(`scenario ${body.name} written to ${file} (${body.controls} controls, ${body.faults} faults)`);
    } else {
      process.stdout.write(body.yaml);
    }
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

// ------------------------------------------------------------------ buses
// The wire-level inspectors exist over HTTP already; without CLI equivalents
// the console's bus views would be the only way to reach them, which the parity
// rule forbids.
const spi = program.command('spi').description('Inspect the MPU-MCU SPI link');

spi
  .command('status', { isDefault: true })
  .description('Decoded status frame, with hex bytes')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/spi/status`), null, 2));
  });

spi
  .command('read <register>')
  .description('Read a register as wire bytes plus decoded metrics')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (register, opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/spi/read/${register}`), null, 2));
  });

const can = program.command('can').description('Inspect and drive the g4 CAN bus');

can
  .command('status', { isDefault: true })
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/can/status`), null, 2));
  });

can
  .command('faults')
  .description('Active flag bits, raw bytes, and the domain/severity taxonomy')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/can/faults`), null, 2));
  });

can
  .command('registers [query]')
  .description('Search the register map by name')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (query, opts) => {
    const path = query ? `/can/registers?q=${encodeURIComponent(query)}` : '/can/registers';
    console.log(JSON.stringify(await getJson(`${opts.url}${path}`), null, 2));
  });

can
  .command('read <register>')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (register, opts) => {
    console.log(JSON.stringify(await getJson(`${opts.url}/can/read/${register}`), null, 2));
  });

can
  .command('write <register> [json]')
  .description('Write metrics to a register, as a JSON object')
  .option('-u, --url <url>', 'control API base URL', DEFAULT_CONTROL_URL)
  .action(async (register, json, opts) => {
    const body = JSON.parse(json ?? '{}') as Record<string, unknown>;
    console.log(JSON.stringify(await sendJson('POST', `${opts.url}/can/write/${register}`, body), null, 2));
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
