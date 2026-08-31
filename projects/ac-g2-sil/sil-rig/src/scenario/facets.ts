/**
 * Scenario facets.
 *
 * The corpus carries 88 distinct tags, and 80 of them appear once or twice.
 * That is a good vocabulary for authors and a terrible one for anybody trying
 * to find a scenario: a filter list as long as the result list has not filtered
 * anything. These facets fold the long tail onto two short axes -- what kind of
 * run it is, and what part of the system it exercises -- which is how people
 * actually ask the question ("the grid failure ones").
 *
 * The mapping lives on the server rather than in the console on purpose. A
 * filter the GUI can express but the CLI cannot would be exactly the kind of
 * browser-only behaviour the parity rule exists to prevent, so `sil scenario
 * list --kind failure --area grid` and the console's facet rows are the same
 * feature reading the same table.
 */

export type ScenarioKind =
  | 'baseline'
  | 'conformance'
  | 'endurance'
  | 'boundary'
  | 'failure'
  | 'degraded'
  | 'nominal';

export type ScenarioArea =
  | 'grid'
  | 'energy'
  | 'buses'
  | 'faults'
  | 'connectivity'
  | 'cloud'
  | 'setup'
  | 'app'
  | 'other';

export interface FacetDef<T extends string> {
  id: T;
  label: string;
  /** One line, written to be read by someone who has never seen the corpus. */
  hint: string;
}

/**
 * Kinds are mutually exclusive and resolved in listed order, most specific
 * first. A scenario tagged `[boundary, failure]` is a boundary case that fails
 * by design, and filing it under "failure" with the other 80 would lose the
 * only interesting thing about it.
 */
export const KINDS: ReadonlyArray<FacetDef<ScenarioKind>> = [
  { id: 'baseline', label: 'Baseline', hint: 'Plain rig setups that other scenarios build on' },
  { id: 'conformance', label: 'Conformance', hint: 'Checked against a published standard, mostly IEEE 1547' },
  { id: 'endurance', label: 'Endurance', hint: 'Long, high-volume or deliberately chaotic runs' },
  { id: 'boundary', label: 'Boundary', hint: 'The edge of the operating envelope, and just past it' },
  { id: 'failure', label: 'Failure', hint: 'Something breaks and the system has to cope' },
  { id: 'degraded', label: 'Degraded', hint: 'Still working, but slowly or unreliably' },
  { id: 'nominal', label: 'Nominal', hint: 'Ordinary running, with nothing injected and nothing extreme' },
];

const KIND_TAGS: Record<Exclude<ScenarioKind, 'nominal'>, readonly string[]> = {
  baseline: ['base'],
  conformance: ['standards', 'ieee1547'],
  endurance: ['soak', 'long-running', 'scale', 'chaos', 'sweep', 'bulk', 'slow'],
  boundary: ['boundary', 'worst-case', 'transient', 'gap'],
  failure: [
    'failure', 'fault', 'silent-failure', 'silent', 'timeout', 'offline', 'flaky', 'failover',
  ],
  degraded: ['degraded'],
};

/**
 * Areas are not exclusive: a firmware update that drops the network is fairly
 * described as both. Filtering is therefore "has this area", not "is this
 * area".
 */
export const AREAS: ReadonlyArray<FacetDef<ScenarioArea>> = [
  { id: 'grid', label: 'Grid & standards', hint: 'Outages, islanding, IEEE 1547 ride-through and enter-service' },
  { id: 'energy', label: 'Energy & hardware', hint: 'Battery, solar, load, microinverters and the power path' },
  { id: 'buses', label: 'MCU & buses', hint: 'SPI framing, CAN registers and firmware update' },
  { id: 'faults', label: 'Fault handling', hint: 'How device fault codes are raised, cleared and surfaced' },
  { id: 'connectivity', label: 'Connectivity', hint: 'Wi-Fi, cellular, BLE, WebSocket and transport faults' },
  { id: 'cloud', label: 'Cloud API', hint: 'Auth, error codes, payload shape and cloud round trips' },
  { id: 'setup', label: 'Commissioning', hint: 'First-run flows, pairing and site configuration' },
  { id: 'app', label: 'App & locale', hint: 'What the installer app renders: UI state, time zones, translations' },
  { id: 'other', label: 'Unfiled', hint: 'No area tag matched' },
];

const AREA_TAGS: Record<Exclude<ScenarioArea, 'other'>, readonly string[]> = {
  grid: [
    'grid', 'ieee1547', 'standards', 'ride-through', 'enter-service', 'volt-var', 'volt-watt',
    'frequency', 'protection', 'backup', 'generator', 'curtailment', 'export',
  ],
  energy: [
    'battery', 'energy', 'solar', 'weather', 'night', 'load', 'ev', 'flow', 'thermal', 'mi',
    'pcs', 'ct', 'high-value',
  ],
  buses: ['can', 'spi', 'mcu', 'registers', 'firmware', 'raw', 'reset'],
  faults: ['fault', 'silent-failure', 'silent', 'data-integrity'],
  connectivity: [
    'network', 'wifi', 'cellular', 'ethernet', 'ble', 'websocket', 'sse', 'tls', 'transport',
    'discovery', 'failover', 'fallback', 'offline',
  ],
  cloud: ['api', 'cloud', 'auth', 'permissions', 'protocol', 'parsing', 'client'],
  setup: ['commissioning', 'config', 'compatibility'],
  app: ['ui', 'i18n', 'locale', 'time', 'dst', 'timing', 'mode', 'resume'],
};

/**
 * The single kind a scenario belongs to.
 *
 * Anything the table does not claim is nominal: the corpus tags what is
 * unusual, so an untagged scenario is one where nothing unusual happens.
 */
export function kindOf(tags: readonly string[] | undefined): ScenarioKind {
  const set = new Set(tags ?? []);
  for (const { id } of KINDS) {
    if (id === 'nominal') continue;
    if (KIND_TAGS[id].some((t) => set.has(t))) return id;
  }
  return 'nominal';
}

/** Every area a scenario touches, in catalog order. Never empty. */
export function areasOf(tags: readonly string[] | undefined): ScenarioArea[] {
  const set = new Set(tags ?? []);
  const hit = AREAS.filter(({ id }) => id !== 'other' && AREA_TAGS[id].some((t) => set.has(t)));
  return hit.length > 0 ? hit.map((a) => a.id) : ['other'];
}
