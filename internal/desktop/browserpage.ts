import { isIP } from "node:net";

/**
 * The room's browser pane, the parts that need no Electron (docs/plans/2026-09-29-desktop-browser-pane.md, B2):
 * which addresses the pane may open, the refs a snapshot hands out, the snapshot's outline, and the key strokes
 * browser_press sends. The pane (desktop/src/browserpane.ts) loads this file from dist/ at runtime.
 */

export { browserStep } from "../agora/browsertools.js";

export type UrlError = "empty" | "too-long" | "invalid" | "scheme" | "agoryx";

/** For agents, in English; the UI has its own Ukrainian text for each code. */
export const URL_ERROR_TEXT: Record<UrlError, string> = {
  empty: "the address is empty",
  "too-long": "the address is longer than 8000 characters",
  invalid: "this is not a web address",
  scheme: "only http and https pages (and about:blank) can be opened",
  agoryx: "this is an address of Agoryx itself, which the room's browser never opens",
};

const MAX_URL = 8_000;

/** The ports an Agoryx daemon takes: 7717 and the next 19 (daemon.ts tries 20 in a row). */
export const AGORYX_PORTS: readonly number[] = Array.from({ length: 20 }, (_, index) => 7717 + index);

/** An IPv6 address as eight 16-bit groups, or null. The input is one net.isIP() already accepted. */
const ipv6Groups = (address: string): number[] | null => {
  let text = address;
  const tail: number[] = [];
  // An embedded IPv4 tail (::ffff:127.0.0.1) is two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, dotted.index) + "0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = 8 - head.length - rest.length - (tail.length ? 1 : 0);
  if (halves.length === 1 && fill !== 0) return null;
  const groups = [...head, ...Array<number>(Math.max(0, fill)).fill(0), ...rest];
  // The "0" that stood in for the IPv4 tail is replaced by its two groups.
  if (tail.length) groups.splice(groups.length - 1, 1, ...tail);
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
};

/**
 * This machine, by name or number: `localhost`, `*.localhost`, 127.0.0.0/8, 0.0.0.0, ::1, :: and the
 * IPv4-mapped ::ffff:127.0.0.0/104 and ::ffff:0.0.0.0 (which reaches a 127.0.0.1 listener on macOS). The URL parser has already turned `127.1`, `0x7f.1` and `2130706433`
 * into 127.0.0.1, and `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`.
 */
export const isLoopbackHost = (hostname: string): boolean => {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  if (family === 4) return host.split(".")[0] === "127" || host === "0.0.0.0";
  if (family !== 6) return false;
  const groups = ipv6Groups(host);
  if (!groups) return false;
  const zeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (zeros(7) && (groups[7] === 1 || groups[7] === 0)) return true;
  if (!zeros(5) || groups[5] !== 0xffff) return false;
  return (groups[6]! >> 8) === 0x7f || (groups[6] === 0 && groups[7] === 0);
};

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443 };

const effectivePort = (url: URL): number => (url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 0));

/** A loopback address on a port an Agoryx daemon may use: one of AGORYX_PORTS, or one the app has seen. */
export const isAgoryxAddress = (url: string, seen: ReadonlySet<number>): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isLoopbackHost(parsed.hostname)) return false;
  const port = effectivePort(parsed);
  return AGORYX_PORTS.includes(port) || seen.has(port);
};

/** A bare `host[:port][/path]`, which the pane reads as a web address, as the MCP server's step labels do. */
const isBare = (input: string): boolean => !/^[a-z][a-z\d+.-]*:/i.test(input) || /^[^/:]+:\d+(?:[/?#]|$)/.test(input);

/**
 * What the pane may open: http(s), and exactly about:blank. A bare host gets http:// when it is this
 * machine (a dev server) and https:// otherwise. An address of Agoryx itself is refused: `blocked` says
 * which loopback ports are Agoryx's.
 */
export const paneUrl = (input: string, blocked: (port: number) => boolean): { url: string } | { error: UrlError } => {
  const given = input.trim();
  if (!given) return { error: "empty" };
  if (given.length > MAX_URL) return { error: "too-long" };
  let url: URL;
  try {
    if (isBare(given)) {
      const probe = new URL(`http://${given}`);
      url = isLoopbackHost(probe.hostname) ? probe : new URL(`https://${given}`);
    } else {
      url = new URL(given);
    }
  } catch {
    return { error: "invalid" };
  }
  if (url.href === "about:blank") return { url: url.href };
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "scheme" };
  if (!url.hostname) return { error: "invalid" };
  if (isLoopbackHost(url.hostname) && blocked(effectivePort(url))) return { error: "agoryx" };
  return { url: url.href };
};

/**
 * Snapshot refs (e1, e2, …) and the DOM nodes they stand for. A node keeps its ref while it lives; a new
 * document drops the old mappings, but numbers are never handed out twice, so a stale ref can only fail,
 * never hit another element.
 */
export class RefTable {
  private next = 1;
  private readonly byNode = new Map<number, string>();
  private readonly byRef = new Map<string, number>();

  ref(backendNodeId: number): string {
    const known = this.byNode.get(backendNodeId);
    if (known) return known;
    const ref = `e${this.next++}`;
    this.byNode.set(backendNodeId, ref);
    this.byRef.set(ref, backendNodeId);
    return ref;
  }

  node(ref: string): number | undefined {
    return this.byRef.get(ref);
  }

  forgetDocument(): void {
    this.byNode.clear();
    this.byRef.clear();
  }
}

/** The fields of a CDP Accessibility.AXNode that the outline reads. */
export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** Roles an agent acts on: they get a ref even without a name. */
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem", "gridcell",
  "PopUpButton", "ToggleButton", "MenuListOption", "ListBoxOption", "DisclosureTriangle", "ColorWell",
  "Date", "DateTime", "InputTime",
]);
/** Wrappers that say nothing without a name: dropped, their children move up. */
const WRAPPERS = new Set(["generic", "none", "presentation"]);
/** The document itself (its name is the title, which the result's `Page:` line has): its children move up. */
const DOCUMENTS = new Set(["RootWebArea", "WebArea"]);
/** Never shown: the text boxes Chromium splits text into, and line breaks. */
const NOISE = new Set(["LineBreak", "InlineTextBox"]);
const MAX_NAME = 300;
const REF_WIDTH = " [ref=e]".length + 10;

const text = (value: AXValue | undefined): string => {
  const raw = value?.value;
  return typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** `[level=2] [checked] [disabled] …` from the node's properties. */
const attributes = (node: AXNode): string[] => {
  const found: string[] = [];
  for (const property of node.properties ?? []) {
    const value = property.value.value;
    switch (property.name) {
      case "level":
        if (typeof value === "number") found.push(`[level=${value}]`);
        break;
      case "checked":
      case "pressed":
        if (value === "true" || value === true) found.push(`[${property.name}]`);
        else if (value === "mixed") found.push(`[${property.name}=mixed]`);
        break;
      case "expanded":
        found.push(value === true || value === "true" ? "[expanded]" : "[expanded=false]");
        break;
      case "selected":
      case "disabled":
      case "required":
      case "readonly":
      case "focused":
      case "modal":
        if (value === true || value === "true") found.push(`[${property.name}]`);
        break;
      case "invalid":
        if (typeof value === "string" && value !== "false") found.push("[invalid]");
        break;
    }
  }
  return found;
};

const urlOf = (node: AXNode): string => {
  const property = node.properties?.find((item) => item.name === "url");
  return property ? text(property.value) : "";
};

/**
 * The page as an outline, from CDP's full AX tree: `- role "name" [level=2] [checked] [ref=e7]: value`, one
 * line per node, indented by depth. Text is `- text: "…"`, a link ends with `-> <href>`. Refs go to nodes an
 * agent can act on or that have a name; they are handed out only for the lines that are shown.
 */
export const formatSnapshot = (nodes: AXNode[], refs: RefTable, { maxChars = 40_000 }: { maxChars?: number } = {}): string => {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  interface Line {
    depth: number;
    head: string;
    node?: number;
    tail: string;
  }
  const lines: Line[] = [];
  const seen = new Set<string>();
  const visit = (node: AXNode, depth: number, parentName: string): void => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = text(node.role);
    const name = oneLine(text(node.name));
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((child): child is AXNode => child !== undefined);
    const hoist = () => {
      for (const child of children) visit(child, depth, parentName);
    };
    if (NOISE.has(role)) return;
    if (node.ignored || !role || DOCUMENTS.has(role) || (WRAPPERS.has(role) && !name)) {
      hoist();
      return;
    }
    if (role === "StaticText") {
      if (name && !oneLine(parentName).includes(name)) lines.push({ depth, head: `- text: ${JSON.stringify(clip(name, MAX_NAME))}`, tail: "" });
      return;
    }
    let head = `- ${role}`;
    if (name) head += ` ${JSON.stringify(clip(name, MAX_NAME))}`;
    const attrs = attributes(node);
    if (attrs.length) head += ` ${attrs.join(" ")}`;
    let tail = "";
    const href = role === "link" ? urlOf(node) : "";
    if (href) tail += ` -> ${href}`;
    const value = oneLine(text(node.value));
    if (value && value !== name) tail += `: ${clip(value, MAX_NAME)}`;
    const wantsRef = node.backendDOMNodeId !== undefined && (INTERACTIVE.has(role) || name !== "");
    lines.push({ depth, head, tail, ...(wantsRef ? { node: node.backendDOMNodeId } : {}) });
    for (const child of children) visit(child, depth + 1, name || parentName);
  };
  for (const root of roots) visit(root, 0, "");

  const out: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    const indent = "  ".repeat(line.depth);
    // A ref is handed out only for a line that fits (` [ref=e…]` counted at its longest).
    if (size + indent.length + line.head.length + line.tail.length + (line.node === undefined ? 0 : REF_WIDTH) + 1 > maxChars) {
      out.push(`… ${lines.length - index} more nodes (scroll, or narrow down with browser_eval)`);
      break;
    }
    const ref = line.node === undefined ? "" : ` [ref=${refs.ref(line.node)}]`;
    const rendered = `${indent}${line.head}${ref}${line.tail}`;
    out.push(rendered);
    size += rendered.length + 1;
  }
  return out.join("\n");
};

/** The fields of one CDP Input.dispatchKeyEvent. There is no `commands` field: nothing reaches the clipboard. */
export interface KeyStroke {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}

interface KeyDefinition {
  /** The name browser_press takes, when it is not the key itself (Space). */
  name?: string;
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: KeyDefinition[] = [
  { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  { key: "Tab", code: "Tab", keyCode: 9 },
  { key: "Escape", code: "Escape", keyCode: 27 },
  { key: "Backspace", code: "Backspace", keyCode: 8 },
  { key: "Delete", code: "Delete", keyCode: 46 },
  { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  { key: "Home", code: "Home", keyCode: 36 },
  { key: "End", code: "End", keyCode: 35 },
  { key: "PageUp", code: "PageUp", keyCode: 33 },
  { key: "PageDown", code: "PageDown", keyCode: 34 },
  { name: "Space", key: " ", code: "Space", keyCode: 32, text: " " },
  ...Array.from({ length: 12 }, (_, index) => ({ key: `F${index + 1}`, code: `F${index + 1}`, keyCode: 112 + index })),
];

/** The US layout's punctuation keys, for their codes. */
const PUNCTUATION: Record<string, [code: string, keyCode: number]> = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};

const MODIFIER_KEYS: Record<string, { bit: number; key: string; code: string; keyCode: number }> = {
  alt: { bit: 1, key: "Alt", code: "AltLeft", keyCode: 18 },
  option: { bit: 1, key: "Alt", code: "AltLeft", keyCode: 18 },
  control: { bit: 2, key: "Control", code: "ControlLeft", keyCode: 17 },
  ctrl: { bit: 2, key: "Control", code: "ControlLeft", keyCode: 17 },
  meta: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  cmd: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  shift: { bit: 8, key: "Shift", code: "ShiftLeft", keyCode: 16 },
};

const SHIFT = 8;
const TYPING_BLOCKERS = 1 | 2 | 4;

const CLIPBOARD_ERROR = "clipboard shortcuts are not available in the room's browser; browser_type types text";
const badKey = (spec: string) =>
  `unknown key "${spec}": use Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, F1–F12 or a single character, optionally after Shift+, Control+, Alt+ or Meta+`;

const characterKey = (character: string, shifted: boolean): KeyDefinition => {
  if (/^[a-z]$/i.test(character)) {
    const upper = character.toUpperCase();
    const key = shifted ? upper : character;
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  }
  if (/^\d$/.test(character)) return { key: character, code: `Digit${character}`, keyCode: 48 + Number(character), text: character };
  const punctuation = PUNCTUATION[character];
  if (punctuation) return { key: character, code: punctuation[0], keyCode: punctuation[1], text: character };
  return { key: character, code: "", keyCode: 0, text: character };
};

/**
 * The strokes for browser_press: the modifiers go down, the key goes down and up, the modifiers come up.
 * A key held with Control, Alt or Meta types nothing. Meta+C, V and X are refused: the pane has no clipboard.
 */
export const keyEvents = (spec: string): KeyStroke[] | { error: string } => {
  const given = spec.trim();
  if (!given) return { error: badKey(spec) };
  let name: string;
  let modifierNames: string[];
  if (given === "+") {
    name = "+";
    modifierNames = [];
  } else if (given.endsWith("++")) {
    name = "+";
    modifierNames = given.slice(0, -2).split("+");
  } else {
    const parts = given.split("+");
    name = parts.pop() ?? "";
    modifierNames = parts;
  }
  const modifiers = modifierNames.map((part) => MODIFIER_KEYS[part.trim().toLowerCase()]);
  if (!name || modifiers.some((modifier) => modifier === undefined)) return { error: badKey(given) };
  const held = modifiers as NonNullable<(typeof modifiers)[number]>[];
  const mask = held.reduce((bits, modifier) => bits | modifier.bit, 0);
  const characters = [...name];
  let definition: KeyDefinition | undefined;
  if (characters.length === 1) {
    if ((mask & 4) !== 0 && /^[cvx]$/i.test(name)) return { error: CLIPBOARD_ERROR };
    definition = characterKey(name, (mask & SHIFT) !== 0);
  } else {
    definition = NAMED.find((known) => (known.name ?? known.key).toLowerCase() === name.toLowerCase());
  }
  if (!definition) return { error: badKey(given) };

  const strokes: KeyStroke[] = [];
  let down = 0;
  for (const modifier of held) {
    if ((down & modifier.bit) !== 0) continue;
    down |= modifier.bit;
    strokes.push({ type: "rawKeyDown", key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: down });
  }
  const typed = definition.text !== undefined && (mask & TYPING_BLOCKERS) === 0 ? definition.text : undefined;
  const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers: mask };
  strokes.push(typed === undefined ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text: typed });
  strokes.push({ type: "keyUp", ...base });
  const released = [...held].reverse();
  for (const modifier of released) {
    if ((down & modifier.bit) === 0) continue;
    down &= ~modifier.bit;
    strokes.push({ type: "keyUp", key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: down });
  }
  return strokes;
};

/** At most `max` characters, and how many more there were. */
export const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}… (${value.length - max} more characters)`;
