import { nativeImage, type NativeImage } from "electron";
import { deflateSync } from "node:zlib";

/**
 * The menu-bar icon: the favicon's three-dot mark at 18 pt (36×36 px), black with alpha, as a template
 * image so macOS paints it for a light or dark menu bar. `dot`: the mark a little smaller, and a solid
 * badge circle at the top right with a transparent ring around it — a room waits. Drawn in memory like
 * desktop/scripts/make-icon.mjs draws the app icon, so the repo carries no binary.
 */

const SIZE = 36;
/** The favicon's circles, on its 24-unit viewBox. */
const MARK = [
  [12, 5.5],
  [5.5, 17],
  [18.5, 17],
] as const;
const MARK_RADIUS = 3.2;
const MARK_CENTER = { x: 12, y: 11.25 };

interface Circle {
  x: number;
  y: number;
  r: number;
}

/** The mark's circles in pixels: `unit` pixels per favicon unit, centred on (cx, cy). */
const markCircles = (unit: number, cx: number, cy: number): Circle[] =>
  MARK.map(([x, y]) => ({ x: cx + (x - MARK_CENTER.x) * unit, y: cy + (y - MARK_CENTER.y) * unit, r: MARK_RADIUS * unit }));

const distance = (circles: Circle[], px: number, py: number): number =>
  Math.min(...circles.map((circle) => Math.hypot(px - circle.x, py - circle.y) - circle.r));

/** A signed distance in pixels → how much of the pixel it covers. */
const coverage = (d: number): number => Math.min(1, Math.max(0, 0.5 - d));

const draw = (dot: boolean): Buffer => {
  const unit = dot ? 1.3 : 1.5;
  const mark = dot ? markCircles(unit, 16, 20) : markCircles(unit, SIZE / 2, SIZE / 2);
  const badge: Circle = { x: 28.5, y: 7.5, r: 6 };
  // One favicon unit of clear space between the badge and the mark.
  const ring: Circle = { ...badge, r: badge.r + unit };
  const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    const row = y * (SIZE * 4 + 1);
    rows[row] = 0; // filter: none
    for (let x = 0; x < SIZE; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let alpha = coverage(distance(mark, px, py));
      if (dot) {
        alpha *= 1 - coverage(distance([ring], px, py));
        alpha = Math.max(alpha, coverage(distance([badge], px, py)));
      }
      rows[row + 1 + x * 4 + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(SIZE, rows);
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buffer: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const encodePng = (size: number, rows: Buffer): Buffer => {
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

const cache = new Map<boolean, NativeImage>();

/** The tray's image; `dot` while any room waits. */
export const trayImage = (dot: boolean): NativeImage => {
  const cached = cache.get(dot);
  if (cached) return cached;
  const image = nativeImage.createFromBuffer(draw(dot), { scaleFactor: 2 });
  image.setTemplateImage(true);
  cache.set(dot, image);
  return image;
};

/** The PNG itself, for a look at it outside the app. */
export const trayPng = draw;
