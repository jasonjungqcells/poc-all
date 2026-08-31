import type { RigContext } from '../core/context.js';
import {
  CAN_FLAG_DOMAINS,
  CAN_SEVERITIES,
  allFlagRefs,
  flagCode,
  parseFlagCode,
  type CanFlagDomain,
  type CanSeverity,
} from './flags.js';

/**
 * Make the `can.flag.*` controls act on the bus.
 *
 * These are the only controls in the rig with side effects beyond their own
 * value, because a fault flag is state on a device rather than a setting: it
 * has to be raised and lowered, and it has to be reachable both by name and as
 * a raw byte. Keeping the reconciliation here rather than inside `VirtualCan`
 * leaves the bus itself a pure register model.
 */
export function registerCanControls(ctx: RigContext): void {
  const { controls, can, log } = ctx;

  const applyCodes = (value: unknown, on: boolean): void => {
    const codes = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    for (const code of codes) {
      if (typeof code !== 'string') continue;
      if (!can.setFlagCode(code, on)) {
        log('warn', `can.flag: unrecognised code ${code}`);
      }
    }
  };

  controls.on('change:can.flag.set', (value) => applyCodes(value, true));
  controls.on('change:can.flag.clear', (value) => applyCodes(value, false));

  controls.on('action:can.flag.clear_all', () => {
    can.clearFlags();
    // Reset the sweep too, or the next tick would immediately re-raise
    // everything it had set and the clear would look like it did nothing.
    controls.set('can.flag.sweep', 'none');
  });

  controls.on('change:can.flag.sweep', (value) => {
    const mode = String(value);
    can.clearFlags();
    if (mode === 'none') return;

    const severities: CanSeverity[] =
      mode === 'all' ? CAN_SEVERITIES : CAN_SEVERITIES.filter((s) => s === mode);
    const pcsCount = can.pcsCount();
    let raised = 0;
    for (let pcs = 1; pcs <= pcsCount; pcs += 1) {
      for (const ref of allFlagRefs()) {
        if (!severities.includes(ref.severity)) continue;
        can.bank(pcs).setBit(ref, true);
        raised += 1;
      }
    }
    log('info', `can.flag.sweep=${mode} raised ${raised} bits across ${pcsCount} PCS unit(s)`);
  });

  // Raw byte writes: `can.flag.byte.1.Grid.Fault.3` = 0xFF.
  controls.on('change', (change: { id: string; value: unknown }) => {
    const m = /^can\.flag\.byte\.(\d+)\.(\w+)\.(\w+)\.(\d+)$/.exec(change.id);
    if (!m) return;
    const domain = m[2] as CanFlagDomain;
    const severity = m[3] as CanSeverity;
    if (!CAN_FLAG_DOMAINS.includes(domain) || !CAN_SEVERITIES.includes(severity)) {
      log('warn', `can.flag.byte: unknown domain/severity in ${change.id}`);
      return;
    }
    can.bank(Number(m[1])).setByte(domain, severity, Number(m[4]), Number(change.value));
  });
}

/**
 * Every valid flag code, for documentation and for the control-plane catalogue.
 * 768 bits per PCS unit.
 */
export function catalogueFlagCodes(pcsCount: number): string[] {
  const out: string[] = [];
  for (let pcs = 1; pcs <= pcsCount; pcs += 1) {
    for (const ref of allFlagRefs()) out.push(flagCode(ref, pcs));
  }
  return out;
}

export { parseFlagCode };
