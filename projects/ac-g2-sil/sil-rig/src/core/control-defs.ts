import type { ControlDef } from './controls.js';

const n = (
  id: string,
  group: string,
  description: string,
  def: number,
  extra: Partial<ControlDef> = {},
): ControlDef => ({ id, group, type: 'number', description, default: def, ...extra });

const i = (
  id: string,
  group: string,
  description: string,
  def: number,
  extra: Partial<ControlDef> = {},
): ControlDef => ({ id, group, type: 'integer', description, default: def, ...extra });

const b = (id: string, group: string, description: string, def: boolean): ControlDef => ({
  id,
  group,
  type: 'boolean',
  description,
  default: def,
});

const e = (
  id: string,
  group: string,
  description: string,
  values: readonly (string | number)[],
  def: string | number,
): ControlDef => ({ id, group, type: 'enum', description, values, default: def });

const s = (id: string, group: string, description: string, def: string): ControlDef => ({
  id,
  group,
  type: 'string',
  description,
  default: def,
});

const j = (id: string, group: string, description: string, def: unknown): ControlDef => ({
  id,
  group,
  type: 'json',
  description,
  default: def,
});

const act = (id: string, group: string, description: string): ControlDef => ({
  id,
  group,
  type: 'action',
  description,
});

/** Route slugs used by `api.route.{route}.*` fault injection. */
export const API_ROUTES = [
  'version',
  'auth_token',
  'publish',
  'notifications',
  'telemetry',
  'update_register',
  'update_chunk',
  'update_sessions',
  'update_finalize',
  'factory_reset',
  'serial_number',
] as const;

export const CONTROL_DEFS: ControlDef[] = [
  // ---------------------------------------------------------------- sim.*
  i('sim.seed', 'sim', 'RNG seed. Same seed and scenario produce an identical run.', 1),
  e('sim.clock.mode', 'sim', 'Virtual time or host wall-clock time.', ['virtual', 'wall'], 'virtual'),
  n('sim.clock.rate', 'sim', 'Virtual seconds per real second. 0 pauses; 60 is 1 min/s.', 1, {
    min: 0,
    max: 3600,
  }),
  s('sim.clock.now', 'sim', 'Absolute virtual time (ISO-8601). Writing jumps the clock.', ''),
  act('sim.clock.step', 'sim', 'Advance virtual time by a duration and settle.'),
  i('sim.tick_ms', 'sim', 'Plant integration step in milliseconds.', 1000, { min: 10, max: 60_000 }),
  s('sim.timezone', 'sim', 'IANA timezone. Factory default is Asia/Seoul; US sites are not.', 'America/Los_Angeles'),
  b('sim.autoplay', 'sim', 'Start ticking as soon as the rig boots.', true),
  b('sim.strict', 'sim', 'Abort the run on the first failed expectation or contract violation.', false),
  s('sim.locale', 'sim', 'Locale the client is assumed to run under. Device formatting stays Locale.US regardless, which is the point.', 'en-US'),
  i('sim.clock_skew_s', 'sim', 'Offset between device clock and real time. Positive means the device runs ahead.', 0, {
    unit: 's',
    min: -86_400,
    max: 86_400,
  }),
  i('sim.boot_delay_s', 'sim', 'Seconds after start during which the device reports not-ready.', 0, { unit: 's', min: 0, max: 600 }),
  b('sim.max_length_strings', 'sim', 'Pad every user-visible string to its maximum declared length.', false),
  b('sim.unicode_strings', 'sim', 'Use emoji, RTL and combining characters in user-visible strings.', false),

  // --------------------------------------------------------------- site.*
  e(
    'site.ems_type',
    'site',
    'EMS product type. Drives which telemetry generators and dashboards apply.',
    ['ACCB_GEN2', 'ESS_GEN4', 'STANDALONE', 'BACKUP_PRIMARY', 'BACKUP_STANDALONE'],
    'ACCB_GEN2',
  ),
  s('site.serial_number', 'site', 'EMS product serial number.', 'EMS2SIM00000001'),
  s('site.name', 'site', 'Site display name.', 'SIL Simulated Site'),
  s('site.timezone_id', 'site', 'Site timezone as recorded at commissioning.', 'America/Los_Angeles'),
  n('site.address.latitude', 'site', 'Site latitude.', 33.7756, { min: -90, max: 90 }),
  n('site.address.longitude', 'site', 'Site longitude.', -84.3963, { min: -180, max: 180 }),
  s('site.address.city', 'site', 'Site city.', 'Atlanta'),
  s('site.address.state', 'site', 'Site state or province.', 'GA'),
  s('site.address.postal_code', 'site', 'Site postal code.', '30332'),
  s('site.address.country', 'site', 'Site country.', 'US'),
  i('site.inverter_count', 'site', 'Installed inverters.', 1, { min: 0, max: 4 }),
  i('site.battery_count', 'site', 'Installed batteries.', 1, { min: 0, max: 4 }),
  i('site.expansion_battery_count', 'site', 'Installed battery expansion units.', 0, { min: 0, max: 8 }),
  i('site.mi_count', 'site', 'Installed microinverters.', 12, { min: 0, max: 200 }),
  i('site.hub_count', 'site', 'Installed hubs.', 1, { min: 0, max: 4 }),
  b('site.accombiner_present', 'site', 'AC Combiner installed. Drives SolarConfig dashboards.', true),
  b('site.generator_present', 'site', 'Generator installed. The enum exists in all clients but is rarely rendered.', false),
  e('site.backup_type', 'site', 'Backup circuit coverage.', ['NONE', 'PARTIAL', 'WHOLE_HOME'], 'PARTIAL'),
  e(
    'site.ct.consumption_pair1',
    'site',
    'Consumption CT state. Reversed is a common field error that silently inverts load sign.',
    ['NotInstalled', 'Installed', 'Reversed'],
    'Installed',
  ),
  n('site.panel_system_size_w', 'site', 'Nameplate PV array size.', 8000, { min: 0, max: 100_000, unit: 'W' }),
  e(
    'site.commissioning_status',
    'site',
    'Commissioning progress.',
    ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'],
    'NOT_STARTED',
  ),

  // -------------------------------------------------------------- plant.*
  n('plant.pv_w', 'plant', 'PV array AC output power.', 0, {
    unit: 'W',
    min: 0,
    // Must not sit below site.panel_system_size_w's ceiling, or a large-array
    // scenario makes the profile generate a value its own control rejects.
    max: 100_000,
    appliesTo: ['telemetry.pv_200_W'],
  }),
  n('plant.extpv_w', 'plant', 'External/third-party PV power.', 0, {
    unit: 'W',
    min: 0,
    max: 38_400,
    appliesTo: ['telemetry.extpv_200_W'],
  }),
  n('plant.pv.cloud_variability', 'plant', 'How erratic weather-driven PV profiles are, 0 smooth to 1 violently intermittent.', 0.3, {
    min: 0,
    max: 1,
  }),
  e(
    'plant.pv_profile',
    'plant',
    'PV shape driver. Anything but `custom` overwrites plant.pv_w each tick.',
    ['custom', 'flat', 'clear_day', 'cloudy', 'intermittent', 'overcast', 'mixed_week', 'sunrise_sunset', 'night'],
    'flat',
  ),
  n('plant.load_w', 'plant', 'House load.', 1000, {
    unit: 'W',
    min: 0,
    max: 38_400,
    appliesTo: ['telemetry.load_200_W'],
  }),
  e(
    'plant.load_profile',
    'plant',
    'Load shape driver. Anything but `custom` overwrites plant.load_w each tick.',
    ['custom', 'flat', 'residential_day', 'evening_peak', 'ev_charging', 'spiky'],
    'flat',
  ),
  n('plant.battery.soc_pct', 'plant', 'Battery state of charge.', 50, {
    unit: '%',
    min: 0,
    max: 100,
    appliesTo: ['telemetry.battery_713_SoC'],
  }),
  n('plant.battery.soh_pct', 'plant', 'Battery state of health.', 100, {
    unit: '%',
    min: 0,
    max: 100,
    appliesTo: ['telemetry.battery_713_SoH'],
  }),
  n('plant.battery.capacity_wh', 'plant', 'Usable battery energy capacity.', 13_500, {
    unit: 'Wh',
    min: 0,
    max: 100_000,
  }),
  n('plant.battery.max_charge_w', 'plant', 'Battery charge power limit.', 5000, { unit: 'W', min: 0, max: 10_000 }),
  n('plant.battery.max_discharge_w', 'plant', 'Battery discharge power limit.', 5000, { unit: 'W', min: 0, max: 10_000 }),
  n('plant.battery.temperature_c', 'plant', 'Battery temperature.', 25, { unit: 'C', min: -40, max: 85 }),
  n('plant.battery.derate_pct', 'plant', 'Additional power derate applied to the battery.', 0, {
    unit: '%',
    min: 0,
    max: 100,
  }),
  n('plant.battery.min_soc_pct', 'plant', 'Reserve floor below which the battery will not discharge.', 5, {
    unit: '%',
    min: 0,
    max: 100,
  }),
  e('plant.grid.status', 'plant', 'Grid connection state. 0 is on-grid; anything else is off-grid.', [0, 1], 0),
  n('plant.grid.voltage_v', 'plant', 'Grid voltage.', 240, { unit: 'V', min: 0, max: 300 }),
  n('plant.grid.frequency_hz', 'plant', 'Grid frequency.', 60, { unit: 'Hz', min: 45, max: 65 }),
  n('plant.grid.export_limit_w', 'plant', 'Maximum export power before curtailment.', 38_400, {
    unit: 'W',
    min: 0,
    max: 38_400,
  }),
  e(
    'plant.energy_control',
    'plant',
    'Work mode. FORCE_CHARGE/FORCE_DISCHARGE are TPO-only.',
    [0, 1, 3, 4],
    1,
  ),
  n('plant.inverter.max_output_w', 'plant', 'Inverter output limit.', 7600, { unit: 'W', min: 0, max: 38_400 }),
  n('plant.grid_w', 'plant', 'Grid power. Positive imports, negative exports. Derived from the power balance.', 0, {
    unit: 'W',
    readOnly: true,
    appliesTo: ['telemetry.grid_200_W'],
  }),
  n('plant.battery_w', 'plant', 'Battery power. Positive discharges, negative charges. Derived.', 0, {
    unit: 'W',
    readOnly: true,
    appliesTo: ['telemetry.battery_200_W'],
  }),

  // ---------------------------------------------------------------- net.*
  e('net.type', 'net', 'Active network interface. 0 none, 1 wifi, 2 ethernet, 3 cellular.', [0, 1, 2, 3], 1),
  e('net.wifi.state', 'net', 'Wi-Fi association state.', ['disconnected', 'connecting', 'connected', 'failed'], 'connected'),
  s('net.wifi.ssid', 'net', 'Associated SSID.', 'SIM-AP'),
  i('net.wifi.rssi_dbm', 'net', 'Wi-Fi signal strength.', -55, { unit: 'dBm', min: -100, max: 0 }),
  i('net.wifi.scan_count', 'net', 'Access points returned by a scan.', 8, { min: 0, max: 64 }),
  i('net.wifi.scan_delay_ms', 'net', 'Scan duration. SCAN_SETTLE_DELAY_MS is 10000.', 1200, { min: 0, max: 120_000 }),
  e(
    'net.wifi.connect_fail_reason',
    'net',
    'Forced Wi-Fi connect failure.',
    ['none', 'bad_password', 'not_found', 'timeout', 'dhcp_fail'],
    'none',
  ),
  e('net.ethernet.state', 'net', 'Ethernet link state.', ['up', 'down', 'no_link'], 'down'),
  e('net.cellular.state', 'net', 'Cellular modem state.', ['inactive', 'activating', 'active', 'failed'], 'inactive'),
  b('net.cloud.reachable', 'net', 'Cloud endpoints reachable. Local API stays up regardless.', true),
  i('net.cloud.latency_ms', 'net', 'Added latency on cloud calls.', 40, { min: 0, max: 60_000 }),
  n('net.cloud.packet_loss_pct', 'net', 'Cloud packet loss.', 0, { unit: '%', min: 0, max: 100 }),
  b('net.dns.fail', 'net', 'DNS resolution fails while TCP is otherwise fine.', false),
  b('net.captive_portal', 'net', 'Requests are intercepted by a captive portal.', false),
  b('net.tls.cert_expired', 'net', 'Board TLS certificate is expired.', false),

  // ---------------------------------------------------------------- api.*
  i('api.latency_ms', 'api', 'Latency added to every local API response.', 0, { min: 0, max: 600_000 }),
  i('api.jitter_ms', 'api', 'Random latency spread added on top of api.latency_ms.', 0, { min: 0, max: 60_000 }),
  n('api.fail_rate_pct', 'api', 'Percentage of local API calls that fail.', 0, { unit: '%', min: 0, max: 100 }),
  i('api.fail_status', 'api', 'HTTP status used when a call is failed by api.fail_rate_pct.', 500, { min: 400, max: 599 }),
  i('api.auth.token_ttl_s', 'api', 'Issued token lifetime. Short values exercise refresh paths.', 3600, {
    unit: 's',
    min: 1,
    max: 86_400,
  }),
  b('api.auth.reject', 'api', 'Reject every authenticated request with 401.', false),
  b('api.malformed_json', 'api', 'Emit syntactically invalid JSON bodies.', false),
  i('api.ws.drop_after_s', 'api', 'Close each WebSocket after N seconds. 0 never drops.', 0, { unit: 's', min: 0, max: 86_400 }),
  b('api.ws.reject_upgrade', 'api', 'Refuse WebSocket upgrades, forcing polling fallback.', false),
  b('api.ws.duplicate_responses', 'api', 'Answer each request twice with the same tid.', false),
  b('api.ws.out_of_order', 'api', 'Deliberately reorder WebSocket responses.', false),

  // Dynamic per-route overrides.
  {
    id: 'api.route.{route}.latency_ms',
    group: 'api',
    type: 'integer',
    description: `Per-route latency override. Routes: ${API_ROUTES.join(', ')}.`,
    default: 0,
    min: 0,
    max: 600_000,
  },
  {
    id: 'api.route.{route}.status',
    group: 'api',
    type: 'integer',
    description: 'Force an HTTP status on one route. 0 behaves normally.',
    default: 0,
    min: 0,
    max: 599,
  },
  {
    id: 'api.route.{route}.body',
    group: 'api',
    type: 'json',
    description: 'Replace one route response body verbatim.',
    default: null,
  },
  {
    id: 'api.route.{route}.hang',
    group: 'api',
    type: 'boolean',
    description: 'Accept the request and never respond. The worst failure for a client to handle.',
    default: false,
  },
  {
    id: 'api.route.{route}.truncate',
    group: 'api',
    type: 'boolean',
    description: 'Cut the response body mid-stream.',
    default: false,
  },

  // ---------------------------------------------------------------- mcu.*
  b('mcu.online', 'mcu', 'MCU responds on SPI.', true),
  s('mcu.fw_version', 'mcu', 'MCU firmware version.', '1.0.0'),
  i('mcu.spi.latency_ms', 'mcu', 'SPI transaction latency. Above ACK_TIMEOUT_MS (20000) the MPU gives up.', 1, {
    min: 0,
    max: 120_000,
  }),
  n('mcu.spi.crc_error_rate_pct', 'mcu', 'Percentage of SPI frames returning a bad CRC.', 0, { unit: '%', min: 0, max: 100 }),
  n('mcu.spi.nack_rate_pct', 'mcu', 'Percentage of SPI frames answered with NACK (0x91).', 0, { unit: '%', min: 0, max: 100 }),
  n('mcu.spi.timeout_rate_pct', 'mcu', 'Percentage of SPI frames that never answer.', 0, { unit: '%', min: 0, max: 100 }),
  b('mcu.spi.desync', 'mcu', 'Corrupt the 0xAA sync byte.', false),
  b('mcu.spi.short_frame', 'mcu', 'Return fewer than the fixed 71 bytes (violates FUS-124).', false),
  act('mcu.reboot', 'mcu', 'Reboot the virtual MCU.'),
  i('mcu.erase_delay_ms', 'mcu', 'Flash erase stabilisation wait before polling.', 270, { min: 0, max: 60_000 }),
  b('mcu.spi.mode_4k', 'mcu', 'Use the 4107-byte bulk frame instead of the 71-byte status frame.', false),
  {
    id: 'mcu.registers.boundary_mode',
    group: 'mcu',
    type: 'enum',
    description:
      'Apply a boundary mode to every register at once. The cheapest way to drive all 4,411 metrics through their declared extremes in a single run.',
    values: ['none', 'min', 'max', 'under', 'over'],
    default: 'none',
  },
  b('mcu.registers.freeze', 'mcu', 'Stop updating register values while still answering 200. Silent staleness.', false),
  b('mcu.registers.write_reject', 'mcu', 'Reject every register write, so settings never persist.', false),
  b('mcu.fw.crc_pass', 'mcu', 'Firmware image CRC verification passes.', true),
  b('mcu.fw.erase_ok', 'mcu', 'Flash erase reports success.', true),
  {
    id: 'mcu.register.{addr}.mode',
    group: 'mcu',
    type: 'enum',
    description:
      'Boundary-value engine for a register. min/max/below_min/above_max are generated from the register map, so all 4,411 metrics get boundary coverage without hand-authoring.',
    values: ['normal', 'min', 'max', 'below_min', 'above_max', 'stale', 'nan'],
    default: 'normal',
  },
  {
    id: 'mcu.register.{addr}.{metric}',
    group: 'mcu',
    type: 'number',
    description: 'Force one metric within a register to a literal value.',
    default: null,
  },

  // ----------------------------------------------------------------- fw.*
  e('fw.target', 'fw', 'Firmware update target.', ['mpu', 'mcu', 'pcs', 'bms', 'hub', 'mi'], 'mcu'),
  i('fw.transfer_rate_kbps', 'fw', 'Simulated transfer throughput.', 2048, { min: 1, max: 100_000 }),
  i('fw.progress_stall_at_pct', 'fw', 'Freeze progress at this percentage. 0 disables.', 0, { unit: '%', min: 0, max: 100 }),
  i('fw.fail_at_pct', 'fw', 'Fail the update at this percentage. 0 disables.', 0, { unit: '%', min: 0, max: 100 }),
  e(
    'fw.fail_mode',
    'fw',
    'How the update fails when triggered.',
    ['none', 'crc', 'timeout', 'power_loss', 'rollback', 'verify_fail', 'incompatible'],
    'none',
  ),
  i('fw.chunk_reject_index', 'fw', 'Reject this chunk index. -1 disables.', -1, { min: -1, max: 100_000 }),
  i('fw.post_update_reboot_s', 'fw', 'Reboot duration after a successful update.', 30, { unit: 's', min: 0, max: 600 }),

  // ----------------------------------------------------------------- mi.*
  i('mi.scan.duration_s', 'mi', 'Microinverter scan duration.', 60, { unit: 's', min: 0, max: 900 }),
  i('mi.scan.discover_count', 'mi', 'Microinverters the scan will find.', 12, { min: 0, max: 200 }),
  n('mi.scan.discovery_rate_per_s', 'mi', 'Discovery pace, so the app sees a progressive list.', 0.5, { min: 0, max: 50 }),
  b('mi.scan.fail', 'mi', 'Scan fails outright.', false),
  i('mi.scan.partial_pct', 'mi', 'Percentage of expected microinverters actually found.', 100, { unit: '%', min: 0, max: 100 }),
  b('mi.duplicate_serials', 'mi', 'Emit duplicate serial numbers during scan.', false),
  b('mi.reconnect_short', 'mi', 'Enable the short microinverter reconnection interval.', false),
  i('mi.offline_count', 'mi', 'Microinverters reporting offline.', 0, { min: 0, max: 200 }),
  i('mi.fault_count', 'mi', 'Microinverters reporting a fault.', 0, { min: 0, max: 200 }),

  // ---------------------------------------------------------------- ble.*
  b('ble.enabled', 'ble', 'BLE peripheral is advertising.', true),
  i('ble.mtu', 'ble', 'Negotiated BLE MTU. 23 forces heavy fragmentation.', 517, { min: 23, max: 517 }),
  e(
    'ble.pair.fail_reason',
    'ble',
    'Forced pairing failure.',
    ['none', 'timeout', 'rejected', 'auth_fail', 'bonding_lost', 'not_found', 'handshake_timeout', 'disconnect', 'permission_denied'],
    'none',
  ),
  i('ble.handshake_delay_ms', 'ble', 'Delay before the handshake completes. Above 10000 trips HANDSHAKE_TIMEOUT_MS.', 200, {
    unit: 'ms',
    min: 0,
    max: 120_000,
  }),
  b('ble.error_sweep', 'ble', 'Walk every wire error code in turn rather than holding one.', false),
  i('ble.disconnect_after_s', 'ble', 'Drop the BLE link after N seconds. 0 never drops.', 0, { unit: 's', min: 0, max: 3600 }),
  e(
    'ble.error_code',
    'ble',
    'Wire-protocol error code returned by the peripheral.',
    ['0x00', '0xFF', '0xFE', '0xFD', '0xFC', '0xFB', '0xFA', '0xF9', '0xF8', '0xF7', '0xF4'],
    '0x00',
  ),
  b('ble.ack_timeout', 'ble', 'Exceed ACK_TIMEOUT_MS (20000) on every write.', false),

  // -------------------------------------------------------------- fault.*
  j('fault.active', 'fault', 'Currently active faults as {code, device, level, flag} entries.', []),
  act('fault.inject', 'fault', 'Raise a fault: {code, device, level}.'),
  act('fault.clear', 'fault', 'Clear a fault by code, or "all".'),
  b('fault.random.enabled', 'fault', 'Randomly inject faults from the configured buckets.', false),
  n('fault.random.rate_per_hour', 'fault', 'Random fault injection rate.', 0, { min: 0, max: 3600 }),
  i('fault.random.max_active', 'fault', 'Ceiling on simultaneously active random faults.', 5, { min: 0, max: 200 }),
  b('fault.suppress_clear', 'fault', 'Never emit the clear notification, so FaultNoti.flag never returns to 0.', false),
  b('fault.sweep.enabled', 'fault', 'Walk the codebook, holding each code then clearing it.', false),
  e(
    'fault.sweep.device',
    'fault',
    'Device family to sweep, or all.',
    ['all', 'ems', 'inverter', 'battery-qhome-smart', 'grid', 'micro-inverter', 'hub'],
    'ems',
  ),
  e(
    'fault.sweep.level',
    'fault',
    'Restrict the sweep to one severity, or all. Combines with fault.sweep.device.',
    ['all', 'W', 'A', 'F'],
    'all',
  ),
  i('fault.sweep.hold_s', 'fault', 'How long each swept fault stays active.', 20, { unit: 's', min: 1, max: 3600 }),
  j('fault.random.buckets', 'fault', 'Buckets to draw random faults from: ACES, COMMON, MICROINVERTER.', []),
  i('fault.cache_ttl_s', 'fault', 'How long a raised fault persists, matching the cloud ErrorCache.', 3600, {
    unit: 's',
    min: 0,
    max: 86_400,
  }),

  // -------------------------------------------------------------- cloud.*
  b('cloud.enabled', 'cloud', 'Emit northbound cloud traffic.', false),
  b('cloud.telemetry_1m', 'cloud', 'Publish 1-minute telemetry.', true),
  b('cloud.telemetry_15m', 'cloud', 'Publish 15-minute microinverter telemetry (STANDALONE only in production).', false),
  i('cloud.error_code', 'cloud', 'Force a cloud response error code. 0 disables. 4600 is device offline.', 0, {
    min: 0,
    max: 9999,
  }),
  b('cloud.sse.enabled', 'cloud', 'Realtime SSE stream is available.', true),
  i('cloud.sse.drop_after_s', 'cloud', 'Drop the SSE stream after N seconds. 0 never drops.', 0, {
    unit: 's',
    min: 0,
    max: 86_400,
  }),
  i('cloud.sse.first_event_delay_s', 'cloud', 'Delay before the first SSE event. Exercises the shimmer state.', 2, {
    unit: 's',
    min: 0,
    max: 600,
  }),
  b('cloud.heartbeat_stall', 'cloud', 'Stop heartbeats, tripping the 5-minute offline threshold.', false),

  // ----------------------------------------------------------------- db.*
  {
    id: 'db.device_info.{key}',
    group: 'db',
    type: 'json',
    description: 'Write a device_info row in the virtual edge_storage.db.',
    default: null,
  },
  b('db.serial_mismatch', 'db', 'Report a serial number that disagrees with the scanned one.', false),
  b('db.config_invalid', 'db', 'Reject set_configuration_json as invalid.', false),
  i('db.fault_history_count', 'db', 'Synthetic historical fault rows to expose.', 0, { min: 0, max: 5000 }),
  {
    id: 'db.system_setting.{key}',
    group: 'db',
    type: 'json',
    description: 'Write a system_setting row in the virtual edge_storage.db.',
    default: null,
  },

  // -- grid ----------------------------------------------------------------
  // IEEE 1547-2018 grid-support behaviour. Parameter names follow the SunSpec
  // models that carry them (702 nameplate, 703 enter-service, 705 volt-VAR,
  // 706 volt-Watt) so they match what a commissioning engineer already knows.
  b('grid.ieee1547.enabled', 'grid', 'Enforce IEEE 1547 ride-through, trip and enter-service behaviour.', true),
  {
    id: 'grid.ieee1547.revision',
    group: 'grid',
    type: 'enum',
    description:
      'Which revision governs the frequency band. 2018 allows continuous operation 56.5-62 Hz; 2003 mandates a trip at 59.3/60.5 Hz. Sites commissioned under the older rule really do behave differently.',
    values: ['2018', '2003'],
    default: '2018',
  },
  {
    id: 'grid.ieee1547.abnormal_category',
    group: 'grid',
    type: 'enum',
    description:
      'Abnormal operating performance category (SunSpec 702 AbnOpCatRtg). I trips soonest, III rides through longest.',
    values: ['I', 'II', 'III'],
    default: 'II',
  },
  {
    id: 'grid.ieee1547.normal_category',
    group: 'grid',
    type: 'enum',
    description: 'Normal operating performance category (SunSpec 702 NorOpCatRtg).',
    values: ['A', 'B'],
    default: 'B',
  },
  n('grid.v_nominal_v', 'grid', 'Nominal AC voltage, the base for all per-unit thresholds.', 240, { unit: 'V', min: 100, max: 600 }),

  // Enter service, SunSpec model 703. Why a system does not come back the
  // instant the lights do -- and a large share of the support calls.
  n('grid.enter_service.v_hi_pu', 'grid', 'Upper voltage limit permitting reconnect (703 ESVHi).', 1.05, { min: 0.5, max: 1.5 }),
  n('grid.enter_service.v_lo_pu', 'grid', 'Lower voltage limit permitting reconnect (703 ESVLo).', 0.917, { min: 0.5, max: 1.5 }),
  n('grid.enter_service.hz_hi', 'grid', 'Upper frequency limit permitting reconnect (703 ESHzHi).', 60.1, { unit: 'Hz', min: 45, max: 65 }),
  n('grid.enter_service.hz_lo', 'grid', 'Lower frequency limit permitting reconnect (703 ESHzLo).', 59.5, { unit: 'Hz', min: 45, max: 65 }),
  n('grid.enter_service.delay_s', 'grid', 'Conditions must stay inside the window this long before reconnect (703 ESDlyTms). Any excursion restarts the clock.', 300, { unit: 's', min: 0, max: 3600 }),
  n('grid.enter_service.ramp_s', 'grid', 'Power ramps from zero to full over this period after reconnect (703 ESRmpTms).', 300, { unit: 's', min: 0, max: 3600 }),

  // Volt-VAR, SunSpec model 705.
  b('grid.volt_var.enabled', 'grid', 'Absorb or inject reactive power as a function of voltage (705).', false),
  n('grid.volt_var.v_ref_pu', 'grid', 'Reference voltage for the volt-VAR curve (705 VRef).', 1.0, { min: 0.8, max: 1.2 }),
  n('grid.volt_var.deadband_pu', 'grid', 'No reactive response inside this band around the reference.', 0.02, { min: 0, max: 0.2 }),
  n('grid.volt_var.v_slope_end_pu', 'grid', 'Deviation at which the curve reaches maximum reactive output.', 0.08, { min: 0.01, max: 0.5 }),
  n('grid.volt_var.var_max_pct', 'grid', 'Maximum reactive power as a percentage of rated VA (705 VAR_MAX_PCT).', 44, { unit: '%', min: 0, max: 100 }),

  // Volt-Watt, SunSpec model 706.
  b('grid.volt_watt.enabled', 'grid', 'Curtail real power as a function of voltage (706).', false),
  n('grid.volt_watt.v_start_pu', 'grid', 'Voltage at which curtailment begins.', 1.06, { min: 0.9, max: 1.3 }),
  n('grid.volt_watt.v_end_pu', 'grid', 'Voltage at which curtailment reaches its floor.', 1.1, { min: 0.9, max: 1.3 }),
  n('grid.volt_watt.w_min_pct', 'grid', 'Minimum permitted real power at and above the end voltage (706 W_MAX_PCT floor).', 0, { unit: '%', min: 0, max: 100 }),

  // -- can -----------------------------------------------------------------
  // The second bus. Where SPI reaches the Qcells MCU, CAN reaches the PCS
  // units, their BDC/inverter CPUs and the JF2 battery stack, via the
  // `qcells_ess_g4` map (833 registers / 2,985 metrics).
  b('can.online', 'can', 'CAN interface is up.', true),
  b('can.bus_off', 'can', 'CAN controller has gone bus-off after excessive TX errors. Reads fail permanently, not slowly.', false),
  i('can.pcs_count', 'can', 'Number of PCS units present (1 or 2). Registers for absent units time out.', 1, { min: 1, max: 2 }),
  n('can.arbitration_loss_rate_pct', 'can', 'Percentage of frames that lose arbitration and are never sent.', 0, { unit: '%', min: 0, max: 100 }),
  n('can.tx_timeout_rate_pct', 'can', 'Percentage of CAN transmits that time out.', 0, { unit: '%', min: 0, max: 100 }),
  n('can.form_error_rate_pct', 'can', 'Percentage of received frames with a form error.', 0, { unit: '%', min: 0, max: 100 }),
  b('can.write_reject', 'can', 'Reject every CAN write, so PCS settings never take.', false),
  b('can.registers.freeze', 'can', 'Freeze all CAN register values while still answering. Silent staleness.', false),
  {
    id: 'can.registers.boundary_mode',
    group: 'can',
    type: 'enum',
    description:
      'Apply a boundary mode to every CAN register at once, driving all 2,985 g4 metrics through their declared extremes. Fault flag bytes are excluded so a sweep does not read as a total system fault.',
    values: ['none', 'min', 'max', 'under', 'over'],
    default: 'none',
  },
  b('can.pcs1.silent', 'can', 'PCS unit 1 stops answering on the bus.', false),
  b('can.pcs2.silent', 'can', 'PCS unit 2 stops answering on the bus.', false),
  b('can.pcs1.heartbeat_stuck', 'can', 'Pin PCS 1 CPU heartbeats to a constant. How a hung CPU is actually detected.', false),
  b('can.pcs2.heartbeat_stuck', 'can', 'Pin PCS 2 CPU heartbeats to a constant.', false),
  {
    id: 'can.register.{addr}.mode',
    group: 'can',
    type: 'enum',
    description: 'Boundary-value engine for one CAN register, generated from the g4 map.',
    values: ['normal', 'min', 'max', 'below_min', 'above_max', 'stale', 'nan'],
    default: 'normal',
  },
  {
    id: 'can.register.{addr}.{metric}',
    group: 'can',
    type: 'json',
    description: 'Pin one CAN metric to an exact value, overriding both the plant and any boundary mode.',
    default: null,
  },

  // -- can.flag ------------------------------------------------------------
  // Faults on the PCS are bitmask bytes, not codes. Both views the Gen1 HMI
  // offered are kept: named bits for readability, raw hex bytes as the escape
  // hatch for conditions nobody has named.
  {
    id: 'can.flag.set',
    group: 'can.flag',
    type: 'json',
    description:
      'Set named fault bits by Gen1-style code, e.g. ["G01005F","D01102W"]. Domain letter (G/P/D/M), PCS number, bit index 000-063, severity (F/W/A).',
    default: null,
  },
  {
    id: 'can.flag.clear',
    group: 'can.flag',
    type: 'json',
    description: 'Clear named fault bits by code. Every fault must be clearable, not just settable.',
    default: null,
  },
  {
    id: 'can.flag.byte.{pcs}.{domain}.{severity}.{index}',
    group: 'can.flag',
    type: 'integer',
    description:
      'Raw flag byte, 0-255. The Gen1 "Error tab" escape hatch: write eight conditions at once without naming any of them.',
    default: 0,
    min: 0,
    max: 255,
  },
  act('can.flag.clear_all', 'can.flag', 'Clear every fault bit on every PCS unit.'),
  act('can.reboot', 'can', 'Reset the virtual CAN controller, clearing bus-off recovery state.'),
  {
    id: 'can.flag.sweep',
    group: 'can.flag',
    type: 'enum',
    description:
      'Raise every bit of one severity across all domains at once. The bulk equivalent of flipping every switch on the Gen1 Fault Manager tab.',
    values: ['none', 'Fault', 'Warning', 'Alarm', 'all'],
    default: 'none',
  },
];
