/**
 * Generates the extension icons without any image dependency: a tiny pure-Node
 * PNG encoder plus a supersampled rasteriser. Run with `pnpm icons`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CORNER = 0.22;
function insideRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, CORNER), 1 - CORNER);
  const cy = Math.min(Math.max(y, CORNER), 1 - CORNER);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= CORNER * CORNER;
}

const MARK = { left: 0.335, right: 0.665, top: 0.235, bottom: 0.775, notch: 0.17 };
function insideBookmark(x, y) {
  if (x < MARK.left || x > MARK.right || y < MARK.top || y > MARK.bottom) return false;
  const half = (MARK.right - MARK.left) / 2;
  const depth = MARK.notch * (1 - Math.abs(x - 0.5) / half);
  return MARK.bottom - y >= depth;
}

const TOP = [0x4a, 0x86, 0xf7];
const BOTTOM = [0x24, 0x53, 0xc9];

function rasterise(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4;
  const total = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      let glyph = 0;
      let sumY = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (!insideRoundedSquare(x, y)) continue;
          covered++;
          sumY += y;
          if (insideBookmark(x, y)) glyph++;
        }
      }
      if (covered === 0) continue;
      const offset = (py * size + px) * 4;
      const ny = sumY / covered;
      const mix = glyph / covered;
      for (let c = 0; c < 3; c++) {
        const base = TOP[c] + (BOTTOM[c] - TOP[c]) * ny;
        rgba[offset + c] = Math.round(base * (1 - mix) + 255 * mix);
      }
      rgba[offset + 3] = Math.round((covered / total) * 255);
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `${size}.png`);
  writeFileSync(file, encodePng(size, rasterise(size)));
  console.log(`wrote ${file}`);
}
