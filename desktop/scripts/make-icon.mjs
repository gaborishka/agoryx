#!/usr/bin/env node
// The app icon: the Agoryx mark (ui/src/components/brand/Mark.tsx) in white on an ink tile, as the UI's
// icons (ui/scripts/make-icons.mjs), drawn here so the repo
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
// The mark (a 24-unit viewBox), scaled and centred on the tile.
const UNIT = 27;
const CENTER = { x: 12, y: 12 };
const HALF_A = [[2.5, 2.5], [6.525, 2.5], [10.525, 6.5], [7, 6.5], [7, 17.5], [11, 17.5], [15, 21.5], [2.5, 21.5]];
const HALF_B = HALF_A.map(([x, y]) => [24 - x, 24 - y]);

// One tile for both themes: ink (--meet, light theme) and the mark in white.
const GROUND = [0x0a, 0x0a, 0x0a];
const MARK_INK = [0xff, 0xff, 0xff];

/** Signed distance to a polygon (negative inside), after Inigo Quilez. */
const polygon = (points) => (px, py) => {
  let d = Infinity;
  let sign = 1;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    const ex = bx - ax;
    const ey = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(wx - ex * t, wy - ey * t));
    const c = [py >= ay, py < by, ex * wy > ey * wx];
    if (c.every(Boolean) || c.every((v) => !v)) sign = -sign;
  }
  return sign * d;
};

/** The mark's shapes at `unit` canvas units per mark unit, as distance functions on the canvas. */
const markAt = (unit) => {
  const place = (points) => points.map(([x, y]) => [512 + (x - CENTER.x) * unit, 512 + (y - CENTER.y) * unit]);
  const a = polygon(place(HALF_A));
  const b = polygon(place(HALF_B));
  return (px, py) => Math.min(a(px, py), b(px, py));
};

const roundedRect = (px, py) => {
  const half = TILE.size / 2;
  const qx = Math.abs(px - (TILE.x + half)) - (half - TILE.radius);
  const qy = Math.abs(py - (TILE.y + half)) - (half - TILE.radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - TILE.radius;
};

/** A signed distance (canvas units) → how much of a pixel of this size it covers. */
const coverage = (distance, scale) => Math.min(1, Math.max(0, 0.5 - distance * scale));

const mix = (under, over, amount) => under.map((c, i) => c + (over[i] - c) * amount);
const mark = markAt(UNIT);

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
      const colour = mix(GROUND, MARK_INK, coverage(mark(px, py), scale));
      const offset = row + 1 + x * 4;
      for (let c = 0; c < 3; c += 1) rows[offset + c] = Math.round(colour[c]);
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
