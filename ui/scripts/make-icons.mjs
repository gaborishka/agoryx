#!/usr/bin/env node
// The page's icons for a phone's home screen (the PWA manifest, iOS) and for notifications: the
// favicon's mark (three dots) on a sage tile, as the desktop app's icon (desktop/scripts/make-icon.mjs),
// drawn here so the repo carries no binary. Writes public/icons/*.png; does nothing when they are
// newer than this script.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const script = fileURLToPath(import.meta.url);
const out = join(dirname(script), "..", "public", "icons");

/**
 * - tile: a rounded tile on transparency (the manifest's "any");
 * - bleed: the ground to the edges, the mark inside the maskable safe zone (Android masks it; iOS rounds it);
 * - badge: white dots on transparency (Android's status bar draws it in one colour).
 */
const ICONS = [
  { file: "icon-192.png", size: 192, look: "tile" },
  { file: "icon-512.png", size: 512, look: "tile" },
  { file: "icon-maskable-512.png", size: 512, look: "bleed" },
  { file: "apple-touch-icon.png", size: 180, look: "bleed" },
  { file: "badge-96.png", size: 96, look: "badge" },
];

const newer = (file) => existsSync(file) && statSync(file).mtimeMs > statSync(script).mtimeMs;
if (ICONS.every((icon) => newer(join(out, icon.file)))) process.exit(0);

// On a 1024 canvas. The tile after Apple's icon grid; the dots from the favicon's 24-unit viewBox.
const TILE = { x: 100, y: 100, size: 824, radius: 185 };
const CENTER = { x: 12, y: 11.25 };
const dotsAt = (unit) =>
  [
    [12, 5.5],
    [5.5, 17],
    [18.5, 17],
  ].map(([x, y]) => ({ x: 512 + (x - CENTER.x) * unit, y: 512 + (y - CENTER.y) * unit, r: 3.2 * unit }));

// ui/src/index.css: --primary, a shade lighter at the top, and the stone --background for the dots.
const TOP = [0x3a, 0x6b, 0x56];
const BOTTOM = [0x2a, 0x52, 0x41];
const DOT = [0xf3, 0xf4, 0xef];

const roundedRect = (px, py) => {
  const half = TILE.size / 2;
  const qx = Math.abs(px - (TILE.x + half)) - (half - TILE.radius);
  const qy = Math.abs(py - (TILE.y + half)) - (half - TILE.radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - TILE.radius;
};

/** A signed distance (canvas units) → how much of a pixel of this size it covers. */
const coverage = (distance, scale) => Math.min(1, Math.max(0, 0.5 - distance * scale));

const draw = (size, look) => {
  const scale = size / 1024;
  // The maskable safe zone is the middle 80%: the mark stays well inside it.
  const dots = dotsAt(look === "tile" ? 26.5 : look === "bleed" ? 24 : 38);
  const circles = (px, py) => Math.min(...dots.map((dot) => Math.hypot(px - dot.x, py - dot.y) - dot.r));
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    rows[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) / scale;
      const py = (y + 0.5) / scale;
      const offset = row + 1 + x * 4;
      const dot = coverage(circles(px, py), scale);
      if (look === "badge") {
        rows.fill(255, offset, offset + 3);
        rows[offset + 3] = Math.round(dot * 255);
        continue;
      }
      const ground = look === "tile" ? coverage(roundedRect(px, py), scale) : 1;
      if (ground === 0) continue;
      const t = look === "tile" ? Math.min(1, Math.max(0, (py - TILE.y) / TILE.size)) : py / 1024;
      for (let c = 0; c < 3; c += 1) {
        const shade = TOP[c] + (BOTTOM[c] - TOP[c]) * t;
        rows[offset + c] = Math.round(shade + (DOT[c] - shade) * dot);
      }
      rows[offset + 3] = Math.round(ground * 255);
    }
  }
  return encodePng(size, rows);
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const encodePng = (size, rows) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

mkdirSync(out, { recursive: true });
for (const icon of ICONS) writeFileSync(join(out, icon.file), draw(icon.size, icon.look));
