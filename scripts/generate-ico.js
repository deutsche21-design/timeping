#!/usr/bin/env node
/**
 * Generates assets/icon.ico with 32x32 and 16x16 alarm clock images.
 * Uses only Node.js built-ins — no external dependencies required.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Draw helpers ──────────────────────────────────────────────────────────

function createCanvas(size) {
  // RGBA flat array, initialised to white (255,255,255,255)
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 0] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  return { data, size };
}

function setPixel(canvas, x, y, r, g, b, a = 255) {
  const { data, size } = canvas;
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 4;
  data[i]     = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = a;
}

// Draw a filled circle (Bresenham)
function fillCircle(canvas, cx, cy, r, R, G, B) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) {
        setPixel(canvas, Math.round(cx + dx), Math.round(cy + dy), R, G, B);
      }
    }
  }
}

// Draw a ring (hollow circle outline with given thickness)
function drawRing(canvas, cx, cy, r, thickness, R, G, B) {
  const inner = r - thickness;
  for (let dy = -(r + 1); dy <= r + 1; dy++) {
    for (let dx = -(r + 1); dx <= r + 1; dx++) {
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= r * r && dist2 >= inner * inner) {
        setPixel(canvas, Math.round(cx + dx), Math.round(cy + dy), R, G, B);
      }
    }
  }
}

// Draw a thick line
function drawLine(canvas, x0, y0, x1, y1, thickness, R, G, B) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    fillCircle(canvas, x, y, Math.ceil(thickness / 2), R, G, B);
  }
}

// ─── Draw alarm-clock icon ──────────────────────────────────────────────────

function drawAlarmClock(size) {
  const canvas = createCanvas(size);
  const s = size / 32; // scale factor relative to 32px reference

  const cx = size / 2;
  // Clock face — shift slightly upward to leave room for feet
  const cy = size * 0.45;
  const faceR = Math.round(size * 0.35);

  // White background fill (already done in createCanvas)

  // Bell body (filled circle)
  fillCircle(canvas, cx, cy, faceR, 30, 30, 30);

  // White inner face
  fillCircle(canvas, cx, cy, faceR - Math.ceil(s * 2.5), 255, 255, 255);

  // Clock hands
  const handR = faceR - Math.ceil(s * 5);
  // Hour hand (pointing ~10 o'clock)
  const hourAngle = -Math.PI / 2 - Math.PI / 4;
  drawLine(
    canvas,
    cx, cy,
    cx + Math.cos(hourAngle) * handR * 0.55,
    cy + Math.sin(hourAngle) * handR * 0.55,
    Math.max(1, Math.round(s * 2)),
    30, 30, 30
  );

  // Minute hand (pointing ~12 o'clock)
  const minAngle = -Math.PI / 2;
  drawLine(
    canvas,
    cx, cy,
    cx + Math.cos(minAngle) * handR * 0.8,
    cy + Math.sin(minAngle) * handR * 0.8,
    Math.max(1, Math.round(s * 1.5)),
    30, 30, 30
  );

  // Center dot
  fillCircle(canvas, cx, cy, Math.max(1, Math.round(s * 1.5)), 30, 30, 30);

  // Bell top (small bump)
  const bellTopY = cy - faceR - Math.round(s * 1);
  fillCircle(canvas, cx, bellTopY, Math.max(1, Math.round(s * 2.5)), 30, 30, 30);

  // Alarm ears (left and right bumps on the clock body)
  const earR = Math.max(1, Math.round(s * 3));
  const earY = cy - Math.round(faceR * 0.6);
  fillCircle(canvas, cx - Math.round(faceR * 0.85), earY, earR, 30, 30, 30);
  fillCircle(canvas, cx + Math.round(faceR * 0.85), earY, earR, 30, 30, 30);

  // Feet (two small circles at the bottom)
  const footR = Math.max(1, Math.round(s * 2));
  const footY = cy + faceR + footR;
  fillCircle(canvas, cx - Math.round(s * 5), footY, footR, 30, 30, 30);
  fillCircle(canvas, cx + Math.round(s * 5), footY, footR, 30, 30, 30);

  return canvas;
}

// ─── ICO encoding ──────────────────────────────────────────────────────────

/**
 * Encode one image as a BMP DIB (Device Independent Bitmap) as used inside ICO.
 * The ICO BMP is a BITMAPV3INFOHEADER (40 bytes) followed by pixel data
 * stored bottom-up, then an AND mask.
 */
function encodeBmpDib(canvas) {
  const { data, size } = canvas;

  const headerSize  = 40;
  const pixelStride = size * 4;                   // BGRA
  const pixelBytes  = pixelStride * size;
  const maskStride  = Math.ceil(size / 8) * 4;    // 1 bpp AND mask, DWORD-aligned per row
  const maskBytes   = maskStride * size;
  const totalSize   = headerSize + pixelBytes + maskBytes;

  const buf = Buffer.alloc(totalSize, 0);
  let offset = 0;

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, offset);          offset += 4;  // biSize
  buf.writeInt32LE(size, offset);         offset += 4;  // biWidth
  buf.writeInt32LE(size * 2, offset);     offset += 4;  // biHeight (doubled for ICO — includes AND mask)
  buf.writeUInt16LE(1, offset);           offset += 2;  // biPlanes
  buf.writeUInt16LE(32, offset);          offset += 2;  // biBitCount (32 bpp BGRA)
  buf.writeUInt32LE(0, offset);           offset += 4;  // biCompression (BI_RGB)
  buf.writeUInt32LE(pixelBytes, offset);  offset += 4;  // biSizeImage
  buf.writeInt32LE(0, offset);            offset += 4;  // biXPelsPerMeter
  buf.writeInt32LE(0, offset);            offset += 4;  // biYPelsPerMeter
  buf.writeUInt32LE(0, offset);           offset += 4;  // biClrUsed
  buf.writeUInt32LE(0, offset);           offset += 4;  // biClrImportant

  // Pixel data — bottom-up row order, BGRA
  for (let row = size - 1; row >= 0; row--) {
    for (let col = 0; col < size; col++) {
      const src = (row * size + col) * 4;
      buf[offset++] = data[src + 2]; // B
      buf[offset++] = data[src + 1]; // G
      buf[offset++] = data[src + 0]; // R
      buf[offset++] = data[src + 3]; // A
    }
  }

  // AND mask — all zeros (fully opaque; transparency handled by alpha channel)
  // Already zeroed by Buffer.alloc

  return buf;
}

/**
 * Wrap multiple BMP DIBs into an ICO container.
 * https://en.wikipedia.org/wiki/ICO_(file_format)
 */
function buildIco(images) {
  // images: array of { size, bmpDib }
  const n = images.length;

  // ICO header = 6 bytes
  // ICONDIRENTRY per image = 16 bytes
  const dirSize = 6 + n * 16;

  // Calculate offsets
  let dataOffset = dirSize;
  const entries = images.map(img => {
    const entry = { size: img.size, bmpDib: img.bmpDib, offset: dataOffset };
    dataOffset += img.bmpDib.length;
    return entry;
  });

  const totalSize = dataOffset;
  const buf = Buffer.alloc(totalSize);
  let pos = 0;

  // ICONDIR header
  buf.writeUInt16LE(0, pos);    pos += 2; // reserved
  buf.writeUInt16LE(1, pos);    pos += 2; // type = 1 (ICO)
  buf.writeUInt16LE(n, pos);    pos += 2; // count

  // ICONDIRENTRY for each image
  for (const e of entries) {
    const sz = e.size >= 256 ? 0 : e.size; // 0 means 256
    buf.writeUInt8(sz, pos++);        // width
    buf.writeUInt8(sz, pos++);        // height
    buf.writeUInt8(0, pos++);         // color count (0 = more than 256)
    buf.writeUInt8(0, pos++);         // reserved
    buf.writeUInt16LE(1, pos); pos += 2; // color planes
    buf.writeUInt16LE(32, pos); pos += 2; // bit count
    buf.writeUInt32LE(e.bmpDib.length, pos); pos += 4; // bytes in image
    buf.writeUInt32LE(e.offset, pos); pos += 4; // offset
  }

  // Image data
  for (const e of entries) {
    e.bmpDib.copy(buf, e.offset);
  }

  return buf;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const sizes = [32, 16];
const images = sizes.map(size => {
  const canvas = drawAlarmClock(size);
  const bmpDib = encodeBmpDib(canvas);
  return { size, bmpDib };
});

const icoBuf = buildIco(images);
const outPath = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.writeFileSync(outPath, icoBuf);
console.log(`Written ${icoBuf.length} bytes to ${outPath}`);
