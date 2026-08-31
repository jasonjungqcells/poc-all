import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

import { Clock, parseDuration } from '../src/core/clock.js';
import { ControlError, ControlRegistry } from '../src/core/controls.js';
import { CONTROL_DEFS } from '../src/core/control-defs.js';
import { Rng } from '../src/core/rng.js';
import { crc16ccitt } from '../src/mcu/crc.js';
import { decodeFrame, encodeFrame, STANDARD_FRAME_LEN, FOURK_FRAME_LEN } from '../src/mcu/frame.js';
import { POWER_DEAD_BAND_KW, toDisplayKw } from '../src/plant/plant.js';
import { ALL_FAULTS, faultsForDevice, lookupFault } from '../src/faults/codebook.js';

const registry = (): ControlRegistry => {
  const reg = new ControlRegistry();
  for (const def of CONTROL_DEFS) reg.define(def);
  return reg;
};

// ------------------------------------------------------------------- rng

test('rng is reproducible for a given seed', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const c = new Rng(43);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  const seqC = Array.from({ length: 20 }, () => c.next());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('derived substreams are independent of draw order', () => {
  // Enabling chaos in one subsystem must not shift the numbers any other
  // subsystem sees, or scenarios stop being comparable to each other.
  const base = new Rng(7);
  const faultsFirst = base.derive('faults').next();
  const apiFirst = base.derive('api_faults').next();

  const base2 = new Rng(7);
  const apiSecond = base2.derive('api_faults').next();
  const faultsSecond = base2.derive('faults').next();

  assert.equal(faultsFirst, faultsSecond);
  assert.equal(apiFirst, apiSecond);
});

// ----------------------------------------------------------------- clock

test('parseDuration handles compound durations', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('5m10s'), 310_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('0'), 0);
});

test('clock skew offsets every reported timestamp', () => {
  const clock = new Clock('2026-06-21T00:00:00Z');
  assert.equal(clock.nowIso(), '2026-06-21T00:00:00.000Z');
  clock.setSkewSeconds(7200);
  assert.equal(clock.nowIso(), '2026-06-21T02:00:00.000Z');
  assert.equal(clock.skewSeconds(), 7200);
});

// -------------------------------------------------------------- controls

test('controls reject out-of-range and unknown enum values', () => {
  const reg = registry();
  assert.throws(() => reg.set('plant.battery.soc_pct', 500), ControlError);
  assert.throws(() => reg.set('plant.battery.soc_pct', -1), ControlError);
  assert.throws(() => reg.set('site.backup_type', 'NOT_A_TYPE'), ControlError);
  assert.throws(() => reg.set('does.not.exist', 1), ControlError);
  reg.set('plant.battery.soc_pct', 42);
  assert.equal(reg.num('plant.battery.soc_pct'), 42);
});

test('patch is all-or-nothing', () => {
  const reg = registry();
  const before = reg.num('plant.battery.soc_pct');
  assert.throws(
    () => reg.patch({ 'plant.battery.soc_pct': 60, 'site.backup_type': 'BOGUS' }),
    ControlError,
  );
  assert.equal(reg.num('plant.battery.soc_pct'), before, 'a rejected patch must not partially apply');
});

test('diff reports only operator-set controls', () => {
  const reg = registry();
  assert.deepEqual(reg.diff(), {});
  reg.set('plant.battery.soc_pct', 77);
  reg.set('plant.pv_w', 1234, { internal: true });
  const diff = reg.diff();
  assert.equal(diff['plant.battery.soc_pct'], 77);
  assert.ok(
    !('plant.pv_w' in diff),
    'plant-derived writes must stay out of the diff, or every diff would be noise',
  );
});

test('pattern controls accept dynamic ids', () => {
  const reg = registry();
  assert.ok(reg.has('api.route.telemetry.hang'));
  reg.set('api.route.telemetry.hang', true);
  assert.equal(reg.bool('api.route.telemetry.hang'), true);
  assert.equal(reg.bool('api.route.publish.hang'), false);
});

// ------------------------------------------------------------------- crc

test('CRC16-CCITT matches the known check vector', () => {
  // Poly 0x1021, init 0x0000: "123456789" => 0x31C3.
  assert.equal(crc16ccitt(new TextEncoder().encode('123456789')), 0x31c3);
});

test('frames round-trip and detect corruption', () => {
  const payload = new Uint8Array(64).fill(0x5a);
  const frame = encodeFrame(0x88, 0x8010, payload);
  assert.equal(frame.length, STANDARD_FRAME_LEN, 'FUS-124 fixes MPU Rx at 71 bytes');

  const decoded = decodeFrame(frame);
  assert.equal(decoded.sync, 0xaa);
  assert.equal(decoded.cmd, 0x88);
  assert.equal(decoded.address, 0x8010);
  assert.equal(decoded.crcValid, true);

  const corrupt = Uint8Array.from(frame);
  corrupt[10] = (corrupt[10]! ^ 0xff) & 0xff;
  assert.equal(decodeFrame(corrupt).crcValid, false);
});

test('4K mode produces a 4107 byte frame', () => {
  const frame = encodeFrame(0x88, 0x8012, new Uint8Array(4100), '4k');
  assert.equal(frame.length, FOURK_FRAME_LEN);
});

// --------------------------------------------------------------- display

test('deadband is applied before rounding', () => {
  // The device suppresses anything below 0.1 kW, and does so on the raw value
  // rather than the rounded one. Rounding first would let 0.06 kW survive as
  // 0.1 kW, which is exactly the defect this ordering prevents.
  assert.equal(POWER_DEAD_BAND_KW, 0.1);
  assert.equal(toDisplayKw(60), 0);
  assert.equal(toDisplayKw(-60), 0);
  assert.equal(toDisplayKw(99), 0);
  assert.equal(toDisplayKw(100), 0.1);
  assert.equal(toDisplayKw(1250), 1.3);
  assert.equal(toDisplayKw(-1250), -1.3);
});

// --------------------------------------------------------------- faults

test('every codebook entry is unique and resolvable', () => {
  const codes = ALL_FAULTS.map((f) => f.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate fault codes');
  for (const code of codes) assert.ok(lookupFault(code), `unresolvable code ${code}`);
});

test('device sweep covers the whole codebook', () => {
  assert.equal(faultsForDevice('all').length, ALL_FAULTS.length);
  const ems = faultsForDevice('ems');
  assert.ok(ems.length > 0);
  assert.ok(ems.every((f) => f.device === 'ems'));
});

// ------------------------------------------------------------ scenarios

test('every scenario references only defined controls with valid values', () => {
  const reg = registry();
  const dir = new URL('../scenarios/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length > 100, `expected a substantial corpus, found ${files.length}`);

  const names = new Set<string>();
  const problems: string[] = [];

  for (const file of files) {
    const doc = parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, any>;
    const name = String(doc.name ?? '');

    if (!name) problems.push(`${file}: missing name`);
    if (name && name !== file.replace(/\.yaml$/, '')) {
      problems.push(`${file}: name "${name}" does not match the filename`);
    }
    if (names.has(name)) problems.push(`${file}: duplicate scenario name`);
    names.add(name);
    if (!doc.description) problems.push(`${file}: missing description`);

    const blocks: Record<string, unknown>[] = [];
    if (doc.controls) blocks.push(doc.controls);
    for (const step of doc.timeline ?? []) {
      if (step.set) blocks.push(step.set);
      if (step.at === undefined) problems.push(`${file}: timeline step without "at"`);
      else {
        try {
          parseDuration(String(step.at));
        } catch {
          problems.push(`${file}: unparseable duration "${step.at}"`);
        }
      }
    }

    for (const block of blocks) {
      for (const [id, value] of Object.entries(block)) {
        if (!reg.has(id)) {
          problems.push(`${file}: unknown control ${id}`);
          continue;
        }
        try {
          reg.set(id, value);
        } catch (err) {
          problems.push(`${file}: ${id} = ${JSON.stringify(value)} rejected: ${(err as Error).message}`);
        }
      }
    }
    reg.reset();
  }

  assert.deepEqual(problems, [], `scenario corpus problems:\n${problems.join('\n')}`);
});

test('every scenario extends a base that exists', () => {
  const dir = new URL('../scenarios/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const names = new Set(files.map((f) => f.replace(/\.yaml$/, '')));

  for (const file of files) {
    const doc = parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, any>;
    if (doc.extends) {
      assert.ok(names.has(String(doc.extends)), `${file} extends missing base ${doc.extends}`);
    }
  }
});

test('injected fault codes exist in the codebook', () => {
  const dir = new URL('../scenarios/', import.meta.url);
  const known = new Set(ALL_FAULTS.map((f) => f.code));
  // fault_unknown_code deliberately injects a code that is absent, to prove the
  // UI degrades rather than crashes.
  const deliberate = new Set(['zz999']);

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const doc = parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, any>;
    for (const step of doc.timeline ?? []) {
      const injects = Array.isArray(step.inject) ? step.inject : step.inject ? [step.inject] : [];
      for (const inj of injects) {
        const code = String(inj.code);
        if (deliberate.has(code)) continue;
        assert.ok(known.has(code), `${file} injects unknown fault ${code}`);
      }
      for (const code of step.clear ?? []) {
        if (deliberate.has(String(code))) continue;
        assert.ok(known.has(String(code)), `${file} clears unknown fault ${code}`);
      }
    }
  }
});
