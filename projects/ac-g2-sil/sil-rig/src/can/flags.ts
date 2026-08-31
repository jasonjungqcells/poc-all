/**
 * Fault flag bit model for the `qcells_ess_g4` CAN map.
 *
 * The Gen2 CAN map exposes faults as **bitmask bytes**, not as codes:
 * `P01_PCS_Error_Status_01` is 48 bytes carrying six domains of eight flag
 * bytes each, and every bit in those bytes is one distinct fault condition.
 *
 * This is exactly the model the Gen1 Node-RED HMI drove: its "Error" tab was a
 * grid of hex inputs writing raw flag bytes, and its "Fault Manager" tab was a
 * curated set of 192 named switches over the same bits. Both views are useful,
 * so both are provided here -- named bits for readability, raw bytes for the
 * conditions nobody has named yet.
 */

/** Severity as encoded in the register metric names. */
export type CanSeverity = 'Fault' | 'Warning' | 'Alarm';

/** Flag domains carried by the PCS error-status registers. */
export const CAN_FLAG_DOMAINS = ['Grid', 'PCS', 'BDC', 'MCU'] as const;
export type CanFlagDomain = (typeof CAN_FLAG_DOMAINS)[number];

export const CAN_SEVERITIES: CanSeverity[] = ['Fault', 'Warning', 'Alarm'];

/** Eight flag bytes per domain/severity, eight bits each: 64 conditions. */
export const FLAG_BYTES_PER_DOMAIN = 8;
export const BITS_PER_BYTE = 8;

export interface CanFlagRef {
  domain: CanFlagDomain;
  severity: CanSeverity;
  /** Flag byte index, 0-7. */
  byte: number;
  /** Bit within the byte, 0-7. */
  bit: number;
}

const DOMAIN_LETTER: Record<CanFlagDomain, string> = {
  Grid: 'G',
  PCS: 'P',
  BDC: 'D',
  MCU: 'M',
};

/** Metric id for one flag byte, e.g. `Grid_Fault_Flag3`. */
export function flagMetricId(domain: CanFlagDomain, severity: CanSeverity, byte: number): string {
  return `${domain}_${severity}_Flag${byte}`;
}

/**
 * Gen1-style short code for a flag bit.
 *
 * Gen1 labelled its switches `G01001F` / `P01501F` / `D00601F` -- a domain
 * letter, digits, and a severity letter. Reproducing that shape keeps both
 * generations legible to the same engineers, even though the maps differ.
 */
export function flagCode(ref: CanFlagRef, pcs = 1): string {
  const letter = DOMAIN_LETTER[ref.domain];
  const sev = ref.severity[0]!.toUpperCase();
  const index = String(ref.byte * BITS_PER_BYTE + ref.bit).padStart(3, '0');
  return `${letter}${String(pcs).padStart(2, '0')}${index}${sev}`;
}

/** Parse `G01001F` back into a flag reference. Returns undefined if malformed. */
export function parseFlagCode(code: string): (CanFlagRef & { pcs: number }) | undefined {
  const match = /^([GPDM])(\d{2})(\d{3})([FWA])$/.exec(code.toUpperCase());
  if (!match) return undefined;

  const domain = (Object.keys(DOMAIN_LETTER) as CanFlagDomain[]).find(
    (d) => DOMAIN_LETTER[d] === match[1],
  );
  if (!domain) return undefined;

  const index = Number(match[3]);
  if (index >= FLAG_BYTES_PER_DOMAIN * BITS_PER_BYTE) return undefined;

  const severity = CAN_SEVERITIES.find((s) => s[0] === match[4]);
  if (!severity) return undefined;

  return {
    domain,
    severity,
    byte: Math.floor(index / BITS_PER_BYTE),
    bit: index % BITS_PER_BYTE,
    pcs: Number(match[2]),
  };
}

/** Every addressable flag bit: 4 domains x 3 severities x 8 bytes x 8 bits = 768. */
export function allFlagRefs(): CanFlagRef[] {
  const refs: CanFlagRef[] = [];
  for (const domain of CAN_FLAG_DOMAINS) {
    for (const severity of CAN_SEVERITIES) {
      for (let byte = 0; byte < FLAG_BYTES_PER_DOMAIN; byte += 1) {
        for (let bit = 0; bit < BITS_PER_BYTE; bit += 1) {
          refs.push({ domain, severity, byte, bit });
        }
      }
    }
  }
  return refs;
}

/**
 * Mutable flag state for one PCS unit.
 *
 * Held as bytes rather than a set of bit ids so that reading a register is a
 * direct lookup, and writing a raw hex byte -- the Gen1 escape hatch -- needs no
 * translation.
 */
export class CanFlagBank {
  private readonly bytes = new Map<string, number>();

  private key(domain: CanFlagDomain, severity: CanSeverity, byte: number): string {
    return `${domain}_${severity}_${byte}`;
  }

  getByte(domain: CanFlagDomain, severity: CanSeverity, byte: number): number {
    return this.bytes.get(this.key(domain, severity, byte)) ?? 0;
  }

  setByte(domain: CanFlagDomain, severity: CanSeverity, byte: number, value: number): void {
    this.bytes.set(this.key(domain, severity, byte), value & 0xff);
  }

  getBit(ref: CanFlagRef): boolean {
    return (this.getByte(ref.domain, ref.severity, ref.byte) & (1 << ref.bit)) !== 0;
  }

  setBit(ref: CanFlagRef, on: boolean): void {
    const current = this.getByte(ref.domain, ref.severity, ref.byte);
    const next = on ? current | (1 << ref.bit) : current & ~(1 << ref.bit);
    this.setByte(ref.domain, ref.severity, ref.byte, next);
  }

  /** Every bit currently set, as Gen1-style codes. */
  active(pcs: number): string[] {
    const out: string[] = [];
    for (const ref of allFlagRefs()) {
      if (this.getBit(ref)) out.push(flagCode(ref, pcs));
    }
    return out;
  }

  anySet(): boolean {
    for (const value of this.bytes.values()) {
      if (value !== 0) return true;
    }
    return false;
  }

  clearAll(): void {
    this.bytes.clear();
  }

  /** Raw non-zero byte view, for the hex-grid surface. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const domain of CAN_FLAG_DOMAINS) {
      for (const severity of CAN_SEVERITIES) {
        for (let byte = 0; byte < FLAG_BYTES_PER_DOMAIN; byte += 1) {
          const value = this.getByte(domain, severity, byte);
          if (value !== 0) {
            out[flagMetricId(domain, severity, byte)] = `0x${value.toString(16).padStart(2, '0')}`;
          }
        }
      }
    }
    return out;
  }
}
