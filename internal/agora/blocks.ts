/**
 * Live code blocks: an agent writes an ```html or ```svg fence in a message (or
 * a table proposal) and everyone sees it rendered. The page cannot run inline
 * scripts under its own CSP, so the daemon serves each block as a sandboxed
 * document of its own, found by a hash of its body. web/app.js computes the
 * same hash (keep `blockHash` in sync with `hashBlock` there).
 */

export const LIVE_LANGS: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  svg: "image/svg+xml",
};

export interface LiveBlock {
  lang: string;
  body: string;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;

const scan = (lines: string[], out: LiveBlock[]): void => {
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const close = new RegExp(`^\\s*${open[1]}\\s*$`);
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
    const lang = open[2]!.toLowerCase();
    if (LIVE_LANGS[lang]) out.push({ lang, body: body.join("\n") });
  }
};

/** Every html/svg fence in a markdown text, including ones quoted with ">". */
export const liveBlocks = (text: string): LiveBlock[] => {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: LiveBlock[] = [];
  scan(lines, out);
  const quoted = lines.filter((line) => /^\s*>/.test(line)).map((line) => line.replace(/^\s*>\s?/, ""));
  if (quoted.length) scan(quoted, out);
  return out;
};

/** cyrb53 — a small, fast 53-bit string hash; stable across Node and browsers. */
export const blockHash = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

export const findLiveBlock = (text: string, hash: string): LiveBlock | undefined =>
  liveBlocks(text).find((block) => blockHash(block.body) === hash);
