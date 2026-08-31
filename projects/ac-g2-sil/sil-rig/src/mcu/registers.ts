import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Register model, loaded from the real factory_register_map.json.
 *
 * The virtual MCU is a code-generation problem rather than a reverse-engineering
 * one: 523 SPI registers / 4,411 metrics are already described machine-readably,
 * complete with dataType, scaleFactor, unit and min/max. Loading that file
 * directly means the simulator cannot drift from the fleet's contract, and
 * min/max give boundary-value fault injection for every metric for free.
 */

export interface MetricProfile {
  dataType: string;
  unit?: string;
  scaleFactor?: number;
  defaultValue?: number | string | boolean;
  minValue?: number;
  maxValue?: number;
  stringLength?: number;
}

export interface MetricDef {
  id: string;
  offset: number;
  metricProfile: MetricProfile;
}

export interface RegisterDef {
  id: string;
  registerAddress: string;
  registerSize: number;
  metrics: MetricDef[];
  /** Group this register belongs to, e.g. `read` (the 1 Hz cyclic loop). */
  groupId: string;
  periodMs: number;
}

export interface RegisterMapModel {
  version?: string;
  protocolVersion?: Record<string, unknown>;
  registers: Map<string, RegisterDef>;
  byName: Map<string, RegisterDef>;
  /** Registers with periodMs > 0 -- the real-time data path. */
  cyclic: RegisterDef[];
  stats: {
    registerCount: number;
    metricCount: number;
    cyclicCount: number;
    groups: Array<{ id: string; periodMs: number; registers: number }>;
  };
}

const DEFAULT_LOOKUP_PATHS = [
  '../qcells-cloud-server-nextgen-schemas/factory_json/ac_system_gen2/factory_register_map.json',
  '../../qcells-cloud-server-nextgen-schemas/factory_json/ac_system_gen2/factory_register_map.json',
];

export function findRegisterMap(explicit?: string): string | undefined {
  const candidates = explicit ? [explicit] : DEFAULT_LOOKUP_PATHS;
  for (const c of candidates) {
    const p = resolve(process.cwd(), c);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Load the SPI register map. Falls back to a small built-in model when the
 * factory file is absent so the rig still boots on a machine that does not have
 * the schemas repo checked out.
 */
export function loadRegisterMap(path?: string, deviceId = 'qcells_mcu'): RegisterMapModel {
  const found = findRegisterMap(path);
  if (!found) return fallbackModel();

  const doc = JSON.parse(readFileSync(found, 'utf8')) as {
    version?: string;
    protocolVersion?: Record<string, unknown>;
    registerMaps: Array<{ id: string; protocol: string; registerGroups: RawGroup[] }>;
  };

  const map = doc.registerMaps.find((m) => m.id === deviceId);
  if (!map) return fallbackModel();

  const registers = new Map<string, RegisterDef>();
  const byName = new Map<string, RegisterDef>();
  const cyclic: RegisterDef[] = [];
  const groups: RegisterMapModel['stats']['groups'] = [];
  let metricCount = 0;

  for (const group of map.registerGroups) {
    // The g4 CAN map omits periodMs entirely; treat that as acyclic.
    const periodMs = group.periodMs ?? 0;
    groups.push({ id: group.id, periodMs, registers: group.registers.length });
    for (const raw of group.registers) {
      const def: RegisterDef = {
        id: raw.id,
        registerAddress: normaliseAddr(raw.registerAddress),
        registerSize: raw.registerSize,
        metrics: raw.metrics ?? [],
        groupId: group.id,
        periodMs,
      };
      metricCount += def.metrics.length;
      // onDemandRead and onDemandReadWrite can share an address; first wins so
      // the cyclic definition is never shadowed by a later duplicate.
      if (!registers.has(def.registerAddress)) registers.set(def.registerAddress, def);
      byName.set(def.id, def);
      if (periodMs > 0) cyclic.push(def);
    }
  }

  return {
    version: doc.version,
    protocolVersion: doc.protocolVersion,
    registers,
    byName,
    cyclic,
    stats: {
      registerCount: registers.size,
      metricCount,
      cyclicCount: cyclic.length,
      groups,
    },
  };
}

interface RawGroup {
  id: string;
  periodMs: number;
  registers: Array<{
    id: string;
    registerAddress: string;
    registerSize: number;
    metrics: MetricDef[];
  }>;
}

function normaliseAddr(addr: string | number): string {
  const n = typeof addr === 'number' ? addr : Number.parseInt(String(addr), 16);
  return `0x${n.toString(16).toUpperCase()}`;
}

/** Numeric bounds implied by a dataType, used when the profile omits min/max. */
export function typeBounds(dataType: string): { min: number; max: number } {
  switch (dataType) {
    case 'uint8': return { min: 0, max: 0xff };
    case 'uint16': return { min: 0, max: 0xffff };
    case 'uint32': return { min: 0, max: 0xffffffff };
    case 'int16': return { min: -32768, max: 32767 };
    case 'int32': return { min: -2147483648, max: 2147483647 };
    case 'int64': return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
    case 'boolean': return { min: 0, max: 1 };
    default: return { min: 0, max: 0 };
  }
}

export function metricBounds(metric: MetricDef): { min: number; max: number } {
  const p = metric.metricProfile;
  const t = typeBounds(p.dataType);
  return {
    min: p.minValue ?? t.min,
    max: p.maxValue ?? t.max,
  };
}

/** Minimal stand-in so the rig boots without the schemas repo present. */
function fallbackModel(): RegisterMapModel {
  const registers = new Map<string, RegisterDef>();
  const def: RegisterDef = {
    id: 'PMU_Monitoring_Data_01',
    registerAddress: '0x8224',
    registerSize: 64,
    groupId: 'read',
    periodMs: 1000,
    metrics: [
      { id: 'PV_Active_Power', offset: 0, metricProfile: { dataType: 'int32', unit: 'W', scaleFactor: 0.01 } },
      { id: 'Battery_Active_Power', offset: 4, metricProfile: { dataType: 'int32', unit: 'W', scaleFactor: 0.01 } },
      { id: 'Grid_Active_Power', offset: 8, metricProfile: { dataType: 'int32', unit: 'W', scaleFactor: 0.01 } },
      { id: 'Battery_SoC', offset: 12, metricProfile: { dataType: 'uint16', unit: '%', scaleFactor: 0.1, minValue: 0, maxValue: 100 } },
    ],
  };
  registers.set(def.registerAddress, def);
  return {
    registers,
    byName: new Map([[def.id, def]]),
    cyclic: [def],
    stats: {
      registerCount: 1,
      metricCount: def.metrics.length,
      cyclicCount: 1,
      groups: [{ id: 'read', periodMs: 1000, registers: 1 }],
    },
  };
}
