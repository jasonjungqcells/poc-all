import type { Clock } from './clock.js';
import type { ControlRegistry } from './controls.js';
import type { Rng } from './rng.js';
import type { Plant } from '../plant/plant.js';
import type { FaultManager } from '../faults/manager.js';
import type { IpcBroker } from '../ipc/broker.js';
import type { VirtualMcu } from '../mcu/virtual-mcu.js';
import type { VirtualCan } from '../can/virtual-can.js';

/** Virtual edge_storage.db. Tables and keys match the real MqttKey enums. */
export interface VirtualDb {
  device_info: Record<string, unknown>;
  system_setting: Record<string, unknown>;
}

export interface FirmwareSession {
  uploadId: string;
  target: string;
  fileName: string;
  totalBytes: number;
  receivedBytes: number;
  chunks: number;
  status: 'registered' | 'transferring' | 'transferred' | 'applying' | 'completed' | 'failed';
  progressPct: number;
  error?: string;
  startedAt: string;
}

export interface MiRecord {
  serialNumber: string;
  model: string;
  powerW: number;
  status: 'online' | 'offline' | 'fault';
}

/**
 * Everything the virtual apps and API layers share.
 *
 * Passed explicitly rather than imported as a singleton so tests can stand up
 * multiple independent rigs in one process.
 */
export interface RigContext {
  controls: ControlRegistry;
  clock: Clock;
  rng: Rng;
  plant: Plant;
  faults: FaultManager;
  ipc: IpcBroker;
  mcu: VirtualMcu;
  can: VirtualCan;
  db: VirtualDb;
  fwSessions: Map<string, FirmwareSession>;
  mi: MiRecord[];
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}
