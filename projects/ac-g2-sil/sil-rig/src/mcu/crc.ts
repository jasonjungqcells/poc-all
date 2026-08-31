/**
 * CRC16-CCITT as used on the MPU<->MCU SPI link.
 * Polynomial 0x1021, init 0x0000, appended little-endian.
 */
export function crc16ccitt(data: Uint8Array, init = 0x0000): number {
  let crc = init & 0xffff;
  for (const byte of data) {
    crc ^= (byte << 8) & 0xffff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export function appendCrcLe(buf: Uint8Array, crc: number): Uint8Array {
  const out = new Uint8Array(buf.length + 2);
  out.set(buf, 0);
  out[buf.length] = crc & 0xff;
  out[buf.length + 1] = (crc >> 8) & 0xff;
  return out;
}
