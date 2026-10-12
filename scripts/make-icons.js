// Generates the PNG app icons (a filament spool) without any dependency.
// Usage: node scripts/make-icons.js
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BG = [17, 24, 39];
const SPOOL = [234, 88, 12];

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function icon(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / size;
      // outer ring = filament, inner dot = hub; kept inside the maskable safe zone
      const on = (r > 0.14 && r < 0.34) || r < 0.06;
      raw.set(on ? SPOOL : BG, rowStart + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(path.join(out, `icon-${size}.png`), icon(size));
