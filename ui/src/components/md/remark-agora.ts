// Turns "@claude" and table refs ("P3", "Q1") in plain text into links the
// renderer recognises (#@claude, #~P3). The renderer decides whether they are
// real — an unknown handle or a ref not on the table falls back to plain text.

type Node = { type: string; value?: string; url?: string; children?: Node[] };

const PATTERN = /(^|[^\w@])@([a-z][\w-]{1,30})\b|\b([QPDNXSF]\d{1,3})\b/gi;
const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "html", "definition"]);

const split = (value: string): Node[] | null => {
  const out: Node[] = [];
  let last = 0;
  PATTERN.lastIndex = 0;
  for (let m = PATTERN.exec(value); m; m = PATTERN.exec(value)) {
    if (m[2]) {
      const start = m.index + m[1]!.length;
      if (start > last) out.push({ type: "text", value: value.slice(last, start) });
      out.push({ type: "link", url: `#@${m[2].toLowerCase()}`, children: [{ type: "text", value: `@${m[2]}` }] });
      last = start + m[2].length + 1;
    } else if (m[3] && m[3] === m[3].toUpperCase()) {
      if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
      out.push({ type: "link", url: `#~${m[3]}`, children: [{ type: "text", value: m[3] }] });
      last = m.index + m[3].length;
    }
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
};

const walk = (node: Node) => {
  if (!node.children || SKIP.has(node.type)) return;
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const parts = split(child.value);
      if (parts) {
        next.push(...parts);
        continue;
      }
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
};

export const remarkAgora = () => (tree: Node) => walk(tree);
