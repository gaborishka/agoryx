#!/usr/bin/env node
// The app icon: the UI's favicon mark (three dots) on a sage tile, drawn here so the repo
// carries no binary. Writes build/icon.png (1024², the Dock icon in dev) and build/icon.icns (the
// packaged app's, with macOS's iconutil). Does nothing when both are newer than this script.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const script = fileURLToPath(import.meta.url);
const out = join(dirname(script), "..", "build");
const png = join(out, "icon.png");
const icns = join(out, "icon.icns");

const newer = (file) => existsSync(file) && statSync(file).mtimeMs > statSync(script).mtimeMs;
if (newer(png) && (newer(icns) || process.platform !== "darwin")) process.exit(0);

// Geometry on a 1024 canvas, after Apple's icon grid: an 824² tile with a 185 corner radius.
const TILE = { x: 100, y: 100, size: 824, radius: 185 };
// The favicon's circles (a 24-unit viewBox), scaled and centred on the tile.
const UNIT = 26.5;
const CENTER = { x: 12, y: 11.25 };
const DOTS = [
  [12, 5.5],
  [5.5, 17],
  [18.5, 17],
].map(([x, y]) => ({ x: 512 + (x - CENTER.x) * UNIT, y: 512 + (y - CENTER.y) * UNIT, r: 3.2 * UNIT }));

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

const circles = (px, py) => Math.min(...DOTS.map((dot) => Math.hypot(px - dot.x, py - dot.y) - dot.r));

/** A signed distance (canvas units) → how much of a pixel of this size it covers. */
const coverage = (distance, scale) => Math.min(1, Math.max(0, 0.5 - distance * scale));

const draw = (size) => {
  const scale = size / 1024;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    rows[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) / scale;
      const py = (y + 0.5) / scale;
      const tile = coverage(roundedRect(px, py), scale);
      if (tile === 0) continue;
      const dot = coverage(circles(px, py), scale);
      const t = Math.min(1, Math.max(0, (py - TILE.y) / TILE.size));
      const offset = row + 1 + x * 4;
      for (let c = 0; c < 3; c += 1) {
        const ground = TOP[c] + (BOTTOM[c] - TOP[c]) * t;
        rows[offset + c] = Math.round(ground + (DOT[c] - ground) * dot);
      }
      rows[offset + 3] = Math.round(tile * 255);
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
writeFileSync(png, draw(1024));

if (process.platform === "darwin") {
  const iconset = join(out, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), draw(base));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), draw(base * 2));
  }
  const result = spawnSync("iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "inherit" });
  rmSync(iconset, { recursive: true, force: true });
  if (result.status !== 0) {
    console.warn("make-icon: iconutil failed; the packaged app keeps Electron's icon");
  }
}
