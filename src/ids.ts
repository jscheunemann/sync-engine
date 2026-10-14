// Record ids are UUIDv7 made on the device, so a record created offline never needs renaming and ids sort roughly by
// creation time.

export function uuidv7(now: number = Date.now(), random: (n: number) => Uint8Array = randomBytes): string {
  const b = random(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * A fixed id worked out from its parts, for records that are a pair or a key rather than a thing someone made (a
 * meeting's attendee, an action's dependency, the daily plan for a date). Two devices adding the same pair offline
 * pick the same id, so sync sees one record, not two. UUIDv8 layout; not a security boundary (FNV-1a, not a hash
 * anyone needs to trust).
 */
export function nameId(...parts: string[]): string {
  const text = parts.join('\u0000');
  const out = new Uint8Array(16);
  for (let lane = 0; lane < 4; lane++) {
    let h = (0x811c9dc5 ^ (lane * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
    for (let j = 0; j < 4; j++) out[lane * 4 + j] = (h >>> (24 - 8 * j)) & 0xff;
  }
  out[6] = (out[6]! & 0x0f) | 0x80; // version 8
  out[8] = (out[8]! & 0x3f) | 0x80;
  const h = [...out].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
