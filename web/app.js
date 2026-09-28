// Agoryx web UI — a thin view over the local daemon. The daemon owns the room
// (event log, projection, agents); this page renders snapshots + SSE patches.
//
// Layout: rooms on the left, the conversation in the middle, and the room's
// table / canonical file in a panel on the right, next to the conversation.

const root = document.getElementById("root");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const clock = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const fullDate = (iso) => new Date(iso).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" });

const secs = (ms) => {
  if (ms == null) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} хв ${String(s % 60).padStart(2, "0")} с`;
};

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

const ago = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "щойно";
  if (diff < 3600) return `${Math.floor(diff / 60)} хв`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} год`;
  return new Date(iso).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
};

const shortPath = (path) => {
  const parts = String(path).split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
};

const ext = (path) => {
  const m = /\.([a-z0-9]+)$/i.exec(path ?? "");
  return m ? m[1].toLowerCase() : "";
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"]);
const FRAME_EXT = new Set(["html", "htm", "pdf"]);

const svg = (body, { fill = false, w = 1.7 } = {}) =>
  `<svg viewBox="0 0 20 20" ${fill ? 'fill="currentColor"' : `fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`} aria-hidden="true">${body}</svg>`;

const ICON = {
  brand:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.5" r="3.2"/><circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M12 11.5 8 16h8z" opacity=".35"/></svg>',
  claude:
    '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M10 3v14M3.9 6.5l12.2 7M3.9 13.5l12.2-7"/></svg>',
  codex:
    '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5 3 10l4 5M13 5l4 5-4 5"/></svg>',
  menu: svg('<path d="M3 6h14M3 10h14M3 14h14"/>', { w: 1.8 }),
  plus: svg('<path d="M10 4v12M4 10h12"/>', { w: 1.8 }),
  send: svg('<path d="M10 16V4M5 9l5-5 5 5"/>', { w: 2 }),
  stop: svg('<rect x="5" y="5" width="10" height="10" rx="2"/>', { fill: true }),
  x: svg('<path d="m5 5 10 10M15 5 5 15"/>', { w: 1.8 }),
  dots: svg('<circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15.5" cy="10" r="1.5"/>', { fill: true }),
  table: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M2.5 8h15M8 8v8.5"/>'),
  doc: svg('<path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4M7.5 10.5h5M7.5 13.5h5"/>'),
  folder: svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.5l2 2H16A1.5 1.5 0 0 1 17.5 8v6.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  terminal: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="m6 8 2.5 2L6 12M10.5 12.5H14"/>'),
  gear: svg('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7"/>'),
  expand: svg('<path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5l-5 5M3.5 16.5l5-5"/>'),
  shrink: svg('<path d="M16.5 8H12V3.5M3.5 12H8v4.5M12 8l4.5-4.5M8 12l-4.5 4.5"/>'),
  q: svg('<circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.4v.4M10 14.2v.1"/>', { w: 1.8 }),
  pin: svg('<path d="m4 10.5 4 4 8-9"/>', { w: 1.8 }),
  step: svg('<path d="M4 10h11M11 6l4 4-4 4"/>', { w: 1.8 }),
  down: svg('<path d="M10 4v12M5 11l5 5 5-5"/>', { w: 1.9 }),
  file: svg('<path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/>', { w: 1.6 }),
  sun: svg('<circle cx="10" cy="10" r="3.2"/><path d="M10 2v1.8M10 16.2V18M2 10h1.8M16.2 10H18M4.3 4.3l1.3 1.3M14.4 14.4l1.3 1.3M4.3 15.7l1.3-1.3M14.4 5.6l1.3-1.3"/>'),
  moon: svg('<path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z"/>'),
  auto: svg('<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor"/>'),
  help: svg('<circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.4v.4M10 14.2v.1"/>'),
};

// ---------------------------------------------------------------------------
// Rich content: what agents show, not only say. Code is highlighted, ```mermaid
// becomes a diagram, ```html / ```svg and embedded workspace files render live
// in a sandbox (served by the daemon on an opaque origin — see blocks.ts).
// ---------------------------------------------------------------------------

/** cyrb53 — must match blockHash in internal/agora/blocks.ts. */
const hashBlock = (text) => {
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

const rawUrl = (path) => `${S.snap?.rawBase ?? ""}${String(path).split("/").map(encodeURIComponent).join("/")}`;

/** A path an agent wrote (relative, ./relative, or absolute inside the workspace) → workspace-relative, or null. */
const workspaceRel = (path) => {
  const st = state();
  if (!st || !path || /^[a-z]+:/i.test(path) || path.startsWith("#")) return null;
  let rel = path;
  if (rel.startsWith("/")) {
    if (!rel.startsWith(`${st.workspace}/`)) return null;
    rel = rel.slice(st.workspace.length + 1);
  }
  rel = rel.replace(/^\.\//, "").split(/[?#]/)[0];
  if (!rel || rel.split("/").includes("..")) return null;
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
};

// --- syntax highlighting (a small tokenizer, not a parser) ------------------

const KEYWORDS = new Set(
  (
    "abstract and as assert async await break case catch class const continue def default del delete do elif else enum except export extends " +
    "false final finally fn for from func function go if impl implements import in instanceof interface is lambda let loop match mod module " +
    "mut new nil none not null of or package pass private protected pub public raise return self select static struct super switch " +
    "this throw throws trait true try type typeof undefined union unless use val var void when where while with yield " +
    "None True False echo then fi done esac local readonly"
  ).split(" "),
);
const SQL_KEYWORDS = new Set(
  "select from where join left right inner outer on group by order having limit offset insert into values update set delete create table index alter drop and or not null as distinct union all case when then else end primary key references default".split(" "),
);
const HASH_COMMENT = new Set(["py", "python", "sh", "bash", "zsh", "shell", "rb", "ruby", "yaml", "yml", "toml", "r", "perl", "make", "makefile", "dockerfile", "conf", "ini", "nix"]);
const DASH_COMMENT = new Set(["sql", "lua", "haskell", "hs"]);
const NO_HIGHLIGHT = new Set(["", "text", "txt", "plain", "plaintext", "output", "log", "console"]);

const highlight = (src, lang) => {
  if (NO_HIGHLIGHT.has(lang)) return esc(src);
  if (lang === "diff" || lang === "patch") {
    return src
      .split("\n")
      .map((l) => {
        const cls = /^\+(?!\+\+)/.test(l) ? "tk-add" : /^-(?!--)/.test(l) ? "tk-del" : /^@@/.test(l) ? "tk-hunk" : "";
        return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
      })
      .join("\n");
  }
  if (lang === "json" || lang === "jsonc") {
    return esc(src).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(true|false|null)\b/gi, (m, str, colon, num, lit) => {
      if (str) return `<span class="${colon ? "tk-a" : "tk-s"}">${str}</span>${colon ?? ""}`;
      if (num) return `<span class="tk-n">${num}</span>`;
      return `<span class="tk-k">${lit}</span>`;
    });
  }
  if (lang === "html" || lang === "xml" || lang === "svg" || lang === "htm" || lang === "vue") {
    return esc(src)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tk-c">$1</span>')
      .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="tk-t">$2</span>')
      .replace(/([\w:-]+)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="tk-a">$1</span>$2<span class="tk-s">$3</span>');
  }
  const comment = HASH_COMMENT.has(lang) ? "#[^\\n]*" : DASH_COMMENT.has(lang) ? "--[^\\n]*" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  const words = lang === "sql" ? SQL_KEYWORDS : KEYWORDS;
  const token = new RegExp(
    `(${comment})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?|0x[\\da-f]+)\\b|\\b([A-Za-z_$][\\w$]*)\\b(?=\\s*\\()|\\b([A-Za-z_$][\\w$]*)\\b`,
    "gi",
  );
  let out = "";
  let last = 0;
  for (const m of src.matchAll(token)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    const [text, com, str, num, fn, word] = m;
    if (com) out += `<span class="tk-c">${esc(text)}</span>`;
    else if (str) out += `<span class="tk-s">${esc(text)}</span>`;
    else if (num) out += `<span class="tk-n">${esc(text)}</span>`;
    else if (fn) out += words.has(lang === "sql" ? fn.toLowerCase() : fn) ? `<span class="tk-k">${esc(text)}</span>` : `<span class="tk-f">${esc(text)}</span>`;
    else if (word && words.has(lang === "sql" ? word.toLowerCase() : word)) out += `<span class="tk-k">${esc(text)}</span>`;
    else if (word && /^[A-Z][a-z0-9]+[A-Z]?\w*$/.test(word)) out += `<span class="tk-t">${esc(text)}</span>`;
    else out += esc(text);
  }
  return out + esc(src.slice(last));
};

const LANG_LABEL = { js: "JavaScript", ts: "TypeScript", tsx: "TSX", jsx: "JSX", py: "Python", python: "Python", sh: "Shell", bash: "Shell", html: "HTML", css: "CSS", json: "JSON", sql: "SQL", go: "Go", rs: "Rust", rust: "Rust", diff: "Diff", yaml: "YAML", md: "Markdown", mermaid: "Mermaid", svg: "SVG" };

const codeBlock = (lang, src) =>
  `<div class="codeblk"><div class="cbar"><span>${esc(LANG_LABEL[lang] ?? (lang || "код"))}</span><button class="cbtn" data-act="copy" data-text="${esc(src)}">Копіювати</button></div><pre><code>${highlight(src, lang)}</code></pre></div>`;

// --- mermaid: loaded on first use, rendered once per source and theme ------

const MMD = { lib: null, loading: null, cache: new Map(), pending: new Map(), seq: 0 };

const darkTheme = () => {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
const mmdKey = (src) => `${darkTheme() ? "d" : "l"}:${hashBlock(src)}`;

const diagramHtml = (src) => {
  const key = mmdKey(src);
  const done = MMD.cache.get(key);
  if (!done) MMD.pending.set(key, src);
  return `<figure class="viz mmd" data-mmd="${esc(key)}">${done ?? '<div class="viz-wait">Малюю діаграму…</div>'}<details class="vsrc"><summary>Код діаграми</summary>${codeBlock("mermaid", src)}</details></figure>`;
};

const loadMermaid = () => {
  if (MMD.lib) return Promise.resolve(MMD.lib);
  MMD.loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/mermaid.min.js";
    script.onload = () => resolve((MMD.lib = window.mermaid));
    script.onerror = () => reject(new Error("mermaid не завантажився"));
    document.head.append(script);
  });
  return MMD.loading;
};

/** Render every diagram still waiting on the page, then put each where it belongs. */
const hydrateDiagrams = async () => {
  if (!MMD.pending.size) return;
  const jobs = [...MMD.pending];
  MMD.pending.clear();
  let lib;
  try {
    lib = await loadMermaid();
  } catch (error) {
    for (const [key] of jobs) MMD.cache.set(key, `<div class="viz-err">${esc(error.message)}</div>`);
    return;
  }
  for (const [key, src] of jobs) {
    if (MMD.cache.has(key)) continue;
    const dark = key.startsWith("d:");
    lib.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      fontFamily: "Onest, system-ui, sans-serif",
      themeVariables: { fontSize: "14px" },
    });
    try {
      const { svg: out } = await lib.render(`mmd-${(MMD.seq += 1)}`, src);
      MMD.cache.set(key, `<div class="mmd-svg">${out}</div>`);
    } catch (error) {
      MMD.cache.set(key, `<div class="viz-err">Діаграма не малюється: ${esc(String(error?.message ?? error).split("\n")[0].slice(0, 200))}</div>`);
      document.querySelectorAll(`[id^="dmmd-"]`).forEach((n) => n.remove());
    }
    const pinned = els.feed && distanceFromBottom() < 200;
    for (const node of document.querySelectorAll(`[data-mmd="${CSS.escape(key)}"]`)) {
      const wait = node.querySelector(".viz-wait, .mmd-svg, .viz-err");
      const holder = document.createElement("div");
      holder.innerHTML = MMD.cache.get(key);
      if (wait) wait.replaceWith(holder.firstElementChild);
      const owner = node.closest("[data-key]");
      if (owner) owner.__html = null; // re-render next time instead of keeping the placeholder
    }
    if (pinned) els.feed.scrollTop = els.feed.scrollHeight;
  }
};

// --- live frames -----------------------------------------------------------

const frameHtml = ({ url, label, path, kind = "html" }) =>
  `<figure class="viz vlive" data-kind="${esc(kind)}">
    <div class="vbar"><span class="vk">${esc(label)}</span>${path ? `<span class="mono ell vpath">${esc(path)}</span>` : ""}<span class="grow"></span><a class="cbtn" href="${esc(url)}" target="_blank" rel="noopener">На весь екран</a></div>
    <iframe src="${esc(url)}" sandbox="allow-scripts allow-forms allow-modals allow-popups" loading="lazy" title="${esc(path ?? label)}"></iframe>
  </figure>`;

/** An ```html / ```svg fence: live when the room serves it (it has a source), highlighted code otherwise. */
const liveBlock = (lang, src, ctx) => {
  if (!ctx?.source || !S.snap?.rawBase) return codeBlock(lang, src);
  const url = `${S.snap.rawBase}~block/${encodeURIComponent(ctx.source)}/${hashBlock(src)}`;
  if (lang === "svg") {
    return `<figure class="viz pic"><img src="${esc(url)}" alt="SVG" loading="lazy"><details class="vsrc"><summary>Код</summary>${codeBlock(lang, src)}</details></figure>`;
  }
  return frameHtml({ url, label: "HTML" }).replace("</figure>", `<details class="vsrc"><summary>Код</summary>${codeBlock(lang, src)}</details></figure>`);
};

/** ![caption](src): an image, a live page, or a file card. */
const embedHtml = (src, alt) => {
  if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) {
    return `<span class="embed pic"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">${alt ? `<span class="cap">${esc(alt)}</span>` : ""}</span>`;
  }
  const rel = workspaceRel(src);
  if (!rel || !S.snap?.rawBase) return `<code>${esc(alt || src)}</code>`;
  const kind = ext(rel);
  if (IMAGE_EXT.has(kind)) {
    return `<span class="embed pic"><button class="pic-btn" data-act="file" data-path="${esc(rel)}" title="${esc(rel)}"><img src="${esc(rawUrl(rel))}" alt="${esc(alt || rel)}" loading="lazy"></button>${alt ? `<span class="cap">${esc(alt)}</span>` : ""}</span>`;
  }
  if (FRAME_EXT.has(kind)) {
    return `<span class="embed">${frameHtml({ url: rawUrl(rel), label: alt || (kind === "pdf" ? "PDF" : "HTML"), path: rel, kind })}</span>`;
  }
  return `<button class="fileline" data-act="file" data-path="${esc(rel)}">${ICON.file}<span class="mono ell">${esc(alt || rel)}</span><span class="go">відкрити</span></button>`;
};

// ---------------------------------------------------------------------------
// Markdown (escape first, then a safe subset plus the rich blocks above)
// ---------------------------------------------------------------------------

const inline = (raw, ctx) => {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(raw).replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/!\[([^\]\n]*)\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)/g, (_, alt, src) => keep(embedHtml(src, alt)));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) =>
    keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`),
  );
  // Links an agent writes to a workspace file (absolute or relative): open the file here.
  s = s.replace(/\[([^\]\n]+)\]\(<?([^\s)>]+)>?\)/g, (m, text, path) => {
    const rel = workspaceRel(path);
    return keep(rel ? `<button class="flink" data-act="file" data-path="${esc(rel)}">${esc(text)}</button>` : `<code>${esc(text)}</code>`);
  });
  s = s.replace(/\bhttps?:\/\/[^\s<>()"'\u0000]+[^\s<>()"'.,;:!?\u0000]/g, (url) =>
    keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`),
  );
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^\w@])@([a-z][\w-]*)/gi, (m, pre, name) => {
    const who = ctx?.participant?.(name.toLowerCase());
    if (!who) return m;
    return `${pre}<span class="at ${who.cls}">@${esc(name)}</span>`;
  });
  s = s.replace(/\b([QPDNXSF]\d{1,3})\b/g, (m) => (ctx?.refs?.has(m) ? `<span class="at ref" role="link" tabindex="0" data-act="ref" data-ref="${m}">${m}</span>` : m));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
};

const markdown = (raw, ctx) => {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const out = [];
  const lines = text.split("\n");
  let i = 0;
  const isList = (line) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      const close = new RegExp(`^\\s*${fence[1]}\\s*$`);
      i += 1;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i += 1;
      const lang = fence[2].toLowerCase();
      const src = body.join("\n");
      if (lang === "mermaid") out.push(diagramHtml(src));
      else if (lang === "html" || lang === "htm" || lang === "svg") out.push(liveBlock(lang, src, ctx));
      else out.push(codeBlock(lang, src));
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      // In chat a "#" is a section, not a page title; the canonical file keeps its own levels.
      const level = Math.min(4, heading[1].length + (ctx?.doc ? 0 : 1));
      out.push(`<h${level}>${inline(heading[2], ctx)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdown(body.join("\n"), ctx)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const head = row(line);
      const align = row(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""));
      const cell = (tag, c, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(c, ctx)}</${tag}>`;
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(
        `<div class="tscroll"><table><thead><tr>${head.map((c, n) => cell("th", c, n)).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c, n) => cell("td", c, n)).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (isList(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        else items[items.length - 1] += `\n${lines[i].trim()}`;
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      const item = (raw) => {
        const task = /^\[([ xX])\]\s+/.exec(raw);
        const body = inline(task ? raw.slice(task[0].length) : raw, ctx).replace(/\n/g, "<br>");
        return task ? `<li class="task${task[1] === " " ? "" : " on"}"><span class="box" aria-hidden="true"></span>${body}</li>` : `<li>${body}</li>`;
      };
      out.push(`<${tag}>${items.map(item).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~)/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !isList(lines[i]) && !/^\s*>/.test(lines[i])) {
      para.push(lines[i++]);
    }
    // A paragraph that is only an embed is a figure, not a line of text.
    const only = para.length === 1 && /^\s*!\[[^\]\n]*\]\([^)]+\)\s*$/.test(para[0]);
    out.push(only ? `<div class="fig">${inline(para[0], ctx)}</div>` : `<p>${para.map((l) => inline(l, ctx)).join("<br>")}</p>`);
  }
  return out.join("");
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class Unauthorized extends Error {}

const api = async (method, path, body) => {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (response.status === 401) {
    showGate();
    throw new Unauthorized(data.error ?? "unauthorized");
  }
  if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status, body: data });
  return data;
};

const roomPath = (suffix = "") => `/api/rooms/${encodeURIComponent(S.roomId)}${suffix}`;

const store = {
  get(key) {
    try {
      return localStorage.getItem(`agoryx.${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`agoryx.${key}`);
      else localStorage.setItem(`agoryx.${key}`, value);
    } catch {}
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  rooms: [],
  roomId: null,
  view: "room", // "room" | "new"
  snap: null, // { state, presence, streams, resume, driven, lockedBy, ops, rawBase }
  panel: null, // null | "table" | "doc"
  wide: false,
  menu: false,
  renaming: false,
  openTraces: new Set(),
  seenMessages: new Set(),
  firstPaint: true,
  es: null,
  reconnectTimer: null,
  dirty: new Set(),
  frame: 0,
  dialog: null,
  doc: null, // the canonical file now: { path, text, hash, exists } | { error }
  docSel: null, // seq of the revision being looked at, or null for the current text
  docHistory: false,
  docRevs: new Map(), // seq -> { revision, previous, text, truncated, diff }
  docEdit: null, // { base, text, conflict? } while the human edits
  panelKey: "",
};

const state = () => S.snap?.state;

const participant = (handle) => {
  const st = state();
  if (!st) return null;
  const agent = st.agents.find((a) => a.id === handle);
  if (agent) return { id: agent.id, label: agent.label, kind: agent.kind, cls: agent.kind === "codex" ? "cx" : "cl", agent: true };
  if (handle === st.human || handle === st.human.toLowerCase()) return { id: st.human, label: st.human, cls: "hu", agent: false };
  if (handle === "agoryx") return { id: "agoryx", label: "Agoryx", cls: "sys", agent: false };
  return null;
};

const mdCtx = () => {
  const st = state();
  const refs = new Set();
  if (st) {
    for (const q of st.table.questions) refs.add(q.id);
    for (const o of st.table.options) refs.add(o.id);
    for (const list of [st.table.notes, st.table.facts, st.table.settled, st.table.next]) for (const item of list) refs.add(item.id);
  }
  return { participant, refs };
};

/** `live` shows the agent's presence ring; avatars inside messages stay still so their html does not change. */
const avatar = (handle, size = 28, live = false) => {
  const who = participant(handle) ?? { label: handle || "?", cls: "hu", agent: false };
  const now = who.agent && live ? S.snap?.presence?.[who.id] : undefined;
  const working = now === "working" ? " working" : now === "native" ? " native" : "";
  if (who.agent) {
    return `<span class="av ag ${who.cls}${working}" style="--s:${size}px" aria-hidden="true">${who.kind === "codex" ? ICON.codex : ICON.claude}</span>`;
  }
  if (who.cls === "sys") return `<span class="av sys" style="--s:${size}px" aria-hidden="true">${ICON.brand}</span>`;
  return `<span class="av" style="--s:${size}px" aria-hidden="true">${esc(who.label.slice(0, 1).toUpperCase())}</span>`;
};

const nameOf = (handle) => participant(handle)?.label ?? handle;
const agentCls = (handle) => participant(handle)?.cls ?? "hu";
const KNOWN_LABEL = { claude: "Claude", codex: "Codex" };

// ---------------------------------------------------------------------------
// Render scheduling
// ---------------------------------------------------------------------------

const invalidate = (...parts) => {
  for (const part of parts) S.dirty.add(part);
  if (!S.frame) S.frame = requestAnimationFrame(flush);
};

const flush = () => {
  S.frame = 0;
  const parts = new Set(S.dirty);
  S.dirty.clear();
  if (parts.has("side")) renderSide();
  if (S.view !== "room" || !S.snap) return;
  if (parts.has("header")) renderHeader();
  if (parts.has("feed")) renderFeed();
  if (parts.has("status")) renderStatus();
  if (parts.has("panel") || (S.panel === "table" && parts.has("table")) || (S.panel === "doc" && parts.has("doc"))) renderPanel();
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

let els = {};

const buildShell = () => {
  root.innerHTML = `
  <div class="app" id="app">
    <aside class="side" id="side" aria-label="Кімнати">
      <div class="brand">${ICON.brand}<span>Agoryx</span></div>
      <button class="newroom" data-act="new-room">${ICON.plus}<span>Нова кімната</span></button>
      <nav class="rooms" id="roomList" aria-label="Кімнати"></nav>
      <div class="side-foot">
        <button class="sidelink" data-act="help">${ICON.help}<span>Як це працює</span></button>
        <button class="iconbtn" data-act="theme" id="themeBtn"></button>
      </div>
    </aside>
    <div class="scrimnav" data-act="nav"></div>
    <main class="main">
      <header class="mh" id="mh"></header>
      <section class="conv" id="conv" hidden>
        <div class="feed" id="feed"><div class="feed-in" id="feedIn"></div></div>
        <button class="jump" id="jump" data-act="jump" hidden>${ICON.down}<span>Донизу</span></button>
        <div class="composer">
          <div class="cwrap">
            <div class="status" id="status" hidden></div>
            <form class="cbox" id="cform" autocomplete="off">
              <textarea id="ctext" rows="1" placeholder="Напишіть Claude і Codex…" aria-label="Повідомлення"></textarea>
              <div class="cfoot"><div class="ctools" id="ctools"></div><button class="send" id="csend" type="submit" aria-label="Надіслати" title="Надіслати (Enter)">${ICON.send}</button></div>
            </form>
          </div>
        </div>
      </section>
      <section class="start" id="start" hidden></section>
    </main>
    <aside class="panel" id="panel" hidden></aside>
  </div>
  <div class="modal" id="modal" hidden>
    <div class="modal-scrim" data-act="close-dialog"></div>
    <div class="dlg" id="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
      <div class="dlg-h"><div class="dlg-t"><b id="dlgTitle"></b><div class="sub" id="dlgSub"></div></div><button class="iconbtn" data-act="close-dialog" aria-label="Закрити">${ICON.x}</button></div>
      <div class="dlg-b" id="dlgBody"></div>
    </div>
  </div>`;
  els = Object.fromEntries(
    ["app", "roomList", "mh", "conv", "feed", "feedIn", "jump", "status", "cform", "ctext", "csend", "ctools", "start", "panel", "modal", "dlg", "dlgTitle", "dlgSub", "dlgBody", "themeBtn"].map((id) => [
      id,
      document.getElementById(id),
    ]),
  );

  document.addEventListener("click", onClick);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (S.dialog) closeDialog();
    else if (S.menu) setMenu(false);
    else if (S.renaming) {
      S.renaming = false;
      invalidate("header");
    } else if (S.panel && !matchMedia("(min-width: 1181px)").matches) setPanel(null);
  });
  els.cform.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });
  els.ctext.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  els.ctext.addEventListener("input", () => {
    autosize(els.ctext);
    syncSend();
    if (S.roomId) store.set(`draft.${S.roomId}`, els.ctext.value || null);
  });
  els.feed.addEventListener("scroll", () => {
    els.jump.hidden = distanceFromBottom() < 240;
  });
  const composer = els.conv.querySelector(".composer");
  new ResizeObserver(() => els.conv.style.setProperty("--composer-h", `${composer.offsetHeight}px`)).observe(composer);
  window.addEventListener("hashchange", route);
  setInterval(tickElapsed, 1000);
  setInterval(() => loadRooms().catch(() => {}), 5000);
  applyTheme();
};

const autosize = (ta) => {
  const max = window.innerHeight * 0.4;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
};

const syncSend = () => {
  els.csend.disabled = !els.ctext.value.trim() || !S.snap?.driven;
};

const distanceFromBottom = () => els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight;

// Theme: system → light → dark, remembered per viewer.
const THEMES = [null, "light", "dark"];
const applyTheme = () => {
  const theme = store.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const label = theme === "light" ? "Світла тема" : theme === "dark" ? "Темна тема" : "Тема як у системі";
  els.themeBtn.innerHTML = theme === "light" ? ICON.sun : theme === "dark" ? ICON.moon : ICON.auto;
  els.themeBtn.title = `${label} — натисніть, щоб змінити`;
  els.themeBtn.setAttribute("aria-label", label);
};

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const previewOf = (room) => {
  const last = room.lastMessage;
  if (!last) return "Ще без повідомлень";
  const who = KNOWN_LABEL[last.author] ?? (last.author === "agoryx" ? "" : "Ви");
  const text = sysText(last.text).replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  return `${who ? `${who}: ` : ""}${text}`;
};

const renderSide = () => {
  const list = S.rooms
    .map((room) => {
      const on = S.view === "room" && room.id === S.roomId ? " on" : "";
      const tail = room.running ? '<span class="livedot" title="Агенти працюють"></span>' : `<span class="rt">${esc(ago(room.updatedAt))}</span>`;
      return `<button class="room${on}" data-act="room" data-id="${esc(room.id)}" title="${esc(room.workspace)}">
        <span class="rn">${esc(room.name)}</span>${tail}
        <span class="rp">${esc(previewOf(room))}</span>
      </button>`;
    })
    .join("");
  els.roomList.innerHTML = list || '<div class="empty-side">Кімнат ще немає.</div>';
  document.querySelector(".newroom")?.classList.toggle("on", S.view === "new");
};

const loadRooms = async () => {
  const { rooms } = await api("GET", "/api/rooms");
  const changed = JSON.stringify(rooms) !== JSON.stringify(S.rooms);
  S.rooms = rooms;
  if (changed) invalidate("side");
  return rooms;
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const tableCount = (table) =>
  table.questions.filter((q) => q.status === "open").length + table.options.filter((o) => o.status === "open" && !o.q).length;

const runningTurn = (agentId) => state()?.turns.find((t) => t.agent === agentId && t.status === "running");

const presencePill = (a) => {
  const now = S.snap.presence?.[a.id];
  const turn = runningTurn(a.id);
  const cls = a.kind === "codex" ? "cx" : "cl";
  let status = "";
  let title = `${a.label} чекає на нове в розмові`;
  if (now === "working" && turn) {
    status = `<span class="ps">працює · <span data-elapsed="${esc(turn.startedAt)}">${secs(Date.now() - new Date(turn.startedAt).getTime())}</span></span>`;
    title = `${a.label} зараз робить хід у кімнаті`;
  } else if (now === "native") {
    status = '<span class="ps">у своїй сесії</span>';
    title = `З ${a.label} зараз розмовляють напряму в його застосунку; хід у кімнаті почнеться після цього`;
  }
  return `<button class="pp ${cls} ${now ?? "idle"}" data-act="sessions" title="${esc(title)}"><span class="pd"></span><b>${esc(a.label)}</b>${status}</button>`;
};

const menuHtml = () =>
  S.menu
    ? `<div class="menu-pop" role="menu">
        <button role="menuitem" data-act="sessions">${ICON.terminal}<span>Сесії агентів<small>Відкрити розмову в Claude Code чи Codex</small></span></button>
        <button role="menuitem" data-act="files">${ICON.folder}<span>Файли робочої теки</span></button>
        <button role="menuitem" data-act="settings">${ICON.gear}<span>Налаштування кімнати</span></button>
      </div>`
    : "";

const renderHeader = () => {
  if (S.view === "new") {
    els.mh.innerHTML = `<button class="iconbtn menu" data-act="nav" aria-label="Кімнати">${ICON.menu}</button><div class="title"><span class="rtitle static">Нова кімната</span></div>`;
    return;
  }
  const st = state();
  const count = tableCount(st.table);
  const title = S.renaming
    ? `<form class="rename" id="renameForm"><input id="renameInput" value="${esc(st.name)}" maxlength="120" aria-label="Назва кімнати" spellcheck="false"></form>`
    : `<button class="rtitle" data-act="rename" title="Перейменувати">${esc(st.name)}</button>`;
  els.mh.innerHTML = `
    <button class="iconbtn menu" data-act="nav" aria-label="Кімнати">${ICON.menu}</button>
    <div class="title">${title}<button class="wpath" data-act="files" title="Робоча тека: ${esc(st.workspace)}">${esc(shortPath(st.workspace))}</button></div>
    <div class="people">${st.agents.map(presencePill).join("")}</div>
    <div class="hacts">
      <button class="hbtn${S.panel === "table" ? " on" : ""}" data-act="panel" data-panel="table" aria-pressed="${S.panel === "table"}" title="Стіл: питання, пропозиції, рішення">${ICON.table}<span class="hl">Стіл</span>${count ? `<span class="n">${count}</span>` : ""}</button>
      <button class="hbtn${S.panel === "doc" ? " on" : ""}" data-act="panel" data-panel="doc" aria-pressed="${S.panel === "doc"}" title="${esc(st.settings.doc ? `Спільний документ: ${st.settings.doc}` : "Спільний документ кімнати")}">${ICON.doc}<span class="hl">Документ</span></button>
      <div class="menu-wrap"><button class="iconbtn" data-act="menu" aria-haspopup="menu" aria-expanded="${S.menu}" aria-label="Ще" title="Ще">${ICON.dots}</button>${menuHtml()}</div>
    </div>`;
  document.title = `${st.name} · Agoryx`;
  if (S.renaming) {
    const input = document.getElementById("renameInput");
    input.focus();
    input.select();
    const form = document.getElementById("renameForm");
    const commit = async () => {
      if (!S.renaming) return;
      S.renaming = false;
      const name = input.value.replace(/\s+/g, " ").trim();
      if (name && name !== st.name) {
        try {
          await api("POST", roomPath("/rename"), { name });
        } catch (error) {
          if (!(error instanceof Unauthorized)) toast(error.message, true);
        }
      }
      invalidate("header");
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      commit();
    });
    input.addEventListener("blur", commit);
  }
};

const setMenu = (open) => {
  S.menu = open;
  invalidate("header");
};

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

const ACT_ICON = { command: "$", edit: "✎", read: "◇", search: "⌕", web: "↗", tool: "⚙", thinking: "…", note: "•", denied: "⊘", error: "!" };

const activityHtml = (a) => {
  const cls = [a.status === "fail" || a.kind === "error" ? "fail" : "", a.kind === "denied" ? "denied" : "", a.status === "running" ? "running" : ""].join(" ");
  const wrap = a.kind === "thinking" || a.kind === "note" || a.kind === "error" || a.kind === "denied";
  const label = wrap && a.label.length > 600 ? `${a.label.slice(0, 600)}…` : a.label;
  const detail = a.detail && (a.status === "fail" || a.kind === "error") ? `<span class="dt">${esc(a.detail.slice(0, 500))}</span>` : "";
  return `<div class="act ${cls}"><span class="ic">${ACT_ICON[a.kind] ?? "·"}</span><span class="lb${wrap ? " wrap" : ""}" title="${esc(a.label)}">${esc(label)}${detail}</span></div>`;
};

const OP_WORD = {
  ask: (o) => `${o.id ?? ""} питання`,
  propose: (o) => `${o.id ?? ""} · ${o.title}`,
  object: (o) => `заперечення до ${o.target}`,
  support: (o) => `підтримка ${o.target}`,
  evidence: (o) => `доказ до ${o.target}`,
  fact: () => "факт",
  settle: () => "узгоджено",
  next: () => "наступний крок",
  done: (o) => `${o.target} виконано`,
  withdraw: (o) => `${o.target} відкликано`,
  decide: (o) => `рішення: ${o.target}`,
  reopen: (o) => `${o.target} відкрито знову`,
};

const opRef = (o) => (o.op === "ask" || o.op === "propose" ? o.id : o.target);

const opSentence = (o) => {
  const who = nameOf(o.by);
  switch (o.op) {
    case "ask":
      return `${who} ставить питання ${o.id}: «${o.text}»`;
    case "propose":
      return `${who} пропонує ${o.id}: «${o.title}»`;
    case "object":
      return `${who} заперечує ${o.target}: «${o.text}»`;
    case "support":
      return `${who} підтримує ${o.target}: «${o.text}»`;
    case "evidence":
      return `${who} додає доказ до ${o.target}: «${o.text}»`;
    case "fact":
      return `${who} фіксує факт: «${o.text}»`;
    case "settle":
      return `${who} позначає узгодженим: «${o.text}»`;
    case "next":
      return `${who} додає наступний крок: «${o.text}»`;
    case "done":
      return `${who} позначає ${o.target} виконаним`;
    case "withdraw":
      return `${who} відкликає ${o.target}`;
    case "reopen":
      return `${who} знову відкриває ${o.target}`;
    default:
      return `${who}: ${o.op} ${o.target ?? ""}`;
  }
};

// --- table moves as cards in the conversation --------------------------------
// The table is a tool the agents use while they talk: each move shows up under
// the message that made it, as a card with the item's live state — the same
// item the panel shows on the board.

const noteCounts = (table, id) => {
  const notes = table.notes.filter((n) => n.target === id);
  return { sup: notes.filter((n) => n.kind === "support").length, obj: notes.filter((n) => n.kind === "object").length, ev: notes.filter((n) => n.kind === "evidence").length };
};

const standingHtml = (table, o) => {
  if (o.status === "chosen") return '<span class="tc-st chosen">Обрано</span>';
  if (o.status === "withdrawn") return '<span class="tc-st gone">Відкликано</span>';
  const q = o.q ? table.questions.find((x) => x.id === o.q) : null;
  if (q?.status === "decided") return '<span class="tc-st gone">Не обрано</span>';
  const { sup, obj, ev } = noteCounts(table, o.id);
  const bits = [];
  if (sup) bits.push(`<span class="plus" title="${esc(plural(sup, "підтримка", "підтримки", "підтримок"))}">✓ ${sup}</span>`);
  if (obj) bits.push(`<span class="minus" title="${esc(plural(obj, "заперечення", "заперечення", "заперечень"))}">✕ ${obj}</span>`);
  if (ev) bits.push(`<span class="ev" title="${esc(plural(ev, "доказ", "докази", "доказів"))}">◆ ${ev}</span>`);
  return `<span class="tc-st">${bits.length ? bits.join("") : "відкрито"}</span>`;
};

const refBtn = (id) => `<button class="tc-id" data-act="ref" data-ref="${esc(id)}" title="Показати на столі">${esc(id)}</button>`;

const optionTitle = (table, id) => {
  const o = table.options.find((x) => x.id === id);
  return o ? `«${esc(o.title)}»` : "";
};

const TC_KIND = {
  ask: "Питання",
  propose: "Пропозиція",
  object: "Заперечення",
  support: "Підтримка",
  evidence: "Доказ",
  fact: "Факт",
  settle: "Узгоджено",
  next: "Наступний крок",
  done: "Виконано",
  withdraw: "Відкликано",
  decide: "Рішення",
  reopen: "Відкрито знову",
};

const opCard = (o) => {
  const table = state().table;
  const kind = `<span class="tc-kind">${ICON.table}${TC_KIND[o.op] ?? o.op}</span>`;
  switch (o.op) {
    case "propose": {
      const opt = table.options.find((x) => x.id === o.id) ?? { ...o, status: "open", q: o.q ?? null };
      const q = opt.q ? table.questions.find((x) => x.id === opt.q) : null;
      const open = opt.status === "open" && q?.status !== "decided";
      const body = opt.body ? markdown(opt.body, { ...mdCtx(), source: `o:${opt.id}` }) : "";
      const long = (opt.body?.length ?? 0) > 600 || /```|!\[/.test(opt.body ?? "");
      return `<div class="tcard prop ${agentCls(opt.by)} ${opt.status}" data-card="${esc(opt.id)}">
        <div class="tc-head">${kind}${refBtn(opt.id)}${q ? `<span class="tc-for">до ${refBtn(q.id)}</span>` : ""}<span class="grow"></span>${standingHtml(table, opt)}</div>
        <div class="tc-title">${inline(opt.title, mdCtx())}</div>
        ${body ? `<div class="tc-body txt${long ? " clamp" : ""}">${body}${long ? '<button class="tc-more" data-act="card-more">Показати повністю</button>' : ""}</div>` : ""}
        ${opt.file ? previewHtml(opt.file) : ""}
        ${
          open
            ? `<div class="tc-acts"><button class="cbtn" data-act="table-form" data-kind="support" data-id="${esc(opt.id)}">Підтримати</button><button class="cbtn" data-act="table-form" data-kind="object" data-id="${esc(opt.id)}">Заперечити</button><button class="cbtn strong" data-act="table-form" data-kind="decide" data-id="${esc(opt.id)}">Обрати</button></div>`
            : ""
        }
      </div>`;
    }
    case "ask": {
      const q = table.questions.find((x) => x.id === o.id) ?? { ...o, status: "open" };
      const options = table.options.filter((x) => x.q === q.id);
      const decision = q.status === "decided" ? table.decisions.filter((d) => d.q === q.id).pop() : null;
      const st = decision
        ? `<span class="tc-st chosen">Вирішено: ${esc(decision.option)}</span>`
        : `<span class="tc-st">${options.length ? esc(plural(options.length, "варіант", "варіанти", "варіантів")) : "чекає варіантів"}</span>`;
      return `<div class="tcard ask" data-card="${esc(q.id)}">
        <div class="tc-head">${kind}${refBtn(q.id)}<span class="grow"></span>${st}</div>
        <div class="tc-title">${inline(q.text, mdCtx())}</div>
        ${options.length ? `<div class="tc-opts">${options.map((x) => `<button class="tc-opt ${x.status}" data-act="ref" data-ref="${esc(x.id)}"><b>${esc(x.id)}</b> ${esc(x.title)}</button>`).join("")}</div>` : ""}
      </div>`;
    }
    case "object":
    case "support":
    case "evidence": {
      let source = "";
      if (o.source) {
        const rel = workspaceRel(o.source);
        source = /^https?:\/\//.test(o.source)
          ? `<a class="src" href="${esc(o.source)}" target="_blank" rel="noopener noreferrer">${esc(o.source.replace(/^https?:\/\//, ""))}</a>`
          : rel
            ? IMAGE_EXT.has(ext(rel))
              ? embedHtml(rel, "")
              : `<button class="src" data-act="file" data-path="${esc(rel)}">${esc(rel)}</button>`
            : `<span class="src">${esc(o.source)}</span>`;
      }
      return `<div class="tcard nt ${o.op}" data-card="${esc(o.id ?? "")}">
        <div class="tc-head">${kind}<span class="tc-for">до ${refBtn(o.target)} <span class="tc-ot">${optionTitle(table, o.target)}</span></span></div>
        <div class="tc-text">${inline(o.text, mdCtx())}</div>
        ${source ? `<div class="tc-src">${source}</div>` : ""}
      </div>`;
    }
    case "fact":
    case "settle":
    case "next": {
      const list = o.op === "fact" ? table.facts : o.op === "settle" ? table.settled : table.next;
      const item = list.find((x) => x.id === o.id);
      const done = o.op === "next" && item?.done;
      return `<div class="tcard line ${o.op}${done ? " done" : ""}" data-card="${esc(o.id ?? "")}">${kind}<span class="tc-text">${inline(o.text, mdCtx())}</span>${done ? '<span class="tc-st chosen">виконано</span>' : ""}</div>`;
    }
    case "decide":
      return `<div class="tcard line decide">${kind}<span class="tc-text">${refBtn(o.target)} ${optionTitle(table, o.target)}${o.note ? ` — ${inline(o.note, mdCtx())}` : ""}</span></div>`;
    default: {
      const text = o.op === "done" ? table.next.find((x) => x.id === o.target)?.text : table.options.find((x) => x.id === o.target)?.title ?? table.questions.find((x) => x.id === o.target)?.text;
      return `<div class="tcard line ${o.op}">${kind}<span class="tc-text">${refBtn(o.target)} ${text ? esc(text) : ""}</span></div>`;
    }
  }
};

const opCards = (ops) => (ops?.length ? `<div class="tcards">${ops.map(opCard).join("")}</div>` : "");

const revStats = (r) =>
  r.deleted ? '<span class="minus">видалено</span>' : `<span class="plus">+${r.added}</span> <span class="minus">−${r.removed}</span>`;

const changeStats = (c) =>
  c.added === null
    ? '<span class="faint">двійковий</span>'
    : c.status === "D"
      ? `<span class="minus">видалено −${c.removed}</span>`
      : `<span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span>${c.status === "A" ? ' <span class="faint">новий</span>' : ""}`;

const fileName = (path) => path.split("/").pop();

const changeChip = (turn, c) =>
  `<button class="chip file" data-act="turn-diff" data-turn="${esc(turn.id)}" data-path="${esc(c.path)}" title="Що саме цей хід змінив у ${esc(c.path)}">${ICON.file}<span class="ell">${esc(fileName(c.path))}</span> ${changeStats(c)}</button>`;

const docChip = (r) =>
  `<button class="chip doc" data-act="doc-open" data-seq="${r.seq}" title="Правка спільного документа — показати, що змінилося">${ICON.doc}<span class="ell">${esc(fileName(r.path))}</span> ${revStats(r)}</button>`;

const turnBar = (turn, ops, docs) => {
  const bits = [];
  if (turn?.activity.length) {
    const open = S.openTraces.has(turn.id);
    bits.push(
      `<button class="chip trace-t" data-act="trace" data-turn="${esc(turn.id)}" aria-expanded="${open}">${open ? "▾" : "▸"} ${esc(plural(turn.activity.length, "дія", "дії", "дій"))}</button>`,
    );
  }
  for (const r of docs ?? []) bits.push(docChip(r));
  const docPaths = new Set((docs ?? []).map((r) => r.path));
  if (turn?.changes?.length) {
    for (const c of turn.changes) if (!docPaths.has(c.path)) bits.push(changeChip(turn, c));
  } else {
    for (const file of turn?.files ?? []) {
      if (!docPaths.has(file)) bits.push(`<button class="chip file" data-act="file" data-path="${esc(file)}" title="${esc(file)}">${ICON.file}<span class="ell">${esc(fileName(file))}</span></button>`);
    }
  }
  if (!bits.length) return "";
  const trace = turn && S.openTraces.has(turn.id) && turn.activity.length ? `<div class="trace">${turn.activity.map(activityHtml).join("")}</div>` : "";
  return `<div class="chips">${bits.join("")}</div>${trace}`;
};

const turnMeta = (turn) => {
  if (!turn) return "";
  const bits = [];
  if (turn.durationMs != null) bits.push(secs(turn.durationMs));
  if (turn.usage?.costUsd) bits.push(`$${turn.usage.costUsd.toFixed(turn.usage.costUsd < 0.1 ? 3 : 2)}`);
  let bad = "";
  if (turn.status === "error") bad = '<span class="bad">помилка</span>';
  else if (turn.status === "interrupted") bad = '<span class="bad">перервано</span>';
  return `${bits.length ? `<span class="kind">${esc(bits.join(" · "))}</span>` : ""}${bad}`;
};

// A message imported from an agent's own session (outside the room) says where it happened.
const nativeTag = (m) => {
  if (!m.native) return "";
  const who = nameOf(m.native.agent);
  const cls = participant(m.native.agent)?.cls === "cx" ? "cx" : "cl";
  const label = m.author === m.native.agent ? "у своїй сесії" : `напряму в сесії ${who}`;
  const title = `Це було в рідній сесії ${who}, поза кімнатою. Agoryx підтягнув репліку сюди, щоб її бачили всі.`;
  return `<span class="nat ${cls}" title="${esc(title)}">${esc(label)}</span>`;
};

// The engine writes its notes in English (agents read them too); the page says them in Ukrainian.
const SYS_TEXT = [
  [/^Turn budget reached \((\d+) agent turns\)\..*$/s, (_, n) => `Агенти зробили ${plural(Number(n), "хід", "ходи", "ходів")} — розмова чекає на вас.`],
  [/^Agoryx restarted in the middle of a run.*$/s, () => "Agoryx перезапустився посеред розмови, тож її зупинено. Напишіть щось або натисніть «Продовжити»."],
  [/^The room's canonical file is now (.+)\.$/, (_, path) => `Спільний документ кімнати тепер — \`${path}\`.`],
  [/^The room no longer has a canonical file\.$/, () => "У кімнати більше немає спільного документа."],
  [/^(.+) stopped the run\.$/, () => "Розмову зупинено."],
  [/^(.+) asked for another round\.$/, (_, who) => `${who} просить ще один раунд.`],
  [/^(.+?) could not finish its turn: (.*)$/s, (_, who, why) => `${who}: хід не вдалося завершити — ${why}`],
  [/^(.+?) is busy in its own session.*$/s, (_, who) => `${who} зараз говорить у своїй сесії — хід у кімнаті почнеться після цього.`],
];
const sysText = (text) => {
  for (const [pattern, say] of SYS_TEXT) {
    const m = pattern.exec(text);
    if (m) return say(...m);
  }
  return text;
};

// The "fresh" arrival animation is added by the feed when a node is new, so a message's html stays stable.
const messageHtml = (m, ctx) => {
  const fresh = "";
  const turn = m.turnId ? ctx.turns.get(m.turnId) : undefined;
  const ops = m.turnId ? ctx.opsByTurn.get(m.turnId) : undefined;
  const docs = m.turnId ? ctx.docByTurn.get(m.turnId) : undefined;
  const id = `m-${esc(m.id)}`;
  if (m.kind === "pass") {
    const note = m.text && m.text.trim() && !/^::pass::$/i.test(m.text.trim()) ? ` — ${esc(m.text.replace(/^[`"'*_\s]*::pass::[`"'*_\s.:—–-]*/i, ""))}` : "";
    const chips = docs?.length || turn?.files?.length ? turnBar(turn, ops, docs) : "";
    // A turn with no words can still have moved the table or the files — then it is not a pass.
    const silent = ops?.length ? `без слів — ${ops.length === 1 ? "хід" : "ходи"} на столі` : turn?.files?.length || docs?.length ? "без слів — лише зміни" : `пропускає хід${note || " — нема що додати"}`;
    return `<div class="passl${fresh}" id="${id}"><div class="pl">${avatar(m.author, 18)}<span><b>${esc(nameOf(m.author))}</b> ${silent}</span></div>${chips}${opCards(ops)}</div>`;
  }
  if (m.kind === "system") {
    const err = /error|failed|could not finish|timed out|rate limit/i.test(m.text) ? " err" : "";
    return `<div class="sysl${err}${fresh}" id="${id}">${inline(sysText(m.text), mdCtx())}</div>`;
  }
  if (m.kind === "decision") {
    return `<div class="decision${fresh}" id="${id}"><span class="dn">Рішення</span><div>${inline(m.text, mdCtx())}</div></div>`;
  }
  if (m.kind === "human") {
    return `<div class="hmsg${fresh}" id="${id}">
      <div class="bubble"><div class="txt">${markdown(m.text, { ...mdCtx(), source: `m:${m.id}` })}</div></div>
      <div class="hmeta">${nativeTag(m)}<time datetime="${esc(m.ts)}" title="${esc(fullDate(m.ts))}">${clock(m.ts)}</time></div>
    </div>`;
  }
  const cls = agentCls(m.author);
  return `<article class="amsg${fresh}" id="${id}">
    <div class="ahead">${avatar(m.author, 26)}<b class="an ${cls}">${esc(nameOf(m.author))}</b>${nativeTag(m)}<time datetime="${esc(m.ts)}" title="${esc(fullDate(m.ts))}">${clock(m.ts)}</time>${turnMeta(turn)}</div>
    <div class="abody">
      <div class="txt">${markdown(m.text, { ...mdCtx(), source: `m:${m.id}` })}</div>
      ${opCards(ops)}
      ${turnBar(turn, ops, docs)}
    </div>
  </article>`;
};

const liveHtml = (turn, ops) => {
  const stream = S.snap.streams?.[turn.id]?.text ?? "";
  const last = turn.activity.slice(-3);
  const elapsed = Date.now() - new Date(turn.startedAt).getTime();
  const cls = agentCls(turn.agent);
  return `<article class="amsg live" data-live="${esc(turn.id)}">
    <div class="ahead">${avatar(turn.agent, 26, true)}<b class="an ${cls}">${esc(nameOf(turn.agent))}</b><span class="kind"><span class="dots ${cls}"><i></i><i></i><i></i></span> працює · <span data-elapsed="${esc(turn.startedAt)}">${secs(elapsed)}</span></span></div>
    <div class="abody">
      <div class="stream txt" data-stream="${esc(turn.id)}">${esc(stream.slice(-2400))}</div>
      <div class="trace live-trace" data-trace="${esc(turn.id)}"${last.length ? "" : " hidden"}>${last.map(activityHtml).join("")}</div>
      ${opCards(ops)}
    </div>
  </article>`;
};

const helloHtml = (st) => `
  <div class="hello">
    <div class="hello-av">${st.agents.map((a) => avatar(a.id, 40, true)).join("")}</div>
    <h2>Кімната готова</h2>
    <p>Напишіть, що треба зробити чи обговорити. ${esc(st.agents.map((a) => a.label).join(" і "))} спершу відповідять одночасно й незалежно, а далі говоритимуть по черзі — кожен бачитиме все, що сказали до нього.</p>
  </div>`;

const buildFeedModel = () => {
  const st = state();
  const turns = new Map(st.turns.map((t) => [t.id, t]));
  const withMessage = new Set(st.messages.filter((m) => m.turnId).map((m) => m.turnId));
  const opsByTurn = new Map();
  const items = [];
  for (const entry of S.snap.ops ?? []) {
    const o = entry.op;
    const turn = o.turnId ? turns.get(o.turnId) : undefined;
    if (o.turnId && (withMessage.has(o.turnId) || turn?.status === "running")) {
      const list = opsByTurn.get(o.turnId) ?? [];
      list.push(o);
      opsByTurn.set(o.turnId, list);
    } else if (o.op !== "decide") {
      items.push({ seq: entry.seq, type: "op", op: o });
    }
  }
  // Revisions of the canonical file: on the reply of the turn that made them, else a line of their own.
  const docByTurn = new Map();
  for (const r of st.docRevisions ?? []) {
    if (r.by === "agoryx") continue;
    if (r.turnId && withMessage.has(r.turnId)) {
      const list = docByTurn.get(r.turnId) ?? [];
      list.push(r);
      docByTurn.set(r.turnId, list);
    } else {
      items.push({ seq: r.seq, type: "doc", r });
    }
  }
  for (const m of st.messages) items.push({ seq: m.seq, type: "msg", m });
  for (const c of st.commits) items.push({ seq: c.seq, type: "commit", c });
  items.sort((a, b) => a.seq - b.seq);
  return { turns, opsByTurn, docByTurn, items };
};

/** Turn behind an agent reply or pass, or null for anything else. */
const replyTurn = (item, ctx) => {
  if (item?.type !== "msg" || (item.m.kind !== "agent" && item.m.kind !== "pass") || !item.m.turnId) return null;
  return ctx.turns.get(item.m.turnId) ?? null;
};

/**
 * Put keyed html parts into a host, touching only the nodes whose html changed:
 * a live page or diagram inside an unchanged message is never rebuilt (an
 * iframe that is re-created or moved reloads).
 */
const reconcile = (host, parts, { onNew } = {}) => {
  const byKey = new Map();
  for (const node of host.children) if (node.dataset.key) byKey.set(node.dataset.key, node);
  let i = 0;
  for (const [key, html] of parts) {
    const at = host.children[i];
    const old = byKey.get(key);
    if (old && old.__html === html) {
      if (old !== at) host.insertBefore(old, at ?? null);
    } else {
      const tpl = document.createElement("template");
      tpl.innerHTML = html.trim();
      const node = tpl.content.firstElementChild ?? document.createElement("div");
      node.dataset.key = key;
      node.__html = html;
      if (!old) onNew?.(node, key);
      if (old) old.replaceWith(node);
      if (host.children[i] !== node) host.insertBefore(node, host.children[i] ?? null);
    }
    byKey.delete(key);
    i += 1;
  }
  for (const node of byKey.values()) node.remove();
  while (host.children.length > parts.length) host.lastElementChild.remove();
};

const standaloneOpHtml = (o) => {
  const who = participant(o.by);
  const outside = who?.agent && !o.turnId ? `<span class="nat ${who.cls}" title="${esc(`Зроблено з рідної сесії ${who.label}, поза ходом у кімнаті.`)}">у своїй сесії</span>` : "";
  return `<div class="oprow">
    <div class="ophead">${avatar(o.by, 18)}<b>${esc(nameOf(o.by))}</b><span class="faint">на столі</span>${outside}</div>
    ${opCard(o)}
  </div>`;
};

const renderFeed = () => {
  const st = state();
  const feed = els.feed;
  const pinned = S.firstPaint || distanceFromBottom() < 120;
  const before = feed.scrollTop;
  const ctx = buildFeedModel();
  const parts = [];
  if (!st.messages.length && !st.turns.length) parts.push(["hello", helloHtml(st)]);
  const { items } = ctx;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const first = replyTurn(item, ctx);
    if (first) {
      // Replies written at the same moment: none of them saw the others.
      const group = [item];
      const agents = new Set([item.m.author]);
      let j = i + 1;
      while (j < items.length && replyTurn(items[j], ctx) && replyTurn(items[j], ctx).cursor < item.m.seq && !agents.has(items[j].m.author)) {
        agents.add(items[j].m.author);
        group.push(items[j]);
        j += 1;
      }
      if (group.length > 1 && group.some((g) => g.m.kind === "agent")) {
        const prev = st.messages.filter((m) => m.seq < item.m.seq && m.kind !== "system").at(-1);
        const blind = prev?.kind === "human";
        const names = group.map((g) => nameOf(g.m.author)).join(" і ");
        parts.push([
          `div-${item.m.id}`,
          blind
            ? `<div class="divider" title="Перша відповідь на ваше повідомлення: агенти писали одночасно й не бачили відповідей одне одного — щоб думки були незалежні."><span>${esc(names)} відповіли незалежно — не бачачи одне одного</span></div>`
            : `<div class="divider" title="Ці відповіді писалися одночасно: кожен бачив попередні репліки, але не цю відповідь іншого."><span>${esc(names)} писали одночасно</span></div>`,
        ]);
        for (const g of group) parts.push([`m-${g.m.id}`, messageHtml(g.m, ctx)]);
        i = j - 1;
        continue;
      }
    }
    if (item.type === "msg") parts.push([`m-${item.m.id}`, messageHtml(item.m, ctx)]);
    else if (item.type === "commit")
      parts.push([
        `c-${item.c.sha}`,
        `<div class="evt"><span class="tag ok">git</span><span>Контрольна точка <button class="linkish" data-act="commit" data-sha="${esc(item.c.sha)}">${esc(item.c.sha.slice(0, 7))}</button> · ${esc(plural(item.c.files, "файл", "файли", "файлів"))}</span></div>`,
      ]);
    else if (item.type === "op") parts.push([`o-${item.seq}`, standaloneOpHtml(item.op)]);
    else if (item.type === "doc") {
      const r = item.r;
      const who = participant(r.by);
      const outside = r.native && who?.agent ? `<span class="nat ${who.cls}" title="${esc(`Змінено в рідній сесії ${who.label}, поза ходом у кімнаті.`)}">у своїй сесії</span>` : "";
      parts.push([
        `d-${r.seq}`,
        `<div class="evt"><span class="tag doc">Документ</span><span><b>${esc(nameOf(r.by))}</b> змінює <button class="linkish" data-act="doc-open" data-seq="${r.seq}">${esc(r.path)}</button> ${revStats(r)}</span>${outside}</div>`,
      ]);
    }
  }
  const live = st.turns.filter((turn) => turn.status === "running");
  if (live.length > 1) {
    const prev = st.messages.filter((m) => m.kind !== "system").at(-1);
    if (prev?.kind === "human") parts.push(["live-div", `<div class="divider"><span>${esc(live.map((t) => nameOf(t.agent)).join(" і "))} відповідають незалежно — не бачачи одне одного</span></div>`]);
  }
  for (const turn of live) parts.push([`live-${turn.id}`, liveHtml(turn, ctx.opsByTurn.get(turn.id))]);
  reconcile(els.feedIn, parts, {
    onNew: (node, key) => {
      if (!key.startsWith("m-")) return;
      const id = key.slice(2);
      if (!S.firstPaint && !S.seenMessages.has(id)) node.classList.add("fresh");
      S.seenMessages.add(id);
    },
  });
  hydrateDiagrams();
  if (pinned) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = before;
  els.jump.hidden = distanceFromBottom() < 240;
  S.firstPaint = false;
};

const tickElapsed = () => {
  for (const node of document.querySelectorAll("[data-elapsed]")) {
    node.textContent = secs(Date.now() - new Date(node.dataset.elapsed).getTime());
  }
};

// ---------------------------------------------------------------------------
// Status line + composer
// ---------------------------------------------------------------------------

const renderStatus = () => {
  const st = state();
  const run = st.runs[st.runs.length - 1];
  const working = st.agents.filter((a) => S.snap.presence?.[a.id] === "working").map((a) => a.label);
  const native = st.agents
    .filter((a) => S.snap.presence?.[a.id] === "native")
    .map((a) => `<div class="srow nat ${a.kind === "codex" ? "cx" : "cl"}"><span class="sd"></span><span>З ${esc(a.label)} зараз говорять напряму в його сесії — хід у кімнаті почнеться після цього.</span></div>`)
    .join("");
  let line = "";
  if (!S.snap.driven) {
    line = `<div class="srow"><span class="sd"></span><span>Лише перегляд — кімнату веде інший процес agoryx${S.snap.lockedBy ? ` (${esc(S.snap.lockedBy)})` : ""}.</span></div>`;
  } else if (run?.status === "active") {
    const who = working.length ? `${esc(working.join(" і "))} ${working.length > 1 ? "працюють" : "працює"}` : "Розмова триває";
    line = `<div class="srow on"><span class="sd"></span><span>${who} <span class="faint">· хід ${run.used} з ${run.budget}</span></span><button class="sbtn warn" data-act="stop">${ICON.stop}Зупинити</button></div>`;
  } else if (run?.endReason === "budget") {
    line = `<div class="srow wait"><span class="sd"></span><span>Агенти зробили ${esc(plural(run.used, "хід", "ходи", "ходів"))} і чекають на вас. Напишіть або дайте їм продовжити.</span><button class="sbtn" data-act="more">Продовжити</button></div>`;
  } else if (run?.endReason === "stopped") {
    line = `<div class="srow wait"><span class="sd"></span><span>Розмову зупинено.</span><button class="sbtn" data-act="more">Продовжити</button></div>`;
  }
  els.status.innerHTML = line + native;
  els.status.hidden = !line && !native;
  els.ctools.innerHTML = `${st.agents
    .map((a) => `<button type="button" class="mention ${a.kind === "codex" ? "cx" : "cl"}" data-act="mention" data-who="${esc(a.id)}" title="Звернутися лише до ${esc(a.label)}">@${esc(a.id)}</button>`)
    .join("")}<span class="hint">Enter — надіслати · Shift+Enter — новий рядок</span>`;
  els.ctext.disabled = !S.snap.driven;
  syncSend();
};

const sendMessage = async () => {
  const text = els.ctext.value.trim();
  if (!text || !S.roomId || !S.snap?.driven) return;
  els.csend.disabled = true;
  try {
    await api("POST", roomPath("/messages"), { text });
    els.ctext.value = "";
    autosize(els.ctext);
    store.set(`draft.${S.roomId}`, null);
    els.feed.scrollTop = els.feed.scrollHeight;
  } catch (error) {
    if (!(error instanceof Unauthorized)) toast(error.message, true);
  } finally {
    syncSend();
  }
};

// ---------------------------------------------------------------------------
// New room: just start talking
// ---------------------------------------------------------------------------

const renderStart = () => {
  const noRooms = !S.rooms.length;
  els.start.innerHTML = `<div class="start-in">
    <div class="hello-av"><span class="av ag cl" style="--s:44px">${ICON.claude}</span><span class="av ag cx" style="--s:44px">${ICON.codex}</span></div>
    <h1>${noRooms ? "Спільна кімната для вас, Claude і Codex" : "Про що поговоримо?"}</h1>
    <p>Напишіть задачу чи питання. Claude і Codex спершу відповідять незалежно, а далі працюватимуть разом по черзі — кожен у своїй рідній сесії, з усіма своїми інструментами.</p>
    <form class="cbox big" id="nform" data-form="new-room" autocomplete="off">
      <textarea name="text" id="ntext" rows="3" placeholder="Наприклад: спроєктуйте разом формат журналу подій і запишіть рішення в README" aria-label="Перше повідомлення"></textarea>
      <div class="cfoot"><span class="hint">Назва кімнати — з першого рядка; змінити можна будь-коли</span><button class="send" type="submit" id="nsend" aria-label="Почати" title="Почати (Enter)" disabled>${ICON.send}</button></div>
    </form>
    <details class="opts">
      <summary>Параметри</summary>
      <div class="opts-b">
        <label>Робоча тека<input type="text" name="dir" form="nform" placeholder="Порожньо — нова git-тека в ~/agoryx" spellcheck="false"><small>Можна вказати наявний проєкт — агенти працюватимуть у ньому (у пісочниці).</small></label>
        <label>Спільний документ<input type="text" name="doc" form="nform" placeholder="README.md" spellcheck="false"><small>Файл, який кімната пише разом; кожна версія зберігається з автором.</small></label>
        <label>Ходів агентів на ваше повідомлення<input type="number" name="budget" form="nform" value="8" min="1" max="100"></label>
      </div>
    </details>
  </div>`;
  const ta = document.getElementById("ntext");
  const send = document.getElementById("nsend");
  const draft = store.get("draft.new") ?? "";
  ta.value = draft;
  send.disabled = !draft.trim();
  autosize(ta);
  ta.addEventListener("input", () => {
    autosize(ta);
    send.disabled = !ta.value.trim();
    store.set("draft.new", ta.value || null);
  });
  ta.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      document.getElementById("nform").requestSubmit();
    }
  });
  setTimeout(() => ta.focus(), 30);
};

const showStart = () => {
  closeStream();
  S.view = "new";
  S.roomId = null;
  S.snap = null;
  S.menu = false;
  S.renaming = false;
  els.conv.hidden = true;
  els.start.hidden = false;
  els.panel.hidden = true;
  els.app.classList.remove("with-panel", "wide");
  document.title = "Нова кімната · Agoryx";
  renderStart();
  renderHeader();
  renderSide();
};

// ---------------------------------------------------------------------------
// Side panel: the table and the canonical file, next to the conversation
// ---------------------------------------------------------------------------

const setPanel = (panel) => {
  S.panel = panel;
  store.set("panel", panel);
  S.menu = false;
  if (panel === "doc" && !S.docEdit && S.docSel == null) loadDoc();
  layoutPanel();
  invalidate("header", "panel");
};

const layoutPanel = () => {
  const open = Boolean(S.panel) && S.view === "room" && Boolean(S.snap);
  els.panel.hidden = !open;
  els.app.classList.toggle("with-panel", open);
  els.app.classList.toggle("wide", open && S.wide);
};

const renderPanel = () => {
  layoutPanel();
  if (!S.panel || !S.snap) return;
  let shell = els.panel.querySelector(".pbody");
  if (!shell) {
    els.panel.innerHTML = `<div class="ph" id="ph"></div><div class="pbody" id="pbody"></div>`;
    shell = els.panel.querySelector(".pbody");
  }
  const count = tableCount(state().table);
  document.getElementById("ph").innerHTML = `
    <div class="seg" role="tablist">
      <button role="tab" aria-selected="${S.panel === "table"}" class="${S.panel === "table" ? "on" : ""}" data-act="panel" data-panel="table">Стіл${count ? ` <span class="n">${count}</span>` : ""}</button>
      <button role="tab" aria-selected="${S.panel === "doc"}" class="${S.panel === "doc" ? "on" : ""}" data-act="panel" data-panel="doc">Документ</button>
    </div>
    <span class="grow"></span>
    <button class="iconbtn widebtn" data-act="wide" title="${S.wide ? "Звузити панель" : "Розширити панель"}" aria-label="${S.wide ? "Звузити панель" : "Розширити панель"}">${S.wide ? ICON.shrink : ICON.expand}</button>
    <button class="iconbtn" data-act="close-panel" title="Закрити панель" aria-label="Закрити панель">${ICON.x}</button>`;
  const key = S.panel === "table" ? "table" : `doc:${S.docEdit ? "edit" : S.docSel ?? (S.docHistory ? "history" : "now")}`;
  const keep = key === S.panelKey ? shell.scrollTop : 0;
  if (S.panel === "table") renderTable(shell);
  else {
    renderDoc(shell);
    hydrateDiagrams();
  }
  shell.scrollTop = keep;
  S.panelKey = key;
};

// --- the table -------------------------------------------------------------

const noteHtml = (n) => {
  const title = { object: "Заперечення", support: "Підтримка", evidence: "Доказ" }[n.kind];
  let source = "";
  if (n.source) {
    source = /^https?:\/\//.test(n.source)
      ? `<a class="src" href="${esc(n.source)}" target="_blank" rel="noopener noreferrer" title="${esc(n.source)}">${esc(n.source.replace(/^https?:\/\//, ""))}</a>`
      : `<button class="src" data-act="file" data-path="${esc(n.source)}" title="${esc(n.source)}">${esc(n.source)}</button>`;
  }
  return `<div class="note ${n.kind}" id="ti-${esc(n.id)}"><div class="t">${avatar(n.by, 16)} ${title} · ${esc(nameOf(n.by))}${source}</div>${inline(n.text, mdCtx())}</div>`;
};

const previewHtml = (file) => {
  const kind = ext(file);
  const url = `${S.snap.rawBase}${file.split("/").map(encodeURIComponent).join("/")}`;
  if (IMAGE_EXT.has(kind)) {
    return `<button class="thumb" data-act="file" data-path="${esc(file)}" title="${esc(file)}"><img src="${esc(url)}" alt="${esc(file)}" loading="lazy"></button>`;
  }
  if (FRAME_EXT.has(kind)) {
    return `<div class="frame-wrap"><iframe class="frame" src="${esc(url)}" sandbox="allow-scripts" loading="lazy" title="${esc(file)}"></iframe><button class="fileline" data-act="file" data-path="${esc(file)}">${ICON.file}<span class="mono ell">${esc(file)}</span><span class="go">відкрити</span></button></div>`;
  }
  return `<button class="fileline" data-act="file" data-path="${esc(file)}">${ICON.file}<span class="mono ell">${esc(file)}</span><span class="go">переглянути</span></button>`;
};

const optionHtml = (o, table, decidedQ) => {
  const notes = table.notes.filter((n) => n.target === o.id);
  const order = { object: 0, evidence: 1, support: 2 };
  notes.sort((a, b) => order[a.kind] - order[b.kind] || a.seq - b.seq);
  const lost = decidedQ && o.status === "open" ? " lost" : "";
  const counts = [];
  const obj = notes.filter((n) => n.kind === "object").length;
  const sup = notes.filter((n) => n.kind === "support").length;
  if (obj) counts.push(plural(obj, "заперечення", "заперечення", "заперечень"));
  if (sup) counts.push(plural(sup, "підтримка", "підтримки", "підтримок"));
  let acts = "";
  if (o.status === "chosen") acts = '<span class="chosen-mark">Обрано</span>';
  else if (o.status === "withdrawn") acts = '<span class="faint small">Відкликано автором</span>';
  else if (o.status === "open" && !decidedQ) {
    acts = `<button class="btn primary sm" data-act="table-form" data-kind="decide" data-id="${esc(o.id)}">Обрати</button>
      <button class="btn sm" data-act="table-form" data-kind="object" data-id="${esc(o.id)}">Заперечити</button>
      <button class="btn sm" data-act="table-form" data-kind="support" data-id="${esc(o.id)}">Підтримати</button>
      <button class="btn sm" data-act="table-form" data-kind="evidence" data-id="${esc(o.id)}">Доказ</button>`;
  }
  return `<article class="opt ${agentCls(o.by)} ${o.status}${lost}" id="opt-${esc(o.id)}">
    <div class="ohead"><span class="oid">${esc(o.id)}</span><b>${inline(o.title, mdCtx())}</b></div>
    <div class="oby">${avatar(o.by, 16)} ${esc(nameOf(o.by))}${counts.length ? ` · ${esc(counts.join(", "))}` : ""}</div>
    ${o.body ? `<div class="obody txt">${markdown(o.body, { ...mdCtx(), source: `o:${o.id}` })}</div>` : ""}
    ${o.file ? previewHtml(o.file) : ""}
    ${notes.length ? `<div class="notes">${notes.map(noteHtml).join("")}</div>` : ""}
    ${acts ? `<div class="oacts">${acts}</div>` : ""}
  </article>`;
};

const questionHtml = (q, table) => {
  const options = table.options.filter((o) => o.q === q.id);
  const decided = q.status === "decided";
  const decision = table.decisions.filter((d) => d.q === q.id).pop();
  const chosen = decision ? table.options.find((o) => o.id === decision.option) : undefined;
  const open = options.filter((o) => o.status === "open").length;
  const status = decided
    ? `<span class="qstatus done">Вирішено${chosen ? ` — ${esc(chosen.id)}` : ""}</span>`
    : `<span class="qstatus">${options.length ? esc(plural(open, "варіант", "варіанти", "варіантів")) : "Варіантів ще немає"}</span>`;
  return `<section class="qcard${decided ? " decided" : ""}" id="q-${esc(q.id)}">
    <div class="qhead"><span class="qid">${esc(q.id)}</span><span class="faint">${esc(nameOf(q.by))}</span><span class="grow"></span>${status}</div>
    <h3>${inline(q.text, mdCtx())}</h3>
    ${options.length ? `<div class="opts-list">${options.map((o) => optionHtml(o, table, decided)).join("")}</div>` : ""}
    ${decided ? "" : `<button class="addopt" data-act="table-form" data-kind="propose" data-q="${esc(q.id)}">${ICON.plus}Запропонувати варіант</button>`}
  </section>`;
};

const whereHtml = (table) => {
  const decisions = [...table.decisions].reverse().map((d) => {
    const o = table.options.find((x) => x.id === d.option);
    return `<li><span class="ok"></span><span><b>${esc(o ? `${o.id} «${o.title}»` : d.option)}</b>${d.note ? `<small>${inline(d.note, mdCtx())}</small>` : ""}<small>рішення №${d.n} · ${esc(nameOf(d.by))}</small></span></li>`;
  });
  const settled = [
    ...table.settled.map((s) => `<li id="ti-${esc(s.id)}"><span class="ok soft"></span><span>${inline(s.text, mdCtx())}<small>${esc(nameOf(s.by))}</small></span></li>`),
    ...table.facts.map((f) => `<li id="ti-${esc(f.id)}"><span class="fx" title="Факт">F</span><span>${inline(f.text, mdCtx())}<small>факт · ${esc(nameOf(f.by))}</small></span></li>`),
  ];
  const next = table.next.map(
    (n) =>
      `<li id="ti-${esc(n.id)}" class="${n.done ? "done" : ""}">${n.done ? '<span class="nx on"></span>' : `<button class="nx" data-act="done" data-id="${esc(n.id)}" title="Позначити виконаним" aria-label="Позначити виконаним"></button>`}<span>${inline(n.text, mdCtx())}<small>${esc(nameOf(n.by))}</small></span></li>`,
  );
  const blocks = [];
  if (decisions.length) blocks.push(`<div class="wblock"><h4>Рішення</h4><ul>${decisions.join("")}</ul></div>`);
  if (settled.length) blocks.push(`<div class="wblock"><h4>Узгоджено</h4><ul>${settled.join("")}</ul></div>`);
  if (next.length) blocks.push(`<div class="wblock"><h4>Наступні кроки</h4><ul>${next.join("")}</ul></div>`);
  return blocks.length ? `<section class="where">${blocks.join("")}</section>` : "";
};

const tableToolbar = () => `<div class="ptools">
  <button class="btn sm" data-act="table-form" data-kind="ask">${ICON.q}Питання</button>
  <button class="btn sm" data-act="table-form" data-kind="propose">${ICON.plus}Пропозиція</button>
  <button class="btn sm" data-act="table-form" data-kind="settle">${ICON.pin}Узгоджено</button>
  <button class="btn sm" data-act="table-form" data-kind="next">${ICON.step}Крок</button>
</div>`;

const renderTable = (host) => {
  const table = state().table;
  const empty = !table.questions.length && !table.options.length && !table.settled.length && !table.facts.length && !table.next.length;
  if (empty) {
    host.innerHTML = `<div class="pempty">
      <h3>Стіл порожній</h3>
      <p>Коли є справжні альтернативи, агенти кладуть сюди питання й варіанти, заперечують і підтримують одне одного, додають докази. Ви бачите, де згода, а де суперечка, — і обираєте.</p>
      <p class="faint">Агенти роблять це самі. Або почніть ви:</p>
      ${tableToolbar()}
    </div>`;
    return;
  }
  const questions = [...table.questions].sort((a, b) => (a.status === b.status ? a.seq - b.seq : a.status === "open" ? -1 : 1));
  const loose = table.options.filter((o) => !o.q);
  // Keyed, so a live preview on one option does not reload when another part of the table changes.
  const parts = [["tools", tableToolbar()]];
  const where = whereHtml(table);
  if (where) parts.push(["where", where]);
  for (const q of questions) parts.push([`q-${q.id}`, questionHtml(q, table)]);
  if (loose.length) {
    parts.push([
      "loose",
      `<section class="qcard loose"><div class="qhead"><span class="faint">Пропозиції без окремого питання</span></div><div class="opts-list">${loose.map((o) => optionHtml(o, table, false)).join("")}</div></section>`,
    ]);
  }
  reconcile(host, parts);
  hydrateDiagrams();
};

// --- the canonical file ----------------------------------------------------

const docRevisions = () => {
  const st = state();
  const path = st?.settings.doc;
  return path ? (st.docRevisions ?? []).filter((r) => r.path === path) : [];
};

const loadDoc = async () => {
  const st = state();
  if (!st?.settings.doc) {
    S.doc = null;
    invalidate("doc");
    return;
  }
  const room = S.roomId;
  try {
    const doc = await api("GET", roomPath("/doc"));
    if (S.roomId === room) S.doc = doc;
  } catch (error) {
    if (error instanceof Unauthorized) return;
    if (S.roomId === room) S.doc = { error: error.message };
  }
  invalidate("doc");
};

const loadRevision = async (seq) => {
  if (S.docRevs.has(seq)) return;
  const room = S.roomId;
  S.docRevs.set(seq, { loading: true });
  try {
    const rev = await api("GET", `${roomPath("/doc")}?rev=${seq}`);
    if (S.roomId === room) S.docRevs.set(seq, rev);
  } catch (error) {
    if (S.roomId === room) S.docRevs.set(seq, { error: error.message });
  }
  invalidate("doc");
};

const revAuthor = (r) => (r.by === "agoryx" ? "Початкова версія" : nameOf(r.by));

const revWhere = (r) => {
  if (r.by === "agoryx") return "з неї кімната почала";
  const who = participant(r.by);
  if (r.turnId) return "хід у кімнаті";
  if (r.native && who?.agent) return `у своїй сесії`;
  return who?.agent ? "поза ходом" : "редактор або ця сторінка";
};

const diffHtml = (items) => {
  let oldN = 1;
  let newN = 1;
  const rows = [];
  for (const item of items) {
    if ("skip" in item) {
      rows.push(`<tr class="hunk"><td class="ln"></td><td>  … ${esc(plural(item.skip, "рядок", "рядки", "рядків"))} без змін</td></tr>`);
      oldN += item.skip;
      newN += item.skip;
    } else if (item.t === "+") {
      rows.push(`<tr class="add"><td class="ln">${newN++}</td><td>+ ${esc(item.s)}</td></tr>`);
    } else if (item.t === "-") {
      rows.push(`<tr class="del"><td class="ln">${oldN++}</td><td>− ${esc(item.s)}</td></tr>`);
    } else {
      rows.push(`<tr><td class="ln">${newN}</td><td>  ${esc(item.s)}</td></tr>`);
      oldN += 1;
      newN += 1;
    }
  }
  return `<div class="code diff"><table>${rows.join("")}</table></div>`;
};

const codeTable = (text, classify) => {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return `<div class="code"><table>${lines
    .map((line, index) => `<tr class="${classify ? classify(line) : ""}"><td class="ln">${index + 1}</td><td>${esc(line) || " "}</td></tr>`)
    .join("")}</table></div>`;
};

const docBody = (path, text) =>
  /^(md|markdown|txt)$/.test(ext(path)) || !ext(path)
    ? `<article class="paper"><div class="txt doctxt">${markdown(text, { ...mdCtx(), doc: true })}</div></article>`
    : codeTable(text);

const docConflictHtml = () => {
  const edit = S.docEdit;
  if (!edit?.conflict) {
    return edit?.stale
      ? `<div class="docnote">Тим часом файл змінено (${esc(nameOf(edit.stale))}). Збереження нічого не перезапише мовчки — спершу покажемо конфлікт.</div>`
      : "";
  }
  return `<div class="err-box docnote">Поки ви редагували, файл змінився. Ваш текст нікуди не дівся.
    <div class="row"><button class="btn sm" data-act="doc-theirs">Відкинути мою правку</button><button class="btn sm warn" data-act="doc-force">Зберегти мою поверх</button></div></div>`;
};

const renderDoc = (host) => {
  const st = state();
  const path = st.settings.doc;
  if (!path) {
    host.innerHTML = `<div class="pempty">
      <h3>Спільний документ</h3>
      <p>Кімната може писати один спільний текст — рішення, есе, специфікацію. Agoryx не каже, що в ньому має бути: лише пам'ятає кожну версію з автором і показує кожному агенту, що змінили інші.</p>
      <form class="form" data-form="doc-set">
        <label>Файл у робочій теці<input type="text" name="doc" value="README.md" spellcheck="false"></label>
        <div class="row start"><button class="btn primary" type="submit">Призначити</button></div>
      </form>
    </div>`;
    return;
  }
  const revs = docRevisions();

  // Editing: never re-render the textarea under the cursor; only the note above it.
  if (S.docEdit) {
    const area = host.querySelector("textarea.doced");
    if (area) {
      host.querySelector("#docNote").innerHTML = docConflictHtml();
      return;
    }
    host.innerHTML = `<form class="docedit" data-form="doc">
        <div class="docbar"><span class="path">${ICON.file}${esc(path)}</span><span class="faint">редагування</span></div>
        <div id="docNote">${docConflictHtml()}</div>
        <textarea class="doced" name="text" spellcheck="true" aria-label="${esc(path)}">${esc(S.docEdit.text)}</textarea>
        <div class="row"><span class="faint small">Правка не будить агентів — вони побачать диф у своєму наступному ході.</span><span class="grow"></span><button type="button" class="btn" data-act="doc-cancel">Скасувати</button><button class="btn primary" type="submit">Зберегти</button></div>
      </form>`;
    const ta = host.querySelector("textarea.doced");
    ta.addEventListener("input", () => {
      if (S.docEdit) S.docEdit.text = ta.value;
    });
    ta.focus();
    return;
  }

  if (S.docSel != null) {
    const r = revs.find((entry) => entry.seq === S.docSel);
    const rev = S.docRevs.get(S.docSel);
    if (!rev) loadRevision(S.docSel);
    let body = '<p class="faint">Завантажую…</p>';
    if (rev?.error) body = `<div class="err-box">${esc(rev.error)}</div>`;
    else if (rev && !rev.loading) {
      if (rev.truncated) body = '<p class="faint">Ця версія завелика (понад 256 КБ), тому Agoryx зберіг лише її відбиток і статистику.</p>';
      else if (rev.previous == null && rev.text != null) body = docBody(path, rev.text);
      else if (rev.text === null) body = '<p class="faint">У цій версії файл видалено.</p>';
      else body = rev.diff?.some((item) => item.t === "+" || item.t === "-") ? diffHtml(rev.diff) : '<p class="faint">Текст не змінився.</p>';
    }
    host.innerHTML = `<div class="docbar">
        <button class="btn sm" data-act="doc-history">← Історія</button>
        ${r ? `<span class="who">${avatar(r.by, 20)}<b>${esc(revAuthor(r))}</b></span><span class="faint small"><time title="${esc(fullDate(r.ts))}">${esc(ago(r.ts))}</time> · ${esc(revWhere(r))}${r.by === "agoryx" ? "" : ` · ${revStats(r)}`}</span>` : ""}
        <span class="grow"></span>
        ${r?.turnId ? `<button class="btn sm" data-act="doc-turn" data-turn="${esc(r.turnId)}">Хід у розмові</button>` : ""}
      </div>${body}`;
    return;
  }

  if (S.docHistory) {
    const items = [...revs]
      .reverse()
      .map((r) => {
        const who = participant(r.by);
        const nat = r.native && who?.agent ? ` <span class="nat ${who.cls}">у своїй сесії</span>` : "";
        return `<li><button class="rev" data-act="doc-rev" data-seq="${r.seq}">
          ${avatar(r.by, 22)}
          <span class="rw"><b>${esc(revAuthor(r))}</b>${nat}<small><time datetime="${esc(r.ts)}" title="${esc(fullDate(r.ts))}">${esc(ago(r.ts))}</time> · ${esc(revWhere(r))}</small></span>
          <span class="rs">${r.by === "agoryx" ? "" : revStats(r)}</span>
        </button></li>`;
      })
      .join("");
    host.innerHTML = `<div class="docbar"><button class="btn sm" data-act="doc-current">← Текст</button><span class="faint small">${esc(plural(revs.length, "версія", "версії", "версій"))} ${esc(path)}</span></div>
      <p class="faint small">Хто б і де б не змінив файл — хід у кімнаті, власна сесія агента чи ваш редактор, — версія лишається тут з автором, а інші бачать диф у своєму наступному ході.</p>
      <ul class="revs">${items || '<li class="faint">Версій ще немає.</li>'}</ul>`;
    return;
  }

  const doc = S.doc;
  if (!doc || doc.path !== path) {
    if (!doc?.error) loadDoc();
    host.innerHTML = doc?.error ? `<div class="err-box">${esc(doc.error)}</div>` : '<p class="faint">Завантажую…</p>';
    return;
  }
  const last = revs.at(-1);
  const canEdit = S.snap.driven;
  const bar = `<div class="docbar">
      <span class="path" title="Спільний документ кімнати">${ICON.file}${esc(path)}</span>
      <span class="grow"></span>
      ${revs.length ? `<button class="btn sm" data-act="doc-history" title="${last ? `Остання правка — ${esc(revAuthor(last))}, ${esc(ago(last.ts))}` : ""}">Історія · ${revs.length}</button>` : ""}
      ${canEdit ? `<button class="btn sm" data-act="doc-edit">${doc.exists ? "Редагувати" : "Почати"}</button>` : ""}
    </div>`;
  const body = doc.exists
    ? doc.text.trim()
      ? docBody(path, doc.text)
      : '<article class="paper"><p class="faint">Файл порожній.</p></article>'
    : `<article class="paper"><p class="faint">Файлу <code>${esc(path)}</code> ще немає. Агенти створять його, коли буде що записати, — або почніть ви.</p></article>`;
  host.innerHTML = bar + body;
};

const saveDoc = async (force = false) => {
  const edit = S.docEdit;
  if (!edit) return;
  const base = force && edit.conflict ? edit.conflict.hash : edit.base;
  try {
    const saved = await api("POST", roomPath("/doc"), { text: edit.text, base });
    S.docEdit = null;
    S.doc = { path: saved.path, text: saved.text, hash: saved.hash, exists: saved.exists };
    S.docSel = null;
    toast(saved.revision ? "Збережено — агенти побачать диф" : "Без змін");
  } catch (error) {
    if (error.status === 409) {
      edit.conflict = error.body?.current ?? null;
    } else if (!(error instanceof Unauthorized)) toast(error.message, true);
  }
  invalidate("doc");
};

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const openDialog = (title, sub, body, size = "md") => {
  S.dialog = { title };
  S.menu = false;
  els.dlgTitle.textContent = title;
  els.dlgSub.textContent = sub ?? "";
  els.dlgSub.hidden = !sub;
  els.dlgBody.innerHTML = body;
  els.dlg.className = `dlg ${size}`;
  els.modal.hidden = false;
  invalidate("header");
  const focus = els.dlgBody.querySelector("[autofocus], textarea, input, select") ?? els.dlg.querySelector(".dlg-h .iconbtn");
  setTimeout(() => focus?.focus(), 30);
};

const closeDialog = () => {
  S.dialog = null;
  els.modal.hidden = true;
  els.dlgBody.innerHTML = "";
};

const setDialogBody = (html) => {
  if (!S.dialog) return;
  els.dlgBody.innerHTML = html;
  hydrateDiagrams();
};

const showFile = async (path) => {
  const kind = ext(path);
  const url = `${S.snap.rawBase}${path.split("/").map(encodeURIComponent).join("/")}`;
  openDialog(fileName(path), path, '<p class="faint">Завантажую…</p>', "lg");
  try {
    if (IMAGE_EXT.has(kind) && kind !== "svg") {
      setDialogBody(`<img src="${esc(url)}" alt="${esc(path)}" class="bigimg"><div><a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">Відкрити окремо</a></div>`);
      return;
    }
    const file = await api("GET", `${roomPath("/file")}?path=${encodeURIComponent(path)}`);
    const meta = `<div class="faint small">${esc((file.size / 1024).toFixed(1))} КБ · змінено ${esc(fullDate(file.mtime))}${file.truncated ? " · показано початок" : ""}</div>`;
    let body = "";
    if (FRAME_EXT.has(kind) || kind === "svg") {
      body = `<iframe class="frame big" src="${esc(url)}" sandbox="allow-scripts allow-forms allow-modals" title="${esc(path)}"></iframe>
        <div><a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">Відкрити в новій вкладці</a></div>
        ${file.binary ? "" : `<details><summary>Код</summary>${codeTable(file.text)}</details>`}`;
    } else if (file.binary) {
      body = `<p class="faint">Двійковий файл — попередній перегляд недоступний.</p><div><a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">Відкрити</a></div>`;
    } else if (kind === "md" || kind === "markdown") {
      body = `<div class="txt">${markdown(file.text, mdCtx())}</div><details><summary>Сирий текст</summary>${codeTable(file.text)}</details>`;
    } else {
      body = codeTable(file.text);
    }
    setDialogBody(meta + body);
  } catch (error) {
    setDialogBody(`<div class="err-box">${esc(error.message)}</div>`);
  }
};

const classifyPatch = (line) =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")
    ? "fileh"
    : line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : "";

// One file's `diff --git` section of a turn's patch.
const patchSection = (patch, path) =>
  patch.split(/(?=^diff --git )/m).find((part) => {
    const first = part.split("\n", 1)[0];
    return first.startsWith("diff --git ") && (first.endsWith(` b/${path}`) || first.includes(` a/${path} `));
  }) ?? null;

const showTurnDiff = async (turnId, path) => {
  const st = state();
  const turn = st.turns.find((t) => t.id === turnId);
  const who = turn ? nameOf(turn.agent) : "";
  const sub = `${who}${turn?.endedAt ? ` · ${fullDate(turn.endedAt)}` : ""}`;
  if (S.dialog?.title !== `Що змінив хід ${turnId}`) openDialog(`Що змінив хід ${turnId}`, sub, '<p class="faint">Завантажую…</p>', "lg");
  try {
    const { changes, patch, truncated } = await api("GET", `${roomPath("/turn-diff")}?turn=${encodeURIComponent(turnId)}`);
    const narrowed = path && changes.length > 1;
    const rows = changes
      .map(
        (c) =>
          `<div class="chg${narrowed && c.path === path ? " on" : ""}"><button data-act="turn-diff" data-turn="${esc(turnId)}" data-path="${esc(c.path)}" class="mono ell" title="Показати лише цей файл">${esc(c.path)}</button><span class="stats">${changeStats(c)}</span>${
            c.status === "D" ? "" : `<button class="linkish small" data-act="file" data-path="${esc(c.path)}">файл</button>`
          }</div>`,
      )
      .join("");
    const shown = narrowed ? patchSection(patch, path) : null;
    const scope = narrowed ? `<div class="faint small">Лише ${esc(path)} · <button class="linkish" data-act="turn-diff" data-turn="${esc(turnId)}">усі файли ходу</button></div>` : "";
    const note = truncated ? `<div class="faint small">Патч великий — показано початок. Повністю: <span class="mono">agoryx diff ${esc(turnId)}</span></div>` : "";
    setDialogBody(`<div class="chgs">${rows}</div>${scope}${note}${codeTable(shown ?? patch, classifyPatch)}
      <p class="faint small">Точно те, що цей хід змінив у робочій теці: знімок git до і після ходу. Інші агенти бачать ці +/− у своїй дельті й можуть узяти патч командою <span class="mono">agoryx diff ${esc(turnId)}</span>.</p>`);
  } catch (error) {
    setDialogBody(`<div class="err-box">${esc(error.message)}</div>`);
  }
};

const showCommit = async (sha) => {
  openDialog(`Контрольна точка ${sha.slice(0, 7)}`, "git show", '<p class="faint">Завантажую…</p>', "lg");
  try {
    const { text } = await api("GET", `${roomPath("/commit")}?sha=${encodeURIComponent(sha)}`);
    setDialogBody(codeTable(text, classifyPatch));
  } catch (error) {
    setDialogBody(`<div class="err-box">${esc(error.message)}</div>`);
  }
};

const showFiles = async () => {
  const st = state();
  openDialog("Робоча тека", st.workspace, '<p class="faint">Завантажую…</p>');
  try {
    const { files } = await api("GET", roomPath("/tree"));
    const list = files.length
      ? `<div class="files">${files.map((f) => `<button data-act="file" data-path="${esc(f)}">${ICON.file}<span>${esc(f)}</span></button>`).join("")}</div>`
      : '<p class="faint">Поки що порожньо — агенти ще нічого не створили.</p>';
    setDialogBody(`<p class="faint small">Спільна git-тека кімнати. Агенти читають і пишуть тут (у пісочниці).</p>${list}`);
  } catch (error) {
    setDialogBody(`<div class="err-box">${esc(error.message)}</div>`);
  }
};

const copyButton = (text) => `<button class="btn sm" data-act="copy" data-text="${esc(text)}">Копіювати</button>`;

const showSessions = () => {
  const st = state();
  const rows = st.agents
    .map((a) => {
      const session = st.sessions[a.id];
      const command = S.snap.resume?.[a.id];
      return `<div class="cmd">
        ${avatar(a.id, 32)}
        <div class="who"><b>${esc(a.label)}</b><small>${session ? `сесія ${esc(session.sessionId)}` : "Ще не говорив у кімнаті — сесія з'явиться після першого ходу"}</small>${command ? `<code>${esc(command)}</code>` : ""}</div>
        ${command ? copyButton(command) : ""}
      </div>`;
    })
    .join("");
  openDialog(
    "Сесії агентів",
    "",
    `<p class="soft">Agoryx не перепаковує агентів: кожен працює у своїй справжній сесії, і розмова в кімнаті — це їхні ходи в цих сесіях. Відкрийте сесію в терміналі, щоб побачити все, що агент робив, або поговорити з ним сам-на-сам — кімната це теж побачить.</p>
     ${rows}
     <p class="faint small">Уся кімната в терміналі: <code>agoryx tail -f</code> · <code>agoryx say "…"</code> · <code>agoryx table</code></p>`,
  );
};

const showSettings = () => {
  const s = state().settings;
  openDialog(
    "Налаштування кімнати",
    state().name,
    `<form class="form" data-form="settings">
      <label>Ходів агентів на ваше повідомлення<input type="number" name="budget" min="1" max="100" value="${s.budget}"><small>Скільки ходів агенти роблять після вашого повідомлення, перш ніж зупинитися й чекати на вас.</small></label>
      <label>Доступ агентів<select name="access"><option value="workspace"${s.access === "workspace" ? " selected" : ""}>Читання і запис у робочій теці</option><option value="readonly"${s.access === "readonly" ? " selected" : ""}>Лише читання</option></select><small>Агенти завжди працюють у пісочниці; поза робочою текою писати не можуть.</small></label>
      <label class="check"><input type="checkbox" name="network"${s.network ? " checked" : ""}> Мережа для команд агентів</label>
      <label class="check"><input type="checkbox" name="autoCommit"${s.autoCommit ? " checked" : ""}> Контрольна точка (git commit) після кожного раунду</label>
      <label>Спільний документ<input type="text" name="doc" value="${esc(s.doc ?? "")}" placeholder="README.md" spellcheck="false"><small>Файл, який кімната пише разом. Порожньо — без нього.</small></label>
      <div class="row"><button type="button" class="btn" data-act="close-dialog">Скасувати</button><button class="btn primary" type="submit">Зберегти</button></div>
    </form>`,
    "sm",
  );
};

const showHelp = () => {
  openDialog(
    "Як це працює",
    "",
    `<div class="txt help">
      <p><b>Кімната</b> — одна розмова для вас, Claude і Codex. Agoryx задає контекст, а не ролі: агенти працюють у своїх рідних сесіях з усіма своїми інструментами.</p>
      <ul>
        <li>На ваше повідомлення агенти відповідають <b>незалежно</b> — одночасно, не бачачи одне одного.</li>
        <li>Далі вони говорять <b>по черзі</b>: кожен бачить усе, що сказано до нього. Хто не має що додати — пропускає хід.</li>
        <li>Після кількох ходів розмова зупиняється й чекає на вас. Кількість — у налаштуваннях кімнати.</li>
        <li><span class="at cl">@claude</span> чи <span class="at cx">@codex</span> — звернутися лише до одного.</li>
        <li><b>Стіл</b> — питання, варіанти, заперечення й рішення, коли є справжні альтернативи.</li>
        <li><b>Документ</b> — один спільний файл, кожна версія з автором.</li>
      </ul>
      <p>Без браузера: <code>agoryx tail -f</code>, <code>agoryx say "…"</code>, <code>agoryx table</code>. Сесію агента можна відкрити в Claude Code чи Codex — розмова там теж потрапить у кімнату.</p>
    </div>`,
  );
};

const TABLE_FORMS = {
  ask: { title: "Нове питання", fields: [["text", "Питання", "textarea", "Що треба вирішити?"]] },
  propose: { title: "Нова пропозиція", fields: [["title", "Коротка назва", "text", "напр. SQLite замість JSON"], ["body", "Що і чому", "textarea", ""], ["file", "Файл у робочій теці (необов'язково)", "text", "mockup.html"]] },
  object: { title: "Заперечення", fields: [["text", "Чому ні", "textarea", "Що саме не так і що змінило б вашу думку?"]] },
  support: { title: "Підтримка", fields: [["text", "Чому так", "textarea", ""]] },
  evidence: { title: "Доказ", fields: [["text", "Що встановлено", "textarea", ""], ["source", "Джерело (URL або файл)", "text", ""]] },
  decide: { title: "Обрати", fields: [["note", "Чому саме цей варіант (необов'язково)", "textarea", ""]] },
  settle: { title: "Узгоджено", fields: [["text", "Що тепер вважаємо встановленим", "textarea", ""]] },
  next: { title: "Наступний крок", fields: [["text", "Конкретна дія", "textarea", ""]] },
};

const showTableForm = (kind, id, q) => {
  const form = TABLE_FORMS[kind];
  if (!form) return;
  const table = state().table;
  const option = id ? table.options.find((o) => o.id === id) : undefined;
  let questionPicker = "";
  if (kind === "propose") {
    const open = table.questions.filter((x) => x.status === "open");
    questionPicker = open.length
      ? `<label>До питання<select name="q"><option value="">— без питання —</option>${open
          .map((x) => `<option value="${esc(x.id)}"${x.id === q ? " selected" : ""}>${esc(x.id)} · ${esc(x.text.slice(0, 80))}</option>`)
          .join("")}</select></label>`
      : "";
  }
  const fields = form.fields
    .map(([name, label, type, placeholder], index) =>
      type === "textarea"
        ? `<label>${esc(label)}<textarea name="${name}" placeholder="${esc(placeholder)}"${index === 0 ? " autofocus" : ""}${name === "text" && kind !== "decide" ? " required" : ""}></textarea></label>`
        : `<label>${esc(label)}<input type="text" name="${name}" placeholder="${esc(placeholder)}"${index === 0 ? " autofocus" : ""}${name === "title" ? " required" : ""}></label>`,
    )
    .join("");
  const context = option ? `<div class="ctx ${agentCls(option.by)}"><span class="oid">${esc(option.id)}</span><b>${esc(option.title)}</b><span class="faint small">${esc(nameOf(option.by))}</span></div>` : "";
  const verb = kind === "decide" ? `Обрати ${esc(id)}` : "Покласти на стіл";
  const hint = kind === "decide" ? "Рішення з'явиться в розмові, і агенти продовжать із нього." : "Агенти побачать це у своєму наступному ході.";
  openDialog(
    kind === "decide" ? `Обрати ${id}` : form.title,
    "",
    `<form class="form" data-form="table" data-kind="${kind}" data-id="${esc(id ?? "")}">${context}${fields}${questionPicker}<p class="faint small">${hint}</p>
      <div class="row"><button type="button" class="btn" data-act="close-dialog">Скасувати</button><button class="btn primary" type="submit">${verb}</button></div></form>`,
    "sm",
  );
};

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (form.dataset.form === "settings") {
      await api("POST", roomPath("/settings"), {
        budget: Math.max(1, Number.parseInt(data.budget, 10) || state().settings.budget),
        access: data.access,
        network: form.elements.network.checked,
        autoCommit: form.elements.autoCommit.checked,
        doc: data.doc?.trim() || null,
      });
      closeDialog();
      toast("Збережено");
    } else if (form.dataset.form === "doc") {
      if (S.docEdit) S.docEdit.text = form.elements.text.value;
      await saveDoc();
      if (submit) submit.disabled = false;
    } else if (form.dataset.form === "doc-set") {
      await api("POST", roomPath("/settings"), { doc: data.doc?.trim() || null });
      toast("Документ призначено");
    } else if (form.dataset.form === "new-room") {
      const text = (data.text ?? "").trim();
      if (!text) {
        if (submit) submit.disabled = false;
        return;
      }
      const budget = Number.parseInt(data.budget, 10);
      const { room } = await api("POST", "/api/rooms", {
        text,
        ...(data.dir?.trim() ? { dir: data.dir.trim() } : {}),
        ...(Number.isFinite(budget) && budget !== 8 ? { budget } : {}),
        ...(data.doc?.trim() ? { doc: data.doc.trim() } : {}),
      });
      store.set("draft.new", null);
      await loadRooms();
      location.hash = encodeURIComponent(room.id);
    } else if (form.dataset.form === "table") {
      const kind = form.dataset.kind;
      const id = form.dataset.id;
      const body = { op: kind };
      if (kind === "propose") {
        Object.assign(body, { title: data.title, ...(data.body ? { body: data.body } : {}), ...(data.file ? { file: data.file } : {}), ...(data.q ? { q: data.q } : {}) });
      } else if (kind === "decide") {
        Object.assign(body, { target: id, ...(data.note ? { note: data.note } : {}) });
      } else if (kind === "object" || kind === "support" || kind === "evidence") {
        Object.assign(body, { target: id, text: data.text, ...(data.source ? { source: data.source } : {}) });
      } else {
        body.text = data.text;
      }
      await api("POST", roomPath("/table"), body);
      closeDialog();
    }
  } catch (error) {
    if (!(error instanceof Unauthorized)) toast(error.message, true);
    if (submit) submit.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Click delegation
// ---------------------------------------------------------------------------

const flash = (node) => {
  node?.scrollIntoView({ behavior: "smooth", block: "center" });
  node?.animate?.([{ boxShadow: "0 0 0 3px var(--accent)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1400 });
};

const goToRef = (ref) => {
  if (!ref) return;
  const t = state().table;
  const isTable = [t.questions, t.options, t.notes, t.facts, t.settled, t.next].some((list) => list.some((item) => item.id === ref));
  if (!isTable) return;
  setPanel("table");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => flash(document.getElementById(ref.startsWith("Q") ? `q-${ref}` : ref.startsWith("P") ? `opt-${ref}` : `ti-${ref}`))),
  );
};

const onClick = async (event) => {
  if (S.menu && !event.target.closest(".menu-wrap")) setMenu(false);
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;
  switch (act) {
    case "nav":
      els.app.classList.toggle("nav");
      break;
    case "room":
      els.app.classList.remove("nav");
      if (target.dataset.id === S.roomId && S.view === "room") break;
      location.hash = encodeURIComponent(target.dataset.id);
      break;
    case "new-room":
      els.app.classList.remove("nav");
      if (location.hash === "#new") showStart();
      else location.hash = "new";
      break;
    case "help":
      els.app.classList.remove("nav");
      showHelp();
      break;
    case "theme": {
      const now = THEMES.indexOf(store.get("theme"));
      store.set("theme", THEMES[(now + 1) % THEMES.length]);
      applyTheme();
      invalidate("feed", "panel"); // diagrams are drawn per theme
      break;
    }
    case "menu":
      setMenu(!S.menu);
      break;
    case "rename":
      S.renaming = true;
      invalidate("header");
      break;
    case "panel": {
      const panel = target.dataset.panel;
      // The header buttons toggle; the panel's own tabs only switch.
      setPanel(S.panel === panel && target.classList.contains("hbtn") ? null : panel);
      break;
    }
    case "close-panel":
      setPanel(null);
      break;
    case "wide":
      S.wide = !S.wide;
      store.set("wide", S.wide ? "1" : null);
      layoutPanel();
      invalidate("panel");
      break;
    case "jump":
      els.feed.scrollTo({ top: els.feed.scrollHeight, behavior: "smooth" });
      break;
    case "trace": {
      const id = target.dataset.turn;
      if (S.openTraces.has(id)) S.openTraces.delete(id);
      else S.openTraces.add(id);
      invalidate("feed");
      break;
    }
    case "file":
      event.preventDefault();
      showFile(target.dataset.path);
      break;
    case "commit":
      showCommit(target.dataset.sha);
      break;
    case "turn-diff":
      showTurnDiff(target.dataset.turn, target.dataset.path);
      break;
    case "files":
      showFiles();
      break;
    case "sessions":
      showSessions();
      break;
    case "settings":
      showSettings();
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "ref":
      if (S.dialog) closeDialog();
      goToRef(target.dataset.ref);
      break;
    case "mention": {
      const who = `@${target.dataset.who} `;
      const ta = els.ctext;
      const start = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const pad = before && !/\s$/.test(before) ? " " : "";
      ta.value = `${before}${pad}${who}${ta.value.slice(ta.selectionEnd ?? start)}`;
      ta.focus();
      const pos = before.length + pad.length + who.length;
      ta.setSelectionRange(pos, pos);
      autosize(ta);
      syncSend();
      break;
    }
    case "stop":
      target.disabled = true;
      api("POST", roomPath("/stop"), {}).catch((error) => toast(error.message, true));
      break;
    case "more":
      target.disabled = true;
      api("POST", roomPath("/continue"), {}).catch((error) => {
        toast(error.message, true);
        target.disabled = false;
      });
      break;
    case "table-form":
      showTableForm(target.dataset.kind, target.dataset.id || undefined, target.dataset.q || undefined);
      break;
    case "done":
      target.disabled = true;
      api("POST", roomPath("/table"), { op: "done", target: target.dataset.id }).catch((error) => toast(error.message, true));
      break;
    case "doc-open":
      S.docSel = Number(target.dataset.seq);
      S.docEdit = null;
      setPanel("doc");
      break;
    case "doc-rev":
      S.docSel = Number(target.dataset.seq);
      invalidate("doc");
      break;
    case "doc-history":
      S.docSel = null;
      S.docHistory = true;
      invalidate("doc");
      break;
    case "doc-current":
      S.docSel = null;
      S.docHistory = false;
      loadDoc();
      break;
    case "doc-edit":
      S.docSel = null;
      S.docHistory = false;
      S.docEdit = { base: S.doc?.hash ?? "", text: S.doc?.text ?? "" };
      invalidate("doc");
      break;
    case "doc-cancel":
    case "doc-theirs":
      S.docEdit = null;
      loadDoc();
      break;
    case "doc-force":
      saveDoc(true);
      break;
    case "doc-turn": {
      const message = state().messages.find((m) => m.turnId === target.dataset.turn);
      if (message) flash(document.getElementById(`m-${message.id}`));
      break;
    }
    case "card-more": {
      const body = target.closest(".tc-body");
      body?.classList.remove("clamp");
      target.remove();
      const owner = body?.closest("[data-key]");
      if (owner) owner.__html = null;
      break;
    }
    case "copy": {
      const text = target.dataset.text;
      try {
        await navigator.clipboard.writeText(text);
        toast("Скопійовано");
      } catch {
        const code = (target.closest(".codeblk") ?? target.parentElement).querySelector("code");
        if (code) getSelection().selectAllChildren(code);
        toast("Виділено — натисніть ⌘C");
      }
      break;
    }
    default:
      break;
  }
};

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

const upsert = (list, item) => {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = item;
};

const applyPatch = (event, patch) => {
  const st = state();
  if (!st || event.seq <= st.seq) return;
  st.seq = event.seq;
  if (patch.runs) st.runs = patch.runs;
  if (patch.presence) S.snap.presence = patch.presence;
  if (patch.message) upsert(st.messages, patch.message);
  if (patch.turn) upsert(st.turns, patch.turn);
  if (patch.cursors) st.cursors = patch.cursors;
  if (patch.sessions) st.sessions = patch.sessions;
  if (patch.table) st.table = patch.table;
  if (patch.settings) st.settings = patch.settings;
  if (patch.commits) st.commits = patch.commits;
  if (patch.docRevisions) st.docRevisions = patch.docRevisions;
  if (patch.name) {
    st.name = patch.name;
    const room = S.rooms.find((r) => r.id === S.roomId);
    if (room) room.name = patch.name;
    invalidate("side", "header");
  }
  if (patch.activity) {
    const turn = st.turns.find((t) => t.id === patch.activity.turnId);
    if (turn) upsert(turn.activity, patch.activity.activity);
  }
  if (event.type === "table.op") S.snap.ops.push({ seq: event.seq, ts: event.ts, op: event.op });
  if (event.type === "turn.ended") delete S.snap.streams[event.turnId];
  if (event.type === "turn.started") S.snap.streams[event.turnId] = { agent: event.agent, text: "" };

  if (event.type === "turn.activity") {
    // cheap path: refresh the live card's trace only
    const trace = document.querySelector(`[data-trace="${CSS.escape(event.turnId)}"]`);
    const turn = st.turns.find((t) => t.id === event.turnId);
    if (trace && turn?.status === "running") {
      trace.innerHTML = turn.activity.slice(-3).map(activityHtml).join("");
      trace.hidden = false;
      keepPinned();
      return;
    }
  }
  const parts = ["feed", "status", "header"];
  if (event.type === "table.op" || event.type === "message.posted") parts.push("table");
  if (event.type === "doc.revised" || event.type === "settings.changed") {
    parts.push("doc");
    if (event.type === "settings.changed" && "doc" in (event.patch ?? {})) {
      S.doc = null;
      S.docSel = null;
      S.docEdit = null;
      S.docHistory = false;
    }
    if (S.docEdit && event.type === "doc.revised" && event.hash !== S.docEdit.base) S.docEdit.stale = event.by;
    else if (S.panel === "doc" && !S.docEdit) loadDoc();
  }
  invalidate(...parts);
  if (event.type === "turn.started" || event.type === "turn.ended" || event.type === "message.posted") {
    const room = S.rooms.find((r) => r.id === S.roomId);
    if (room) {
      room.running = st.turns.some((t) => t.status === "running");
      if (event.type === "message.posted" && event.message?.kind !== "pass" && event.message?.kind !== "system") room.lastMessage = { author: event.message.author, text: event.message.text.slice(0, 200) };
      room.updatedAt = event.ts;
      invalidate("side");
    }
  }
};

const keepPinned = () => {
  if (distanceFromBottom() < 200) els.feed.scrollTop = els.feed.scrollHeight;
};

const applyStream = (event) => {
  if (!S.snap) return;
  const buffer = S.snap.streams[event.turnId] ?? { agent: event.agent, text: "" };
  buffer.text = event.reset ? event.text : buffer.text + event.text;
  S.snap.streams[event.turnId] = buffer;
  const node = document.querySelector(`[data-stream="${CSS.escape(event.turnId)}"]`);
  if (node) {
    node.textContent = buffer.text.slice(-2400);
    keepPinned();
  } else {
    invalidate("feed");
  }
};

const closeStream = () => {
  if (S.es) S.es.close();
  S.es = null;
  clearTimeout(S.reconnectTimer);
};

const connect = () => {
  closeStream();
  const id = S.roomId;
  const es = new EventSource(`${roomPath("/events")}?after=${state().seq}`);
  S.es = es;
  es.addEventListener("room", (message) => {
    if (S.roomId !== id) return;
    const { event, patch } = JSON.parse(message.data);
    applyPatch(event, patch);
  });
  es.addEventListener("stream", (message) => {
    if (S.roomId !== id) return;
    applyStream(JSON.parse(message.data));
  });
  es.addEventListener("presence", (message) => {
    if (S.roomId !== id || !S.snap) return;
    S.snap.presence = JSON.parse(message.data).agents;
    invalidate("header", "status", "feed");
  });
  es.onerror = () => {
    es.close();
    if (S.es !== es) return;
    S.es = null;
    S.reconnectTimer = setTimeout(() => {
      if (S.roomId === id && S.view === "room") openRoom(id, { quiet: true });
    }, 1500);
  };
};

const openRoom = async (id, { quiet = false } = {}) => {
  const switching = S.roomId !== id || S.view !== "room";
  S.view = "room";
  S.roomId = id;
  if (!quiet) {
    S.firstPaint = true;
    S.seenMessages.clear();
    S.openTraces.clear();
    S.doc = null;
    S.docSel = null;
    S.docHistory = false;
    S.docEdit = null;
    S.docRevs.clear();
    S.renaming = false;
    S.menu = false;
  }
  if (switching) {
    els.start.hidden = true;
    els.start.innerHTML = "";
    els.conv.hidden = false;
    renderSide();
  }
  try {
    const snap = await api("GET", `/api/rooms/${encodeURIComponent(id)}`);
    if (S.roomId !== id || S.view !== "room") return;
    snap.ops ??= [];
    snap.streams ??= {};
    S.snap = snap;
    S.roomId = snap.state.id;
    if (!quiet) {
      els.ctext.value = store.get(`draft.${S.roomId}`) ?? "";
      autosize(els.ctext);
    }
    if (S.panel === "doc" && !S.docEdit) loadDoc();
    layoutPanel();
    invalidate("side", "header", "feed", "status", "panel");
    connect();
    if (!quiet && S.snap.driven && matchMedia("(min-width: 761px)").matches) setTimeout(() => els.ctext.focus(), 50);
  } catch (error) {
    if (error instanceof Unauthorized) return;
    if (!quiet) {
      toast(error.status === 404 ? "Такої кімнати немає" : error.message, true);
      if (error.status === 404) location.hash = S.rooms[0] ? encodeURIComponent(S.rooms[0].id) : "new";
    } else S.reconnectTimer = setTimeout(() => S.roomId === id && openRoom(id, { quiet: true }), 3000);
  }
};

const route = () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id || id === "new") {
    if (!id && S.rooms[0]) {
      history.replaceState(null, "", `#${encodeURIComponent(S.rooms[0].id)}`);
      openRoom(S.rooms[0].id);
      return;
    }
    showStart();
    return;
  }
  if (id !== S.roomId || S.view !== "room") openRoom(id);
};

// ---------------------------------------------------------------------------
// Gate + toast
// ---------------------------------------------------------------------------

function showGate() {
  closeStream();
  root.innerHTML = `<div class="gate"><div class="box">
    <h1>Потрібен вхід</h1>
    <p>Ця сторінка — локальне вікно в демон Agoryx. Щоб відкрити її з доступом, запустіть у терміналі:</p>
    <p><code>agoryx open</code></p>
    <p class="faint small">Команда відкриє браузер з одноразовим посиланням, і сторінка запам'ятає доступ на 30 днів.</p>
  </div></div>`;
}

let toastTimer = 0;
const toast = (text, error = false) => {
  let node = document.querySelector(".toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.toggle("err", error);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, error ? 6000 : 2200);
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Live blocks report their height (see FRAME_REPORTER in daemon.ts); nothing else is read from them. */
const onFrameMessage = (event) => {
  const h = event.data && event.data.agoryxFrame === 1 ? Number(event.data.h) : 0;
  if (!h || !Number.isFinite(h)) return;
  for (const frame of document.querySelectorAll("figure.viz.vlive iframe")) {
    if (frame.contentWindow !== event.source) continue;
    const max = frame.closest(".dlg") ? 2000 : 720;
    frame.style.height = `${Math.min(Math.max(Math.ceil(h), 80), max)}px`;
  }
};

const boot = async () => {
  addEventListener("message", onFrameMessage);
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => invalidate("feed", "panel"));
  const panel = store.get("panel");
  if (panel === "table" || panel === "doc") S.panel = panel;
  S.wide = store.get("wide") === "1";
  buildShell();
  try {
    await loadRooms();
  } catch (error) {
    if (!(error instanceof Unauthorized)) {
      root.innerHTML = `<div class="gate"><div class="box"><h1>Демон не відповідає</h1><p>${esc(error.message)}</p><p><code>agoryx up -d</code></p></div></div>`;
    }
    return;
  }
  renderSide();
  route();
};

boot();
