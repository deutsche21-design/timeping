/**
 * create-icon.js — 앱 아이콘 PNG 생성 (외부 의존성 없음)
 * 결과: assets/icon.png (512×512), assets/icon.icns (macOS)
 */
'use strict';
const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');
const { execSync } = require('child_process');

// ── CRC32 ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, crcBuf]);
}

// ── PNG writer ────────────────────────────────────────────────────────────────
function writePNG(size, pixelsFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const pixels = new Uint8Array(size * size * 4); // RGBA
  pixelsFn(pixels, size);

  // filter-type 0 per row
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++)
      raw[y * (size * 4 + 1) + 1 + x] = pixels[y * size * 4 + x];
  }

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing helpers ───────────────────────────────────────────────────────────
function setPixel(p, size, x, y, r, g, b, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  const fa = a / 255;
  p[i]   = Math.round(p[i]   * (1 - fa) + r * fa);
  p[i+1] = Math.round(p[i+1] * (1 - fa) + g * fa);
  p[i+2] = Math.round(p[i+2] * (1 - fa) + b * fa);
  p[i+3] = Math.min(255, p[i+3] + Math.round(a * (1 - p[i+3]/255)));
}

function drawLine(p, size, x0, y0, x1, y1, thickness, r, g, b) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx*dx + dy*dy);
  const steps = Math.ceil(len * 2);
  const half = thickness / 2;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + dx * t, cy = y0 + dy * t;
    const iHalf = Math.ceil(half) + 1;
    for (let oy = -iHalf; oy <= iHalf; oy++) {
      for (let ox = -iHalf; ox <= iHalf; ox++) {
        const dist = Math.sqrt(ox*ox + oy*oy);
        if (dist <= half) {
          const aa = dist > half - 1 ? (half - dist) * 255 : 255;
          setPixel(p, size, Math.round(cx + ox), Math.round(cy + oy), r, g, b, Math.round(aa));
        }
      }
    }
  }
}

// ── Icon design ───────────────────────────────────────────────────────────────
function drawIcon(pixels, S) {
  const cx = S / 2, cy = S / 2;
  const R  = S * 0.46; // outer circle radius

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist >= R + 1) continue;

      const i = (y * S + x) * 4;
      // Gradient: center #6366f1 → edge #a855f7
      const t = dist / R;
      const pr = Math.round(99  + (168 - 99)  * t); // R
      const pg = Math.round(102 + (85  - 102) * t); // G
      const pb = Math.round(241 + (247 - 241) * t); // B
      const alpha = dist > R - 1.5 ? Math.max(0, (R - dist) / 1.5) : 1;

      pixels[i]   = pr;
      pixels[i+1] = pg;
      pixels[i+2] = pb;
      pixels[i+3] = Math.round(alpha * 255);
    }
  }

  // White checkmark — scaled to circle
  const thick = S * 0.075;
  const lx = cx - R * 0.28;  // left tip X
  const ly = cy + R * 0.05;  // left tip Y
  const mx = cx - R * 0.05;  // mid vertex X
  const my = cy + R * 0.30;  // mid vertex Y
  const rx = cx + R * 0.38;  // right tip X
  const ry = cy - R * 0.25;  // right tip Y

  drawLine(pixels, S, lx, ly, mx, my, thick, 255, 255, 255);
  drawLine(pixels, S, mx, my, rx, ry, thick, 255, 255, 255);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const assetsDir = path.join(__dirname, '..', 'assets');
const pngPath   = path.join(assetsDir, 'icon.png');

console.log('Generating icon.png …');
const png = writePNG(512, drawIcon);
fs.writeFileSync(pngPath, png);
console.log(`✓ assets/icon.png  (${png.length} bytes)`);

// Build macOS .icns using sips + iconutil
const icnsDir = path.join(assetsDir, 'icon.iconset');
if (!fs.existsSync(icnsDir)) fs.mkdirSync(icnsDir);

const sizes = [16,32,64,128,256,512];
try {
  for (const s of sizes) {
    execSync(`sips -z ${s} ${s} "${pngPath}" --out "${path.join(icnsDir, `icon_${s}x${s}.png`)}" 2>/dev/null`);
    // @2x variant
    if (s <= 256) {
      execSync(`sips -z ${s*2} ${s*2} "${pngPath}" --out "${path.join(icnsDir, `icon_${s}x${s}@2x.png`)}" 2>/dev/null`);
    }
  }
  const icnsPath = path.join(assetsDir, 'icon.icns');
  execSync(`iconutil -c icns "${icnsDir}" -o "${icnsPath}"`);
  fs.rmSync(icnsDir, { recursive: true });
  console.log('✓ assets/icon.icns');
} catch (e) {
  console.warn('ICNS 생성 실패 (macOS 전용):', e.message);
}

console.log('Done!');
