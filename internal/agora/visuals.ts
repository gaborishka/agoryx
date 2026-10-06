/**
 * Visual blocks: an agent writes a ```viz fence whose body is one small JSON
 * object, and everyone reading the room sees it drawn as a native card — a
 * claim tree, a comparison, a chart, a stance map, a decision to answer —
 * instead of paragraphs. The same specs render in chat, on the table and in
 * workflow submissions, in the room's own theme, with no frame and no script
 * of the agent's running in the page.
 *
 * The browser and the CLI share this parser, so `agoryx viz check` tells an
 * agent exactly what the reader will see before it posts. A spec that does not
 * parse still shows: the reader gets its source and the reason.
 */

export const VIZ_LANG = "viz";

export type VizTone = "pro" | "con" | "good" | "bad" | "warn" | "info" | "neutral";
const TONES: readonly VizTone[] = ["pro", "con", "good", "bad", "warn", "info", "neutral"];

export interface VizClaim {
  text: string;
  tone?: VizTone;
  /** 0..1: how sure the author is. */
  confidence?: number;
  /** Who holds it: an agent handle, a side, a source. */
  by?: string;
  /** Markdown shown when the reader opens the claim. */
  detail?: string;
  children?: VizClaim[];
}

export type VizCell = string | number | boolean | null;

export type VizStepStatus = "done" | "doing" | "todo" | "blocked" | "skipped";
const STEP_STATUSES: readonly VizStepStatus[] = ["done", "doing", "todo", "blocked", "skipped"];

export type VizChartType = "bar" | "hbar" | "line" | "stacked";
const CHART_TYPES: readonly VizChartType[] = ["bar", "hbar", "line", "stacked"];

interface VizBase {
  title?: string;
  caption?: string;
}

export type VizSpec = VizBase &
  (
    | { kind: "claims"; claims: VizClaim[] }
    | { kind: "compare"; columns: string[]; rows: { label: string; values: VizCell[]; note?: string }[]; pick?: string }
    | { kind: "chart"; type: VizChartType; labels: string[]; series: { name: string; values: number[] }[]; unit?: string }
    | { kind: "stats"; items: { label: string; value: string; delta?: string; tone?: VizTone }[] }
    | { kind: "steps"; steps: { title: string; status: VizStepStatus; detail?: string; by?: string }[] }
    | { kind: "stance"; left: string; right: string; items: { label: string; value: number; note?: string; confidence?: number }[] }
    | { kind: "tradeoff"; options: { name: string; pros: string[]; cons: string[]; verdict?: string }[] }
    | { kind: "decision"; question: string; options: { label: string; detail?: string; recommended?: boolean }[] }
  );

export type VizKind = VizSpec["kind"];
export const VIZ_KINDS: readonly VizKind[] = ["claims", "compare", "chart", "stats", "steps", "stance", "tradeoff", "decision"];

export const VIZ_LIMITS = {
  source: 16_000,
  short: 80,
  claim: 200,
  detail: 2_000,
  claims: 8,
  depth: 3,
  columns: 6,
  rows: 12,
  labels: 40,
  series: 6,
  stats: 6,
  steps: 16,
  stance: 10,
  tradeoff: 4,
  points: 6,
  options: 6,
} as const;

export type VizResult = { ok: true; spec: VizSpec } | { ok: false; error: string };

class VizError extends Error {}
const fail = (path: string, message: string): never => {
  throw new VizError(`${path} ${message}`);
};

type Obj = Record<string, unknown>;
const object = (value: unknown, path: string): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : fail(path, "must be an object");
const text = (value: unknown, path: string, limit: number): string => {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string" || !value.trim()) return fail(path, "must be non-empty text");
  const clean = value.trim();
  return clean.length > limit ? fail(path, `must be at most ${limit} characters (it has ${clean.length}); say it shorter or move the rest to detail`) : clean;
};
const optionalText = (value: unknown, path: string, limit: number): string | undefined => (value === undefined || value === null || value === "" ? undefined : text(value, path, limit));
const list = (value: unknown, path: string, min: number, max: number): unknown[] => {
  if (!Array.isArray(value)) return fail(path, "must be a list");
  if (value.length < min) return fail(path, `needs at least ${min} item${min === 1 ? "" : "s"}`);
  if (value.length > max) return fail(path, `has ${value.length} items; at most ${max} read at a glance — cut or group the rest`);
  return value;
};
const exactly = (value: unknown, path: string, n: number, what: string): unknown[] => {
  if (!Array.isArray(value)) return fail(path, "must be a list");
  return value.length === n ? value : fail(path, `has ${value.length} values; it needs exactly ${n}, one per ${what}`);
};
const textList = (value: unknown, path: string, min: number, max: number, limit: number): string[] =>
  list(value ?? [], path, min, max).map((item, i) => text(item, `${path}[${i}]`, limit));
const unit = (value: unknown, path: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return fail(path, "must be a number from 0 to 1");
  return value;
};
const tone = (value: unknown, path: string): VizTone | undefined => {
  if (value === undefined || value === null) return undefined;
  return TONES.includes(value as VizTone) ? (value as VizTone) : fail(path, `must be one of ${TONES.join(", ")}`);
};
const number = (value: unknown, path: string): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(path, "must be a number");
const unique = (items: string[], path: string): void => {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) fail(path, `repeats "${item}"`);
    seen.add(item);
  }
};

const claim = (value: unknown, path: string, depth: number): VizClaim => {
  const raw = typeof value === "string" ? { text: value } : object(value, path);
  const out: VizClaim = { text: text(raw.text, `${path}.text`, VIZ_LIMITS.claim) };
  const t = tone(raw.tone, `${path}.tone`);
  if (t) out.tone = t;
  const c = unit(raw.confidence, `${path}.confidence`);
  if (c !== undefined) out.confidence = c;
  const by = optionalText(raw.by, `${path}.by`, VIZ_LIMITS.short);
  if (by) out.by = by;
  const detail = optionalText(raw.detail, `${path}.detail`, VIZ_LIMITS.detail);
  if (detail) out.detail = detail;
  if (raw.children !== undefined) {
    if (depth >= VIZ_LIMITS.depth) fail(`${path}.children`, `goes deeper than ${VIZ_LIMITS.depth} levels`);
    const children = list(raw.children, `${path}.children`, 0, VIZ_LIMITS.claims).map((child, i) => claim(child, `${path}.children[${i}]`, depth + 1));
    if (children.length) out.children = children;
  }
  return out;
};

const cell = (value: unknown, path: string): VizCell => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail(path, "must be a finite number");
  if (typeof value === "string") return value.length > VIZ_LIMITS.short ? fail(path, `must be at most ${VIZ_LIMITS.short} characters`) : value.trim();
  return fail(path, "must be text, a number, true/false or null");
};

const parseSpec = (raw: Obj): VizSpec => {
  const kind = raw.kind;
  if (!VIZ_KINDS.includes(kind as VizKind)) return fail("kind", `must be one of ${VIZ_KINDS.join(", ")}`);
  const base: VizBase = {};
  const title = optionalText(raw.title, "title", VIZ_LIMITS.claim);
  if (title) base.title = title;
  const caption = optionalText(raw.caption, "caption", VIZ_LIMITS.claim);
  if (caption) base.caption = caption;
  switch (kind as VizKind) {
    case "claims":
      return { ...base, kind: "claims", claims: list(raw.claims, "claims", 1, VIZ_LIMITS.claims).map((c, i) => claim(c, `claims[${i}]`, 1)) };
    case "compare": {
      const columns = textList(raw.columns, "columns", 1, VIZ_LIMITS.columns, VIZ_LIMITS.short);
      unique(columns, "columns");
      const rows = list(raw.rows, "rows", 1, VIZ_LIMITS.rows).map((value, i) => {
        const row = object(value, `rows[${i}]`);
        const values = exactly(row.values, `rows[${i}].values`, columns.length, "column").map((v, j) => cell(v, `rows[${i}].values[${j}]`));
        const note = optionalText(row.note, `rows[${i}].note`, VIZ_LIMITS.claim);
        return { label: text(row.label, `rows[${i}].label`, VIZ_LIMITS.short), values, ...(note ? { note } : {}) };
      });
      const pick = optionalText(raw.pick, "pick", VIZ_LIMITS.short);
      if (pick && !columns.includes(pick)) fail("pick", `must name one of the columns (${columns.join(", ")})`);
      return { ...base, kind: "compare", columns, rows, ...(pick ? { pick } : {}) };
    }
    case "chart": {
      const type = (raw.type ?? "bar") as VizChartType;
      if (!CHART_TYPES.includes(type)) fail("type", `must be one of ${CHART_TYPES.join(", ")}`);
      const labels = textList(raw.labels, "labels", 1, VIZ_LIMITS.labels, VIZ_LIMITS.short);
      const series = list(raw.series, "series", 1, VIZ_LIMITS.series).map((value, i) => {
        const s = object(value, `series[${i}]`);
        const values = exactly(s.values, `series[${i}].values`, labels.length, "label").map((v, j) => number(v, `series[${i}].values[${j}]`));
        if (type === "stacked" && values.some((v) => v < 0)) fail(`series[${i}].values`, "must not be negative in a stacked chart");
        return { name: text(s.name ?? (i === 0 ? "Value" : undefined), `series[${i}].name`, VIZ_LIMITS.short), values };
      });
      unique(series.map((s) => s.name), "series");
      const u = optionalText(raw.unit, "unit", 16);
      return { ...base, kind: "chart", type, labels, series, ...(u ? { unit: u } : {}) };
    }
    case "stats":
      return {
        ...base,
        kind: "stats",
        items: list(raw.items, "items", 1, VIZ_LIMITS.stats).map((value, i) => {
          const item = object(value, `items[${i}]`);
          const delta = optionalText(item.delta, `items[${i}].delta`, 24);
          const t = tone(item.tone, `items[${i}].tone`);
          return { label: text(item.label, `items[${i}].label`, VIZ_LIMITS.short), value: text(item.value, `items[${i}].value`, 24), ...(delta ? { delta } : {}), ...(t ? { tone: t } : {}) };
        }),
      };
    case "steps":
      return {
        ...base,
        kind: "steps",
        steps: list(raw.steps, "steps", 1, VIZ_LIMITS.steps).map((value, i) => {
          const step = typeof value === "string" ? { title: value } : object(value, `steps[${i}]`);
          const status = (step.status ?? "todo") as VizStepStatus;
          if (!STEP_STATUSES.includes(status)) fail(`steps[${i}].status`, `must be one of ${STEP_STATUSES.join(", ")}`);
          const detail = optionalText(step.detail, `steps[${i}].detail`, VIZ_LIMITS.detail);
          const by = optionalText(step.by, `steps[${i}].by`, VIZ_LIMITS.short);
          return { title: text(step.title, `steps[${i}].title`, VIZ_LIMITS.claim), status, ...(detail ? { detail } : {}), ...(by ? { by } : {}) };
        }),
      };
    case "stance":
      return {
        ...base,
        kind: "stance",
        left: text(raw.left, "left", VIZ_LIMITS.short),
        right: text(raw.right, "right", VIZ_LIMITS.short),
        items: list(raw.items, "items", 1, VIZ_LIMITS.stance).map((value, i) => {
          const item = object(value, `items[${i}]`);
          const v = number(item.value, `items[${i}].value`);
          if (v < -1 || v > 1) fail(`items[${i}].value`, "must be from -1 (left) to 1 (right)");
          const note = optionalText(item.note, `items[${i}].note`, VIZ_LIMITS.claim);
          const c = unit(item.confidence, `items[${i}].confidence`);
          return { label: text(item.label, `items[${i}].label`, VIZ_LIMITS.short), value: v, ...(note ? { note } : {}), ...(c !== undefined ? { confidence: c } : {}) };
        }),
      };
    case "tradeoff":
      return {
        ...base,
        kind: "tradeoff",
        options: list(raw.options, "options", 1, VIZ_LIMITS.tradeoff).map((value, i) => {
          const option = object(value, `options[${i}]`);
          const verdict = optionalText(option.verdict, `options[${i}].verdict`, VIZ_LIMITS.claim);
          return {
            name: text(option.name, `options[${i}].name`, VIZ_LIMITS.short),
            pros: textList(option.pros, `options[${i}].pros`, 0, VIZ_LIMITS.points, VIZ_LIMITS.claim),
            cons: textList(option.cons, `options[${i}].cons`, 0, VIZ_LIMITS.points, VIZ_LIMITS.claim),
            ...(verdict ? { verdict } : {}),
          };
        }),
      };
    case "decision": {
      const options = list(raw.options, "options", 2, VIZ_LIMITS.options).map((value, i) => {
        const option = typeof value === "string" ? { label: value } : object(value, `options[${i}]`);
        const detail = optionalText(option.detail, `options[${i}].detail`, VIZ_LIMITS.claim);
        return { label: text(option.label, `options[${i}].label`, VIZ_LIMITS.short), ...(detail ? { detail } : {}), ...(option.recommended === true ? { recommended: true } : {}) };
      });
      unique(options.map((o) => o.label), "options");
      if (options.filter((o) => o.recommended).length > 1) fail("options", "may recommend one option at most");
      return { ...base, kind: "decision", question: text(raw.question, "question", VIZ_LIMITS.claim), options };
    }
  }
  return fail("kind", "is not supported");
};

/** Parses one ```viz fence body. Never throws. */
export const parseViz = (source: string): VizResult => {
  if (source.length > VIZ_LIMITS.source) return { ok: false, error: `the spec is ${source.length} characters; at most ${VIZ_LIMITS.source}` };
  let raw: unknown;
  try {
    raw = JSON.parse(source.trim());
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
  }
  try {
    return { ok: true, spec: parseSpec(object(raw, "the spec")) };
  } catch (error) {
    if (error instanceof VizError) return { ok: false, error: error.message };
    throw error;
  }
};

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;

/** Every ```viz fence body in a markdown text, in order. */
export const vizBlocks = (markdown: string): string[] => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const close = new RegExp(`^\\s*${open[1]}\\s*$`);
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
    if (open[2]!.toLowerCase() === VIZ_LANG) out.push(body.join("\n"));
  }
  return out;
};

const pct = (n: number) => `${Math.round(n * 100)}%`;
const SIDE: Record<VizTone, string> = { pro: "+", con: "−", good: "✓", bad: "✗", warn: "!", info: "i", neutral: "·" };
const cellText = (value: VizCell): string => (value === true ? "yes" : value === false ? "no" : value === null ? "—" : String(value));

/**
 * A plain-text reading of a spec: what a screen reader, an export or a
 * terminal shows. It carries every value the card shows, so nothing is only visual.
 */
export const vizText = (spec: VizSpec): string => {
  const lines: string[] = [];
  if (spec.title) lines.push(spec.title);
  switch (spec.kind) {
    case "claims": {
      const walk = (claims: VizClaim[], prefix: string, indent: string) =>
        claims.forEach((c, i) => {
          const n = `${prefix}${i + 1}`;
          const meta = [c.by, c.confidence !== undefined ? pct(c.confidence) : ""].filter(Boolean).join(", ");
          lines.push(`${indent}${n}. ${c.tone ? `${SIDE[c.tone]} ` : ""}${c.text}${meta ? ` (${meta})` : ""}`);
          if (c.children) walk(c.children, `${n}.`, `${indent}  `);
        });
      walk(spec.claims, "", "");
      break;
    }
    case "compare":
      lines.push(`| | ${spec.columns.map((c) => (c === spec.pick ? `${c} (pick)` : c)).join(" | ")} |`);
      for (const row of spec.rows) lines.push(`| ${row.label} | ${row.values.map(cellText).join(" | ")} |`);
      break;
    case "chart":
      for (const s of spec.series) lines.push(`${s.name}: ${spec.labels.map((label, i) => `${label} ${s.values[i]}${spec.unit ?? ""}`).join(", ")}`);
      break;
    case "stats":
      for (const item of spec.items) lines.push(`${item.label}: ${item.value}${item.delta ? ` (${item.delta})` : ""}`);
      break;
    case "steps":
      spec.steps.forEach((step, i) => lines.push(`${i + 1}. [${step.status}] ${step.title}${step.by ? ` — ${step.by}` : ""}`));
      break;
    case "stance":
      lines.push(`${spec.left} ←→ ${spec.right}`);
      for (const item of spec.items) lines.push(`${item.label}: ${item.value > 0 ? "+" : ""}${item.value.toFixed(2)}${item.note ? ` — ${item.note}` : ""}`);
      break;
    case "tradeoff":
      for (const option of spec.options) {
        lines.push(`${option.name}:`);
        for (const p of option.pros) lines.push(`  + ${p}`);
        for (const c of option.cons) lines.push(`  − ${c}`);
        if (option.verdict) lines.push(`  → ${option.verdict}`);
      }
      break;
    case "decision":
      lines.push(spec.question);
      for (const option of spec.options) lines.push(`  ○ ${option.label}${option.recommended ? " (recommended)" : ""}${option.detail ? ` — ${option.detail}` : ""}`);
      break;
  }
  if (spec.caption) lines.push(spec.caption);
  return lines.join("\n");
};

/** The answer a reader's pick in a decision card drafts into the composer. */
export const vizDecisionReply = (question: string, label: string): string => `> ${question}\n\n**${label}**`;

/**
 * How to write visual blocks — the agent-facing reference used by room
 * briefings and workflow prompts. Kept short: the parser's error messages
 * carry the rest.
 */
export const VIZ_GUIDE = [
  "Visual blocks: a ```viz fence holding ONE JSON object renders as a native card in the room's theme (no HTML needed).",
  "Kinds — each example below is valid as written; every block also takes an optional \"title\" and a one-line \"caption\":",
  '- claims — a reply\'s summary as a tree of short, checkable claims; "detail" (markdown) and "children" open on click: {"kind":"claims","claims":[{"text":"The cache cuts p95 latency by 40%","tone":"pro","confidence":0.8,"by":"@codex","detail":"Measured on staging over 2 days.","children":[{"text":"Hit rate stays above 90%","tone":"good"}]},{"text":"Invalidation on writes is the open risk","tone":"warn"}]}',
  '- compare — options side by side (true/false draw as ✓/✗, numbers as bars): {"kind":"compare","columns":["Redis","In-process"],"rows":[{"label":"p95","values":["40 ms","25 ms"]},{"label":"Survives restart","values":[true,false]}],"pick":"Redis"}',
  '- chart — numbers; type is bar, hbar, line or stacked: {"kind":"chart","type":"line","labels":["Mon","Tue","Wed"],"series":[{"name":"p95","values":[120,95,90]}],"unit":" ms"}',
  '- stats — 1–6 headline numbers: {"kind":"stats","items":[{"label":"Tests","value":"412","delta":"+12","tone":"good"},{"label":"Failing","value":"0"}]}',
  '- steps — a plan or progress; status is done, doing, todo, blocked or skipped: {"kind":"steps","steps":[{"title":"Migrate schema","status":"done","by":"@codex"},{"title":"Backfill rows","status":"doing"}]}',
  '- stance — where positions sit between two poles, value from -1 (left) to 1 (right): {"kind":"stance","left":"Rewrite","right":"Patch","items":[{"label":"@claude","value":-0.6,"note":"the module has no tests"},{"label":"@codex","value":0.4}]}',
  '- tradeoff — pros and cons per option: {"kind":"tradeoff","options":[{"name":"SQLite","pros":["No server"],"cons":["One writer"],"verdict":"Enough for now"}]}',
  '- decision — a choice for the human, answered with one click (at most one recommended): {"kind":"decision","question":"Ship behind a flag?","options":[{"label":"Ship now","detail":"Flag off by default","recommended":true},{"label":"Wait a week"}]}',
  "tone is one of pro, con, good, bad, warn, info, neutral; confidence is 0 to 1. Write strict JSON (double quotes, no comments, no trailing commas). Limits keep a card glanceable: 8 claims per level and 3 levels, 6 columns, 12 rows, 6 series.",
].join("\n");
