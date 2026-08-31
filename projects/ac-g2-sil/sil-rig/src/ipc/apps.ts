import type { RigContext } from '../core/context.js';
import type { IpcEnvelope } from './broker.js';
import { SpiError } from '../mcu/virtual-mcu.js';
import { ALL_FAULTS } from '../faults/codebook.js';
import { toDisplayKw } from '../plant/plant.js';

/**
 * The seven virtual UniEP apps and their 23 services.
 *
 * Targets and service names are taken verbatim from the installer app's
 * MqttTarget / MqttService enums, so `POST /publish/{target}/{service}` from a
 * real app routes here without translation.
 */

export const MQTT_TARGETS = [
  'db_manager',
  'device_manager',
  'sys_manager',
  'energy_dispatcher',
  'realtime_monitor',
  'energy_link',
  'edge_runtime',
] as const;

export type MqttTarget = (typeof MQTT_TARGETS)[number];

export const SERVICES_BY_TARGET: Record<MqttTarget, string[]> = {
  db_manager: ['select_records', 'update_records'],
  device_manager: [
    'mi_scan_start_stop',
    'mi_scan_realtime_data',
    'mi_multi_add',
    'mi_multi_delete',
    'mi_get_monitoring_data',
    'mi_reconnection_time_short',
    'reboot_hub',
  ],
  sys_manager: [
    'scan_wifi',
    'set_wifi_connect',
    'set_wifi_disconnect',
    'set_ethernet_config',
    'set_cellular_activate',
    'set_cellular_deactivate',
    'set_timezone',
    'set_configuration_json',
    'get_configuration_json',
    'get_system_info',
  ],
  energy_dispatcher: ['get_energy_settings', 'update_energy_settings'],
  realtime_monitor: ['get_realtime_monitoring_data'],
  energy_link: ['send_read_metric', 'send_write_metric', 'send_read_register_addr'],
  edge_runtime: ['request_system_reboot'],
};

const ctxOf = (p: IpcEnvelope): Record<string, unknown> =>
  (p?.context && typeof p.context === 'object' ? (p.context as Record<string, unknown>) : {});

export function registerApps(ctx: RigContext): void {
  registerDbManager(ctx);
  registerSysManager(ctx);
  registerDeviceManager(ctx);
  registerEnergyDispatcher(ctx);
  registerRealtimeMonitor(ctx);
  registerEnergyLink(ctx);
  registerEdgeRuntime(ctx);
  seedNotifications(ctx);
}

/**
 * The board always has current network state cached, so `GET /notifications/*`
 * must answer before any client has published a request. Seed at boot and
 * refresh whenever a `net.*` control moves, which is also what makes a scenario
 * timeline that flips connectivity visible on the notification surface.
 */
function seedNotifications(ctx: RigContext): void {
  const { ipc, controls } = ctx;

  const publish = (): void => {
    ipc.notify('sys_manager', 'network_info', networkInfo(ctx));
    ipc.notify('sys_manager', 'wifi_status', {
      connected: controls.str('net.wifi.state') === 'connected',
      ssid: controls.str('net.wifi.ssid'),
      rssi: controls.num('net.wifi.rssi_dbm'),
    });
    ipc.notify('sys_manager', 'ethernet_status', {
      connected: controls.str('net.ethernet.state') === 'connected',
      state: controls.str('net.ethernet.state'),
    });
  };

  publish();
  controls.on('change', (change: { id: string }) => {
    if (change.id.startsWith('net.')) publish();
  });
}

/**
 * Deterministic synthetic fault history.
 *
 * Rows walk backwards from now at one-hour intervals and cycle the codebook, so
 * the same count and seed always produce the same list.
 */
function buildFaultHistory(ctx: RigContext, count: number): Record<string, unknown>[] {
  const now = ctx.clock.now().getTime();
  const rows: Record<string, unknown>[] = [];
  for (let idx = 0; idx < count; idx += 1) {
    const def = ALL_FAULTS[idx % ALL_FAULTS.length];
    if (!def) break;
    const raised = new Date(now - (idx + 1) * 3_600_000);
    rows.push({
      code: def.code,
      device: def.device,
      level: def.level,
      description: def.description,
      raisedAt: raised.toISOString(),
      clearedAt: new Date(raised.getTime() + 900_000).toISOString(),
      flag: 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- db_manager

function registerDbManager(ctx: RigContext): void {
  const { ipc, db, controls } = ctx;

  ipc.handle('db_manager', 'select_records', (payload) => {
    const c = ctxOf(payload);
    const table = String(c.table ?? 'device_info') as keyof typeof db;
    const keys = Array.isArray(c.keys) ? (c.keys as string[]) : undefined;
    const source = db[table] ?? {};

    // Control overrides shadow stored rows so a scenario can force any key
    // without having to replay the write that would normally set it.
    const resolve = (key: string): unknown => {
      const overrideId = `db.${table}.${key}`;
      const override = controls.has(overrideId) ? controls.get(overrideId) : null;
      return override ?? source[key] ?? null;
    };

    const records = keys
      ? Object.fromEntries(keys.map((k) => [k, resolve(k)]))
      : Object.fromEntries(Object.keys(source).map((k) => [k, resolve(k)]));

    // fault_history is the one key clients read as a list rather than a scalar,
    // and the one that grows without bound on a real device. Synthesising it
    // here is how the UI gets exercised against a realistic row count.
    const historyCount = controls.num('db.fault_history_count');
    if (historyCount > 0 && (!keys || keys.includes('fault_history'))) {
      records.fault_history = buildFaultHistory(ctx, historyCount);
    }

    return { table, records };
  });

  ipc.handle('db_manager', 'update_records', (payload) => {
    const c = ctxOf(payload);
    const table = String(c.table ?? 'device_info') as keyof typeof db;
    const records = (c.records ?? {}) as Record<string, unknown>;
    Object.assign(db[table], records);
    return { table, updated: Object.keys(records) };
  });
}

// --------------------------------------------------------------- sys_manager

function registerSysManager(ctx: RigContext): void {
  const { ipc, controls, rng, clock } = ctx;
  const scanRng = rng.derive('wifi_scan');

  ipc.handle('sys_manager', 'scan_wifi', async () => {
    const count = controls.num('net.wifi.scan_count');
    const delayMs = controls.num('net.wifi.scan_delay_ms');

    const results = Array.from({ length: count }, (_, idx) => ({
      ssid: idx === 0 ? controls.str('net.wifi.ssid') : `SIM-AP-${idx}`,
      bssid: `02:00:00:00:${(idx >> 8).toString(16).padStart(2, '0')}:${(idx & 0xff).toString(16).padStart(2, '0')}`,
      rssi: scanRng.int(-90, -35),
      security: scanRng.chance(80) ? 'WPA2' : 'OPEN',
      frequency: scanRng.chance(50) ? 2437 : 5180,
    }));

    // `not_found` removes the target SSID rather than failing the scan --
    // the app must handle "scan succeeded but my network is missing".
    const filtered =
      controls.str('net.wifi.connect_fail_reason') === 'not_found'
        ? results.filter((r) => r.ssid !== controls.str('net.wifi.ssid'))
        : results;

    ipc.notify('sys_manager', 'wifi_scan_result', { results: filtered, scannedAt: clock.nowIso() });
    return { count: filtered.length, results: filtered, durationMs: delayMs };
  });

  ipc.handle('sys_manager', 'set_wifi_connect', (payload) => {
    const c = ctxOf(payload);
    const ssid = String(c.ssid ?? controls.str('net.wifi.ssid'));
    const reason = controls.str('net.wifi.connect_fail_reason');

    if (reason !== 'none') {
      controls.set('net.wifi.state', 'failed');
      ipc.notify('sys_manager', 'wifi_status', { connected: false, ssid, reason });
      return { success: false, ssid, reason };
    }

    controls.set('net.wifi.ssid', ssid);
    controls.set('net.wifi.state', 'connected');
    controls.set('net.type', 1);
    ipc.notify('sys_manager', 'wifi_status', {
      connected: true,
      ssid,
      rssi: controls.num('net.wifi.rssi_dbm'),
    });
    ipc.notify('sys_manager', 'network_info', networkInfo(ctx));
    return { success: true, ssid, ipAddress: '192.168.1.42' };
  });

  ipc.handle('sys_manager', 'set_wifi_disconnect', () => {
    controls.set('net.wifi.state', 'disconnected');
    controls.set('net.type', 0);
    ipc.notify('sys_manager', 'wifi_status', { connected: false });
    return { success: true };
  });

  ipc.handle('sys_manager', 'set_ethernet_config', (payload) => {
    const c = ctxOf(payload);
    const state = controls.str('net.ethernet.state');
    if (state === 'no_link') {
      ipc.notify('sys_manager', 'ethernet_status', { connected: false, reason: 'no_link' });
      return { success: false, reason: 'no_link' };
    }
    controls.set('net.ethernet.state', 'up');
    controls.set('net.type', 2);
    ipc.notify('sys_manager', 'ethernet_status', { connected: true, mode: c.dhcp === false ? 'static' : 'dhcp' });
    ipc.notify('sys_manager', 'network_info', networkInfo(ctx));
    return { success: true };
  });

  ipc.handle('sys_manager', 'set_cellular_activate', () => {
    if (controls.str('net.cellular.state') === 'failed') {
      return { success: false, reason: 'activation_rejected' };
    }
    controls.set('net.cellular.state', 'active');
    controls.set('net.type', 3);
    ipc.notify('sys_manager', 'network_info', networkInfo(ctx));
    return { success: true };
  });

  ipc.handle('sys_manager', 'set_cellular_deactivate', () => {
    controls.set('net.cellular.state', 'inactive');
    return { success: true };
  });

  ipc.handle('sys_manager', 'set_timezone', (payload) => {
    const c = ctxOf(payload);
    const tz = String(c.timezone ?? c.timezoneId ?? 'UTC');
    controls.set('sim.timezone', tz);
    controls.set('site.timezone_id', tz);
    return { success: true, timezone: tz };
  });

  ipc.handle('sys_manager', 'set_configuration_json', (payload) => {
    const c = ctxOf(payload);
    if (controls.bool('db.config_invalid')) {
      return { success: false, error: 'invalid_configuration', code: 4603 };
    }
    ctx.db.system_setting.configuration_json = c;
    controls.set('site.commissioning_status', 'IN_PROGRESS');
    return { success: true, version: String(ctx.db.system_setting.configuration_version ?? '1') };
  });

  ipc.handle('sys_manager', 'get_configuration_json', () => ({
    version: String(ctx.db.system_setting.configuration_version ?? '1'),
    lastModifiedBy: 'sil-rig',
    lastModifiedAt: clock.nowIso(),
    siteName: stressString(ctx, controls.str('site.name'), 64),
    deviceList: buildDeviceList(ctx),
    commonTelemetryVer: '1.0',
    configuration: ctx.db.system_setting.configuration_json ?? {},
  }));

  ipc.handle('sys_manager', 'get_system_info', () => ({
    siteName: stressString(ctx, controls.str('site.name'), 64),
    locale: controls.str('sim.locale'),
    serialNumber: controls.str('site.serial_number'),
    mpuVersion: String(ctx.db.device_info.mpu_version ?? '0.3.86'),
    mcuVersion: controls.str('mcu.fw_version'),
    uptimeMs: ctx.mcu.uptimeMs(),
    timezone: controls.str('sim.timezone'),
    emsType: controls.str('site.ems_type'),
    commissioningStatus: controls.str('site.commissioning_status'),
  }));
}

/**
 * Layout-stress a user-visible string.
 *
 * Real deployments carry names that are longer, and scripts that are wider,
 * than anything a developer types in by hand. Padding to the declared maximum
 * and injecting non-Latin text are the two cheapest ways to find truncation and
 * bidi defects before a customer does.
 */
export function stressString(ctx: RigContext, value: string, maxLength: number): string {
  const { controls } = ctx;
  let out = value;
  if (controls.bool('sim.unicode_strings')) {
    out = `${out} \u{1F50B}\u26A1 \uD55C\uAD6D\uC5B4 \u0627\u0644\u0639\u0631\u0628\u064A\u0629 e\u0301`;
  }
  if (controls.bool('sim.max_length_strings') && out.length < maxLength) {
    out = out.padEnd(maxLength, '\u2026');
  }
  return out.slice(0, maxLength);
}

function networkInfo(ctx: RigContext): Record<string, unknown> {
  const { controls } = ctx;
  return {
    networkType: Number(controls.get('net.type')),
    wifi: {
      state: controls.str('net.wifi.state'),
      ssid: controls.str('net.wifi.ssid'),
      rssi: controls.num('net.wifi.rssi_dbm'),
    },
    ethernet: { state: controls.str('net.ethernet.state') },
    cellular: { state: controls.str('net.cellular.state') },
    cloudReachable: controls.bool('net.cloud.reachable'),
  };
}

// ------------------------------------------------------------ device_manager

function registerDeviceManager(ctx: RigContext): void {
  const { ipc, controls, rng, clock } = ctx;
  const miRng = rng.derive('mi_scan');
  let scanning = false;

  const buildMi = (index: number) => {
    const serial = controls.bool('mi.duplicate_serials') && index > 0
      ? 'MI0000000000'
      : `MI${String(index + 1).padStart(10, '0')}`;
    return {
      serialNumber: serial,
      model: 'Q.PEAK-MI-400',
      powerW: 0,
      status: 'online' as const,
    };
  };

  ipc.handle('device_manager', 'mi_scan_start_stop', (payload) => {
    const c = ctxOf(payload);
    const start = c.start !== false && c.command !== 'stop';

    if (!start) {
      scanning = false;
      return { scanning: false, found: ctx.mi.length };
    }
    if (controls.bool('mi.scan.fail')) {
      return { scanning: false, found: 0, error: 'scan_failed' };
    }

    scanning = true;
    ctx.mi.length = 0;

    const expected = controls.num('mi.scan.discover_count');
    const partialPct = controls.num('mi.scan.partial_pct');
    const actual = Math.floor((expected * partialPct) / 100);
    for (let idx = 0; idx < actual; idx++) ctx.mi.push(buildMi(idx));

    // Offline/fault counts are applied deterministically from the head of the
    // list so a scenario asserting "3 offline" always sees the same three.
    const offline = controls.num('mi.offline_count');
    const faulted = controls.num('mi.fault_count');
    ctx.mi.forEach((mi, idx) => {
      if (idx < offline) mi.status = 'offline';
      else if (idx < offline + faulted) mi.status = 'fault';
      else mi.powerW = Math.round(miRng.float(150, 400));
    });

    ipc.notify('device_manager', 'mi_scan_progress', {
      scanning: true,
      found: ctx.mi.length,
      expected,
      startedAt: clock.nowIso(),
    });

    return {
      scanning: true,
      expected,
      found: ctx.mi.length,
      durationS: controls.num('mi.scan.duration_s'),
    };
  });

  ipc.handle('device_manager', 'mi_scan_realtime_data', () => ({
    scanning,
    found: ctx.mi.length,
    devices: ctx.mi,
  }));

  ipc.handle('device_manager', 'mi_multi_add', (payload) => {
    const c = ctxOf(payload);
    const serials = Array.isArray(c.serialNumbers) ? (c.serialNumbers as string[]) : [];
    for (const serialNumber of serials) {
      if (ctx.mi.some((m) => m.serialNumber === serialNumber)) continue;
      ctx.mi.push({ serialNumber, model: 'Q.PEAK-MI-400', powerW: 0, status: 'online' });
    }
    return { added: serials.length, total: ctx.mi.length };
  });

  ipc.handle('device_manager', 'mi_multi_delete', (payload) => {
    const c = ctxOf(payload);
    const serials = new Set(Array.isArray(c.serialNumbers) ? (c.serialNumbers as string[]) : []);
    const before = ctx.mi.length;
    for (let idx = ctx.mi.length - 1; idx >= 0; idx--) {
      if (serials.has(ctx.mi[idx]!.serialNumber)) ctx.mi.splice(idx, 1);
    }
    return { deleted: before - ctx.mi.length, total: ctx.mi.length };
  });

  ipc.handle('device_manager', 'mi_get_monitoring_data', () => {
    const total = ctx.mi.reduce((sum, m) => sum + m.powerW, 0);
    return {
      timestamp: clock.nowIso(),
      totalPowerW: total,
      devices: ctx.mi.map((m) => ({ ...m })),
    };
  });

  ipc.handle('device_manager', 'mi_reconnection_time_short', () => {
    const short = controls.bool('mi.reconnect_short');
    return { success: true, reconnectionTimeS: short ? 5 : 300, short };
  });

  ipc.handle('device_manager', 'reboot_hub', () => ({ success: true, rebootingS: 20 }));
}

// -------------------------------------------------------- energy_dispatcher

function registerEnergyDispatcher(ctx: RigContext): void {
  const { ipc, controls } = ctx;

  ipc.handle('energy_dispatcher', 'get_energy_settings', () => ({
    energyControl: Number(controls.get('plant.energy_control')),
    systemTargetPowerW: controls.num('plant.grid.export_limit_w'),
    batteryTargetPowerW: 0,
    minSocPct: controls.num('plant.battery.min_soc_pct'),
    inverterMaxOutputW: controls.num('plant.inverter.max_output_w'),
    gridTargetFrequencyHz: controls.num('plant.grid.frequency_hz'),
    exportLimitW: controls.num('plant.grid.export_limit_w'),
  }));

  ipc.handle('energy_dispatcher', 'update_energy_settings', (payload) => {
    const c = ctxOf(payload);
    const applied: string[] = [];
    const map: Array<[string, string]> = [
      ['energyControl', 'plant.energy_control'],
      ['minSocPct', 'plant.battery.min_soc_pct'],
      ['inverterMaxOutputW', 'plant.inverter.max_output_w'],
      ['gridTargetFrequencyHz', 'plant.grid.frequency_hz'],
      ['exportLimitW', 'plant.grid.export_limit_w'],
    ];
    for (const [field, controlId] of map) {
      if (c[field] === undefined) continue;
      controls.set(controlId, c[field]);
      applied.push(field);
    }
    return { success: true, applied };
  });
}

// --------------------------------------------------------- realtime_monitor

function registerRealtimeMonitor(ctx: RigContext): void {
  const { ipc } = ctx;
  ipc.handle('realtime_monitor', 'get_realtime_monitoring_data', () => buildTelemetry(ctx));
}

/**
 * Realtime telemetry payload.
 *
 * Point names, signs and units are contractual and shared with the mobile apps
 * and the Vue HEMS: grid > 0 imports, battery > 0 discharges, and pv is the sum
 * of pv + extpv taken before unit conversion.
 */
export function buildTelemetry(ctx: RigContext): Record<string, unknown> {
  const s = ctx.plant.snapshot();
  return {
    eventTime: ctx.clock.nowIso(),
    points: {
      pv_200_W: s.pvW,
      extpv_200_W: s.extPvW,
      grid_200_W: s.gridW,
      load_200_W: s.loadW,
      battery_200_W: s.batteryW,
      battery_713_SoC: s.socPct,
      battery_713_SoH: s.sohPct,
      Grid_Status: s.gridStatus,
      energyControl: s.energyControl,
      networkType: Number(ctx.controls.get('net.type')),
    },
    // Deadbanded kW values, so any client that renders straight from the rig
    // agrees with the fleet without re-deriving the conversion order.
    display: {
      pvKw: toDisplayKw(s.totalPvW),
      loadKw: toDisplayKw(s.loadW),
      gridKw: toDisplayKw(s.gridW),
      batteryKw: toDisplayKw(s.batteryW),
    },
    faults: ctx.faults.list(),
  };
}

// ---------------------------------------------------------------- energy_link

/**
 * energy_link is where Seam D meets Seam A: these two services are the bridge
 * from the app-facing local API down across SPI into the register model.
 */
function registerEnergyLink(ctx: RigContext): void {
  const { ipc, mcu } = ctx;

  ipc.handle('energy_link', 'send_read_metric', (payload) => {
    const c = ctxOf(payload);
    const register = String(c.register ?? c.registerAddress ?? '');
    const metric = c.metric ? String(c.metric) : undefined;
    try {
      const read = mcu.readRegister(register);
      return metric
        ? { register: read.register, metric, value: read.metrics[metric] ?? null, timestamp: read.timestamp }
        : read;
    } catch (err) {
      return spiFailure(err);
    }
  });

  ipc.handle('energy_link', 'send_write_metric', (payload) => {
    const c = ctxOf(payload);
    const register = String(c.register ?? c.registerAddress ?? '');
    const values = (c.values ?? (c.metric ? { [String(c.metric)]: c.value } : {})) as Record<string, number>;
    try {
      return { success: true, ...mcu.writeRegister(register, values) };
    } catch (err) {
      return spiFailure(err);
    }
  });

  ipc.handle('energy_link', 'send_read_register_addr', (payload) => {
    const c = ctxOf(payload);
    const addr = String(c.address ?? c.registerAddress ?? '');
    try {
      return mcu.readRegister(addr);
    } catch (err) {
      return spiFailure(err);
    }
  });
}

function spiFailure(err: unknown): Record<string, unknown> {
  if (err instanceof SpiError) {
    return { success: false, error: err.kind, message: err.message };
  }
  return { success: false, error: 'unknown', message: String(err) };
}

// ---------------------------------------------------------------- edge_runtime

function registerEdgeRuntime(ctx: RigContext): void {
  const { ipc, controls, mcu } = ctx;

  ipc.handle('edge_runtime', 'request_system_reboot', () => {
    mcu.reboot();
    controls.set('net.wifi.state', 'connecting');
    ipc.notify('edge_runtime', 'system_status', { rebooting: true });
    return { success: true, rebootingS: controls.num('fw.post_update_reboot_s') };
  });
}

function buildDeviceList(ctx: RigContext): Array<Record<string, unknown>> {
  const { controls } = ctx;
  const devices: Array<Record<string, unknown>> = [
    {
      deviceType: 'ems',
      serialNumber: controls.str('site.serial_number'),
      model: 'EMS-PLUS-GEN2',
    },
  ];
  for (let idx = 0; idx < controls.num('site.inverter_count'); idx++) {
    devices.push({ deviceType: 'inverter', serialNumber: `INV${String(idx + 1).padStart(9, '0')}`, model: 'Q.VOLT-7.6' });
  }
  for (let idx = 0; idx < controls.num('site.battery_count'); idx++) {
    devices.push({ deviceType: 'battery', serialNumber: `BAT${String(idx + 1).padStart(9, '0')}`, model: 'Q.HOME-SMART' });
  }
  for (let idx = 0; idx < controls.num('site.hub_count'); idx++) {
    devices.push({ deviceType: 'hub', serialNumber: `HUB${String(idx + 1).padStart(9, '0')}`, model: 'Q.HUB' });
  }
  for (const mi of ctx.mi) {
    devices.push({ deviceType: 'micro-inverter', serialNumber: mi.serialNumber, model: mi.model });
  }
  return devices;
}
