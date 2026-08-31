import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { AREAS, KINDS, areasOf, kindOf } from '../src/scenario/facets.js';
import type { ScenarioDoc } from '../src/scenario/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'scenarios');

const corpus: ScenarioDoc[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  .map((f) => YAML.parse(readFileSync(join(DIR, f), 'utf8')) as ScenarioDoc);

test('kinds are resolved most specific first', () => {
  // A boundary case that fails by design is a boundary case; filing it with the
  // other seventy failures would lose the only interesting thing about it.
  assert.equal(kindOf(['boundary', 'failure']), 'boundary');
  assert.equal(kindOf(['base', 'residential']), 'baseline');
  assert.equal(kindOf(['grid', 'ieee1547', 'standards']), 'conformance');
  assert.equal(kindOf(['failure', 'grid']), 'failure');
});

test('an unremarkable scenario is nominal, not unclassified', () => {
  assert.equal(kindOf([]), 'nominal');
  assert.equal(kindOf(undefined), 'nominal');
  assert.equal(kindOf(['solar', 'weather']), 'nominal');
});

test('areas are additive and never empty', () => {
  assert.deepEqual(areasOf(['grid', 'battery']), ['grid', 'energy']);
  assert.deepEqual(areasOf(['nonsense']), ['other']);
  assert.deepEqual(areasOf([]), ['other']);
});

/**
 * The point of the facets is that the filter list is shorter than the result
 * list. If a bucket swallows most of the corpus it has stopped filtering, and
 * if one is empty it is just noise in the UI.
 */
test('every kind is used, and none swallows the corpus', () => {
  const tally = new Map<string, number>();
  for (const doc of corpus) tally.set(kindOf(doc.tags), (tally.get(kindOf(doc.tags)) ?? 0) + 1);
  for (const { id, label } of KINDS) {
    const n = tally.get(id) ?? 0;
    assert.ok(n > 0, `kind ${label} matches no scenario`);
    assert.ok(n < corpus.length * 0.6, `kind ${label} matches ${n} of ${corpus.length} scenarios`);
  }
});

test('every area is used, and few scenarios go unfiled', () => {
  const tally = new Map<string, number>();
  for (const doc of corpus) for (const a of areasOf(doc.tags)) tally.set(a, (tally.get(a) ?? 0) + 1);
  for (const { id, label } of AREAS) {
    assert.ok((tally.get(id) ?? 0) > 0, `area ${label} matches no scenario`);
  }
  assert.ok(
    (tally.get('other') ?? 0) < corpus.length * 0.1,
    `${tally.get('other')} of ${corpus.length} scenarios have no area`,
  );
});

test('facet ids are unique and every one carries a hint', () => {
  for (const defs of [KINDS, AREAS]) {
    assert.equal(new Set(defs.map((d) => d.id)).size, defs.length);
    for (const d of defs) {
      assert.ok(d.label.length > 0 && d.hint.length > 10, `${d.id} needs a readable hint`);
    }
  }
});
