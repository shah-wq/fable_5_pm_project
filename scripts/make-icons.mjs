#!/usr/bin/env node
/**
 * Generates the app icons the stores and the home screen require, from code
 * rather than from a designer's export, so they can be regenerated when the
 * brand colour changes and so no binary blob has to live in the repo history
 * un-reviewable.
 *
 * Draws a sun over the brand navy: a filled disc with eight rays, computed per
 * pixel with 3x3 supersampling for clean edges, then written as a real PNG
 * (zlib is in Node, so there is no image dependency).
 *
 *   node scripts/make-icons.mjs
 *
 * Sizes: 192 and 512 (Android/manifest), 512 maskable (Android adaptive icon
 * needs the mark inside the safe circle), 180 (iOS apple-touch-icon), 32
 * (favicon).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public');

const NAVY = [11, 31, 58];      // #0b1f3a — the app's dark surface
const SUN = [255, 183, 3];      // #ffb703 — the accent used for 'current stage'
const RAYS = 8;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  // RGB, 8-bit, no filtering: one leading filter byte per scanline.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of the sun mark at one point, 0..1, from 3x3 supersampling. */
function sunCoverage(x, y, size, scale) {
  const c = size / 2;
  const disc = size * 0.20 * scale;
  const rayIn = size * 0.26 * scale;
  const rayOut = size * 0.40 * scale;
  const rayHalf = 0.14;  // radians either side of each ray's centre line

  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3 - c;
      const py = y + (sy + 0.5) / 3 - c;
      const d = Math.hypot(px, py);
      if (d <= disc) { hits++; continue; }
      if (d >= rayIn && d <= rayOut) {
        const a = Math.atan2(py, px);
        const step = (Math.PI * 2) / RAYS;
        // Distance to the nearest ray centre line, wrapped.
        let off = Math.abs(((a % step) + step * 1.5) % step - step / 2);
        // Rays taper: narrower at the tip, so it reads as a sun not a gear.
        const t = (d - rayIn) / (rayOut - rayIn);
        if (off <= rayHalf * (1 - 0.55 * t)) hits++;
      }
    }
  }
  return hits / 9;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function write(name, size, { maskable = false, transparentBg = false } = {}) {
  // A maskable icon may be cropped to a circle by the launcher, so the mark
  // gets the inner 80% and the background must reach every corner.
  const scale = maskable ? 0.78 : 1;
  const buf = png(size, (x, y) => {
    const bg = transparentBg ? [255, 255, 255] : NAVY;
    return mix(bg, SUN, sunCoverage(x, y, size, scale));
  });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), buf);
  console.log(`wrote public/${name} (${size}px, ${buf.length} bytes)`);
}

write('icon-192.png', 192);
write('icon-512.png', 512);
write('icon-maskable-512.png', 512, { maskable: true });
write('apple-touch-icon.png', 180);
write('favicon-32.png', 32);
