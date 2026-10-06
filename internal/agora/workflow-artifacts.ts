/** Returned workflow files, as text. These paths are names inside the artifact bundle, never host paths. */
export interface WorkflowArtifact {
  path: string;
  downloadName: string;
  language: string;
  text: string;
}

const EXTENSIONS: Record<string, string> = {
  html: "html",
  htm: "html",
  svg: "svg",
  javascript: "js",
  js: "js",
  mjs: "mjs",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  css: "css",
  python: "py",
  py: "py",
  json: "json",
  markdown: "md",
  md: "md",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  sh: "sh",
  bash: "sh",
  text: "txt",
  txt: "txt",
  rust: "rs",
  go: "go",
  ruby: "rb",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  java: "java",
  xml: "xml",
  toml: "toml",
};
const LANGUAGE: Record<string, string> = {
  htm: "html",
  mjs: "javascript",
  js: "javascript",
  ts: "typescript",
  py: "python",
  md: "markdown",
  yml: "yaml",
  rs: "rust",
  rb: "ruby",
  cs: "csharp",
};
const extension = (path: string) =>
  path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "txt";

/** Reject absolute and traversing names; flatten only the filename used for a browser download. */
export function safeArtifactPath(raw: string): string | null {
  const path = raw.trim().replace(/\\/g, "/");
  if (
    !path ||
    /^[\/~]/.test(path) ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "..")) return null;
  const clean = parts.filter((part) => part && part !== ".").join("/");
  return clean || null;
}
const downloadName = (path: string): string => {
  const name = (path.split("/").at(-1) ?? "artifact.txt")
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  return name && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ? name
    : `artifact-${name || "text.txt"}`;
};

/**
 * The executor emits `Artifact: folder/name.ext` followed by an untyped fence longer than
 * every backtick run in that file. Ordinary typed fences are the fallback when no named files
 * exist; echoed source and verification snippets are not extra files in an exported bundle. A named
 * export's exact bytes are recovered by removing only the newline inserted before its closer.
 */
export function parseWorkflowArtifacts(text: string): WorkflowArtifact[] {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)]
    .filter((match) => match[0].length)
    .map((match) => ({
      text: match[0].replace(/(?:\r\n|\n|\r)$/, ""),
      start: match.index,
      end: match.index + match[0].length,
    }));
  const result: WorkflowArtifact[] = [];
  const namedExports = new Map<string, WorkflowArtifact>();
  let pendingName: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const named = line.text.match(/^Artifact:\s+(.+)$/);
    if (named) {
      pendingName = named[1]!;
      continue;
    }
    const opener = line.text.match(/^ {0,3}(`{3,}|~{3,})([^`]*?)\s*$/);
    if (!opener) {
      if (line.text.trim()) pendingName = null;
      continue;
    }
    const fence = opener[1]!;
    const language = opener[2]!.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    let close = i + 1;
    for (; close < lines.length; close++) {
      const candidate = lines[close]!.text.trim();
      if (
        candidate.length >= fence.length &&
        [...candidate].every((char) => char === fence[0])
      )
        break;
    }
    if (close === lines.length) break;
    const namedPath = pendingName ? safeArtifactPath(pendingName) : null;
    // Unsafe names stay ordinary displayed prose, not downloadable files or preview dependencies.
    // A ```viz block is the answer's own summary card, drawn on the board, not a file it delivers.
    if ((!pendingName && language && language !== "viz") || namedPath) {
      const path =
        namedPath ??
        `artifact-${result.length + 1}.${EXTENSIONS[language] ?? "txt"}`;
      const block = text.slice(line.end, lines[close]!.start);
      // Named executor exports append exactly LF; a file's own trailing CR must survive.
      const body = namedPath
        ? block.replace(/\n$/, "")
        : block.replace(/(?:\r\n|\n|\r)$/, "");
      const inferred = LANGUAGE[extension(path)] ?? extension(path);
      const artifact = {
        path,
        downloadName: downloadName(path),
        language: namedPath ? inferred : language,
        text: body,
      };
      result.push(artifact);
      if (namedPath) namedExports.set(namedPath, artifact);
    }
    pendingName = null;
    i = close;
  }
  return namedExports.size ? [...namedExports.values()] : result;
}

/** Resolve a URL only against returned bundle files, never the room or the host filesystem. */
export function resolveArtifactReference(
  from: string,
  reference: string,
): string | null {
  let value = reference.trim();
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  )
    return null;
  try {
    value = decodeURIComponent(value.split(/[?#]/, 1)[0]!);
  } catch {
    return null;
  }
  if (
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    value.startsWith("//")
  )
    return null;
  const parts = value.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return safeArtifactPath(parts.join("/"));
}

/** The index page is preferred; otherwise use the first standalone HTML or SVG output. */
export function visualArtifact(
  files: WorkflowArtifact[],
): WorkflowArtifact | undefined {
  return (
    files.find((file) => /(?:^|\/)index\.html?$/i.test(file.path)) ??
    files.find((file) => ["html", "htm"].includes(file.language)) ??
    files.find((file) => file.language === "svg")
  );
}

const attr = (tag: string, name: string): string | null => {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match
    ? (match[1] ?? match[2] ?? match[3] ?? "").replace(/&amp;/gi, "&")
    : null;
};
const escapeAttribute = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const inlineText = (value: string, tag: "style" | "script") =>
  value.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/** Inline returned local dependencies. Missing files and external packages remain blocked by the preview policy. */
export function bundleArtifactHtml(
  files: WorkflowArtifact[],
  primary: WorkflowArtifact,
): string {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const resolveFile = (from: string, reference: string) => {
    const path = resolveArtifactReference(from, reference);
    return path ? byPath.get(path) : undefined;
  };
  const svgUrl = (file: WorkflowArtifact) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`;
  const css = (file: WorkflowArtifact) =>
    file.text.replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (original, _quote: string, path: string) => {
        const dependency = resolveFile(file.path, path);
        return dependency?.language === "svg"
          ? `url("${svgUrl(dependency)}")`
          : original;
      },
    );
  let html = primary.text;
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = attr(tag, "href");
    const dependency = href ? resolveFile(primary.path, href) : undefined;
    return attr(tag, "rel")?.toLowerCase() === "stylesheet" &&
      dependency?.language === "css"
      ? `<style>${inlineText(css(dependency), "style")}</style>`
      : tag;
  });
  html = html.replace(
    /<script\b([^>]*)>\s*<\/script\s*>/gi,
    (original, attributes: string) => {
      const source = attr(attributes, "src");
      const dependency = source ? resolveFile(primary.path, source) : undefined;
      if (
        !dependency ||
        !["javascript", "js", "mjs"].includes(dependency.language)
      )
        return original;
      const type = attr(attributes, "type");
      return `<script${type ? ` type="${escapeAttribute(type)}"` : ""}>${inlineText(dependency.text, "script")}</script>`;
    },
  );
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const source = attr(tag, "src");
    const dependency = source ? resolveFile(primary.path, source) : undefined;
    return dependency?.language === "svg"
      ? tag.replace(
          /\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
          `src="${escapeAttribute(svgUrl(dependency))}"`,
        )
      : tag;
  });
  return html;
}

/**
 * The untrusted page lives in a second, separately sandboxed opaque-origin frame. The trusted
 * outer frame's CSP constrains its child's navigations as well as initial loading; generated
 * scripts cannot change that policy or navigate a parent. Both layers restrict resource loads.
 */
export function artifactPreviewDocument(
  files: WorkflowArtifact[],
  primary: WorkflowArtifact,
): string {
  const common =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
  const inner = `<meta http-equiv="Content-Security-Policy" content="${common}; frame-src 'none'"><style>body{margin:0;background:white;color:#111;font-family:system-ui}svg{max-width:100%;height:auto}</style>${bundleArtifactHtml(files, primary)}`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${common}; frame-src about:"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0;background:white}</style><iframe title="Returned artifact" sandbox="allow-scripts" srcdoc="${escapeAttribute(inner)}"></iframe>`;
}
