/**
 * Fault codebook.
 *
 * Codes and levels mirror the existing device error codebook in
 * qcells-cloud-server/service-alarm-repository (CSV shape `model,major,minor,level`)
 * and the display JSON that carries `description` / `howToFix` per persona.
 *
 * Level: W = Warning, A = Alarm, F = Fault.
 * Flag:  1 = raised, 0 = cleared. Every fault must support both -- a simulator
 *        that can only raise faults cannot test recovery UI.
 */

export type FaultLevel = 'W' | 'A' | 'F';
export type FaultBucket = 'ACES' | 'COMMON' | 'MICROINVERTER';

export interface FaultDef {
  code: string;
  device: string;
  level: FaultLevel;
  bucket: FaultBucket;
  description: string;
}

export interface ActiveFault {
  code: string;
  device: string;
  level: FaultLevel;
  flag: 0 | 1;
  raisedAt: string;
  expiresAt?: string;
}

/** EMS codes e001-e035, as enumerated in the device codebook. */
export const EMS_FAULTS: FaultDef[] = [
  ['e001', 'F', 'Rogowski coil disconnected or misinstalled'],
  ['e002', 'F', 'PCS communication disconnected'],
  ['e003', 'A', 'Gateway unreachable'],
  ['e004', 'A', 'Internet connection lost'],
  ['e005', 'W', 'Configuration update failed'],
  ['e006', 'A', 'Firmware update failed'],
  ['e007', 'A', 'Unexpected process crash and reboot'],
  ['e008', 'F', 'Boot failure'],
  ['e009', 'W', 'CPU usage sustained above threshold'],
  ['e010', 'W', 'Memory usage sustained above threshold'],
  ['e011', 'W', 'Storage usage above threshold'],
  ['e012', 'A', 'Enclosure temperature above threshold'],
  ['e013', 'F', 'CAN driver failure'],
  ['e014', 'F', 'Malware detection triggered'],
  ['e015', 'A', 'GEM module failure'],
  ['e016', 'A', 'HUB communication failure'],
  ['e017', 'A', 'WiFi driver failure'],
  ['e018', 'F', 'PCS core error'],
  ['e019', 'W', 'eMMC write limit approaching'],
  ['e020', 'A', 'USB fault detected'],
  ['e021', 'A', 'LTE modem failure'],
  ['e022', 'W', 'NTP time synchronisation failure'],
  ['e023', 'A', 'Meter IC communication failure'],
  ['e024', 'A', 'SPI communication failure with MCU'],
  ['e025', 'F', 'MCU unresponsive'],
  ['e026', 'A', 'Battery communication failure'],
  ['e027', 'W', 'Configuration checksum mismatch'],
  ['e028', 'A', 'Certificate expired or invalid'],
  ['e029', 'W', 'Log partition full'],
  ['e030', 'A', 'Watchdog reset occurred'],
  ['e031', 'W', 'Clock drift beyond tolerance'],
  ['e032', 'A', 'Relay control failure'],
  ['e033', 'F', 'Ground fault detected'],
  ['e034', 'A', 'Arc fault detected'],
  ['e035', 'W', 'Fan failure'],
].map(([code, level, description]) => ({
  code: code as string,
  device: 'ems',
  level: level as FaultLevel,
  bucket: 'COMMON' as FaultBucket,
  description: description as string,
}));

export const INVERTER_FAULTS: FaultDef[] = [
  ['i001', 'F', 'Inverter over-voltage trip'],
  ['i002', 'F', 'Inverter under-voltage trip'],
  ['i003', 'F', 'Inverter over-frequency trip'],
  ['i004', 'F', 'Inverter under-frequency trip'],
  ['i005', 'A', 'Inverter over-temperature derate'],
  ['i006', 'F', 'Anti-islanding protection tripped'],
  ['i007', 'A', 'Inverter output current imbalance'],
  ['i008', 'F', 'DC bus over-voltage'],
].map(toDef('inverter', 'ACES'));

export const BATTERY_FAULTS: FaultDef[] = [
  ['b001', 'F', 'BMS communication lost'],
  ['b002', 'A', 'Cell voltage imbalance'],
  ['b003', 'F', 'Battery over-temperature'],
  ['b004', 'A', 'Battery under-temperature, charge inhibited'],
  ['b005', 'A', 'State of health below threshold'],
  ['b006', 'F', 'Battery over-current'],
  ['b007', 'A', 'Battery contactor failure'],
].map(toDef('battery-qhome-smart', 'ACES'));

export const GRID_FAULTS: FaultDef[] = [
  ['g001', 'A', 'Grid voltage out of range'],
  ['g002', 'A', 'Grid frequency out of range'],
  ['g003', 'F', 'Grid outage detected'],
  ['g004', 'W', 'Grid reconnect delay in progress'],
].map(toDef('grid', 'COMMON'));

export const MI_FAULTS: FaultDef[] = [
  ['m001', 'A', 'Microinverter offline'],
  ['m002', 'A', 'Microinverter over-temperature'],
  ['m003', 'W', 'Microinverter producing below expectation'],
  ['m004', 'F', 'Microinverter DC input fault'],
  ['m005', 'W', 'Microinverter firmware mismatch'],
].map(toDef('micro-inverter', 'MICROINVERTER'));

export const HUB_FAULTS: FaultDef[] = [
  ['h001', 'A', 'Hub offline'],
  ['h002', 'W', 'Hub firmware mismatch'],
  ['h003', 'A', 'Hub relay failure'],
].map(toDef('hub', 'COMMON'));

export const ALL_FAULTS: FaultDef[] = [
  ...EMS_FAULTS,
  ...INVERTER_FAULTS,
  ...BATTERY_FAULTS,
  ...GRID_FAULTS,
  ...MI_FAULTS,
  ...HUB_FAULTS,
];

const BY_CODE = new Map(ALL_FAULTS.map((f) => [f.code, f]));

export function lookupFault(code: string): FaultDef | undefined {
  return BY_CODE.get(code);
}

export function faultsInBucket(bucket: FaultBucket): FaultDef[] {
  return ALL_FAULTS.filter((f) => f.bucket === bucket);
}

/** Every code belonging to one device family, or the whole codebook for `all`. */
export function faultsForDevice(device: string, level: string = 'all'): FaultDef[] {
  return ALL_FAULTS.filter(
    (f) => (device === 'all' || f.device === device) && (level === 'all' || f.level === level),
  );
}

/**
 * Cloud response error codes.
 *
 * Mirrors nextgen-schemas/async-api/response-error-codes. The 460X device-state
 * family is the one mobile clients most often mishandle.
 */
export const CLOUD_ERROR_CODES: Record<number, string> = {
  4001: 'Unauthorized',
  4002: 'Token expired',
  4003: 'Invalid credentials',
  4004: 'Forbidden',
  4010: 'Validation failed',
  4011: 'Missing required field',
  4012: 'Invalid field format',
  4040: 'Resource not found',
  4041: 'Site not found',
  4042: 'Device not found',
  4090: 'Conflict: resource already exists',
  4091: 'Concurrent modification',
  4290: 'Rate limit exceeded',
  4600: 'Device offline',
  4601: 'Device in maintenance mode',
  4602: 'Device firmware version unsupported',
  4603: 'Device configuration invalid',
  4604: 'Device not ready',
  5000: 'Internal server error',
  5001: 'Downstream service unavailable',
  5030: 'Service temporarily unavailable',
  5200: 'Network error',
  5201: 'Upstream timeout',
};

function toDef(device: string, bucket: FaultBucket) {
  return ([code, level, description]: string[]): FaultDef => ({
    code: code as string,
    device,
    level: level as FaultLevel,
    bucket,
    description: description as string,
  });
}
