import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/**
 * The web UI's files as the daemon sends them. A built file under `assets/` has its content's hash in its name, so a
 * browser keeps it for good; everything else (the page, the service worker, the manifest) is asked again each time.
 * Text is sent compressed when the browser takes it — brotli, else gzip — and compressed once per file version.
 */

export type Encoding = "br" | "gzip" | null;

/** Worth compressing: text. Images, fonts and media are compressed already. */
const TEXT = new Set([".html", ".htm", ".js", ".mjs", ".css", ".svg", ".json", ".webmanifest", ".txt", ".md", ".csv", ".map"]);

/** Smaller than this goes as it is: the headers would cost about as much. */
const MIN_SIZE = 1024;

/** The encoding to send `file` with, given the request's Accept-Encoding. */
export const pickEncoding = (file: string, size: number, accept: string | undefined): Encoding => {
  if (!accept || size < MIN_SIZE || !TEXT.has(extname(file).toLowerCase())) return null;
  const offered = new Map<string, number>();
  for (const part of accept.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean);
    if (name) offered.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  const takes = (name: string) => (offered.get(name) ?? offered.get("*") ?? 0) > 0;
  return takes("br") ? "br" : takes("gzip") ? "gzip" : null;
};

/** A built file whose name carries its content's hash: it never changes under that name. */
export const isHashedAsset = (relative: string): boolean => relative.startsWith("assets/");

export const cacheControl = (relative: string): string =>
  relative === "index.html" ? "no-store" : isHashedAsset(relative) ? "public, max-age=31536000, immutable" : "no-cache";

const compressedCache = new Map<string, { mtimeMs: number; size: number; body: Buffer }>();

/** The file's bytes in `encoding`, compressed once per version of the file (its mtime and size). */
export const staticBody = (full: string, encoding: Encoding): Buffer => {
  if (!encoding) return readFileSync(full);
  const stat = statSync(full);
  const key = `${encoding}:${full}`;
  const cached = compressedCache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.body;
  const raw = readFileSync(full);
  const body =
    encoding === "br"
      ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      : gzipSync(raw, { level: 9 });
  compressedCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, body });
  return body;
};
