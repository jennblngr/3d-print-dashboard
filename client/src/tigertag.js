// Decodes the memory of a TigerTag chip (open format, https://github.com/TigerTag-Project/TigerTag-RFID-Guide)
// into the fields of a spool. A browser cannot read these chips itself: the bytes come from the
// Android companion app, which opens this app with them in the URL.
import { BRANDS, MATERIALS, ASPECTS, GRAMS_PER_UNIT } from './tigertag-db.js';

const PAGE = 4; // bytes per memory page
const PAYLOAD = 4 * PAGE; // the TigerTag data starts at page 0x04
const MIN_BYTES = PAYLOAD + 80; // up to page 0x17, the last one holding material data
const FORMATS = new Set([0x5bf59264, 0xbc0fcb97]); // TigerTag, TigerTag+
const BLANK_FORMAT = 0x6c41a2e1; // chip initialised but not written yet
const PLAIN_ASPECTS = new Set(['-', 'Basic', 'None']);

export class TigerTagError extends Error {
  constructor(reason) {
    super(`TigerTag: ${reason}`);
    this.reason = reason; // 'invalid' | 'blank' | 'unknown-format'
  }
}

// `hex` is the chip memory from page 0, as hexadecimal text (separators allowed).
export function decodeTigerTag(hex) {
  const clean = String(hex).replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 || clean.length < MIN_BYTES * 2 || clean.length > 4096) throw new TigerTagError('invalid');
  const b = Uint8Array.from(clean.match(/../g), h => parseInt(h, 16));
  const u8 = o => b[PAYLOAD + o];
  const u16 = o => (u8(o) << 8) | u8(o + 1);
  const u24 = o => (u8(o) << 16) | u16(o + 1);
  const u32 = o => u16(o) * 0x10000 + u16(o + 2);

  const format = u32(0);
  if (format === BLANK_FORMAT) throw new TigerTagError('blank');
  if (!FORMATS.has(format)) throw new TigerTagError('unknown-format');

  // 7-byte serial number: page 0 bytes 0-2 and page 1 bytes 0-3 (page 0 byte 3 is a checksum).
  const uid = [b[0], b[1], b[2], b[4], b[5], b[6], b[7]];
  const aspects = [u8(10), u8(11)].map(id => ASPECTS[id]).filter(label => label && !PLAIN_ASPECTS.has(label));
  const weight = u24(20) * (GRAMS_PER_UNIT[u8(23)] ?? 0);
  const left = u24(76) * (GRAMS_PER_UNIT[u8(23)] ?? 0);

  const spool = {
    // same shape as the serial number a browser reports for NFC tags it can read
    code: 'nfc:' + uid.map(x => x.toString(16).padStart(2, '0')).join(':'),
    brand: BRANDS[u16(14)] ?? '',
    material: MATERIALS[u16(8)] ?? '',
    variant: [...new Set(aspects)].join(' ').replace(/\bMatt\b/, 'Matte'),
    color_hex: '#' + [u8(16), u8(17), u8(18)].map(x => x.toString(16).padStart(2, '0')).join(''),
  };
  if (weight > 0) spool.weight_g = weight;
  // 0 means "never weighed" on a chip that was not updated by a scale, so only trust a real value.
  if (left > 0 && left <= weight) spool.remaining_g = left;
  return spool;
}

// A chip stores a shade but no colour name. This gives the everyday family of a #rrggbb shade
// ('white', 'blue'...), which the app translates and offers as an editable colour name.
export function colorFamily(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const chroma = max - min;
  if (chroma < 0.1) return light > 0.8 ? 'white' : light < 0.2 ? 'black' : 'grey';
  let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return light > 0.7 ? 'pink' : 'red';
  if (hue < 45) return light < 0.4 ? 'brown' : chroma < 0.3 && light > 0.6 ? 'beige' : 'orange';
  if (hue < 70) return chroma < 0.3 && light > 0.6 ? 'beige' : 'yellow';
  if (hue < 165) return 'green';
  if (hue < 200) return 'turquoise';
  if (hue < 260) return 'blue';
  if (hue < 290) return 'purple';
  return light < 0.4 ? 'purple' : 'pink';
}
