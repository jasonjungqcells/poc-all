import { appendCrcLe, crc16ccitt } from './crc.js';

/**
 * MPU<->MCU SPI frame codec.
 *
 * Frame layout (standard, 71 bytes total -- FUS-124 fixes MPU Rx at 71):
 *   sync(1) = 0xAA | cmd(1) | address(2, LE) | payloadLen(1) | payload(64) | crc16(2, LE)
 *
 * 4K mode replaces the 64-byte payload with 4100 bytes:
 *   index(2, LE) | dataCrc(2, LE) | flashBlock(4096)   => 4107 bytes total
 */

export const SYNC_BYTE = 0xaa;
export const STANDARD_PAYLOAD_LEN = 64;
export const STANDARD_FRAME_LEN = 71;
export const FOURK_PAYLOAD_LEN = 4100;
export const FOURK_FRAME_LEN = 4107;

/** Command bytes observed on the wire. */
export const CMD = {
  ACK: 0x81,
  NACK: 0x91,
  CMD_ACK: 0x88,
} as const;

/** Firmware-update register addresses. */
export const FW_ADDR = {
  VERSION_SERIAL: 0x8000,
  STATUS: 0x8010,
  START_FINALIZE: 0x8011,
  CHUNK: 0x8012,
  FINALIZE: 0x8013,
  ERROR: 0xffff,
} as const;

export interface SpiFrame {
  sync: number;
  cmd: number;
  address: number;
  payloadLen: number;
  payload: Uint8Array;
  crc: number;
  crcValid: boolean;
}

export function encodeFrame(
  cmd: number,
  address: number,
  payload: Uint8Array,
  mode: 'standard' | '4k' = 'standard',
): Uint8Array {
  const payloadLen = mode === '4k' ? FOURK_PAYLOAD_LEN : STANDARD_PAYLOAD_LEN;
  const body = new Uint8Array(5 + payloadLen);
  body[0] = SYNC_BYTE;
  body[1] = cmd & 0xff;
  body[2] = address & 0xff;
  body[3] = (address >> 8) & 0xff;
  // payloadLen is a single byte; 4K mode relies on the negotiated transfer size
  // rather than this field, which is why it truncates rather than widening.
  body[4] = payload.length & 0xff;
  body.set(payload.subarray(0, payloadLen), 5);
  return appendCrcLe(body, crc16ccitt(body));
}

export function decodeFrame(raw: Uint8Array): SpiFrame {
  if (raw.length < 7) throw new Error(`frame too short: ${raw.length} bytes`);
  const body = raw.subarray(0, raw.length - 2);
  const crc = (raw[raw.length - 1]! << 8) | raw[raw.length - 2]!;
  return {
    sync: raw[0]!,
    cmd: raw[1]!,
    address: raw[2]! | (raw[3]! << 8),
    payloadLen: raw[4]!,
    payload: raw.subarray(5, raw.length - 2),
    crc,
    crcValid: crc16ccitt(body) === crc,
  };
}

/**
 * Build the 0x8010 status response.
 *
 * byte[0]=0xAA, byte[1]=0x88, byte[2]=0x10, byte[5]=device select
 * (EMS Main is 0x11), byte[6]=1 when erase is done, byte[7]=1 CRC pass /
 * 2 CRC fail. The final 0x8011 response additionally sets byte[11]=0x80.
 */
export function buildStatusPayload(opts: {
  deviceSelect?: number;
  eraseDone?: boolean;
  crcPass?: boolean;
  finalized?: boolean;
}): Uint8Array {
  const p = new Uint8Array(STANDARD_PAYLOAD_LEN);
  p[0] = SYNC_BYTE;
  p[1] = CMD.CMD_ACK;
  p[2] = 0x10;
  p[5] = opts.deviceSelect ?? 0x11;
  p[6] = opts.eraseDone ? 0x01 : 0x00;
  p[7] = opts.crcPass === false ? 0x02 : opts.crcPass ? 0x01 : 0x00;
  if (opts.finalized) p[11] = 0x80;
  return p;
}
