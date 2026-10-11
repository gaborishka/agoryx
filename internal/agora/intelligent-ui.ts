/** Portable, bounded UI programs. No JavaScript, network requests or implicit room actions. */
export type UIValue = string | number | boolean;
export type UIExpression = UIValue | { input: string } | { op: "add" | "subtract" | "multiply" | "divide" | "min" | "max" | "round" | "equal" | "greater" | "less" | "if" | "length" | "concat" | "and" | "or" | "not"; args: UIExpression[] };
export type UITone = "neutral" | "positive" | "warning";
export type UIItemStatus = "todo" | "doing" | "done" | "blocked";
export interface UIListItem { title: string; detail?: string; status?: UIItemStatus; }
export type UIInput =
  | { id: string; label: string; type: "number"; value: number; min: number; max: number; step?: number; unit?: string; presentation?: "slider" | "number" }
  | { id: string; label: string; type: "select"; value: string; options: string[] }
  | { id: string; label: string; type: "toggle"; value: boolean }
  | { id: string; label: string; type: "text" | "textarea"; value: string; placeholder?: string; maxLength?: number };
export type UINode =
  | { type: "stack"; children: UINode[] }
  | { type: "grid"; children: UINode[]; columns?: 2 | 3 | 4 }
  | { type: "tabs"; tabs: { label: string; children: UINode[] }[] }
  | { type: "accordion"; sections: { title: string; children: UINode[] }[] }
  | { type: "text" | "callout"; text: string; tone?: UITone }
  | { type: "heading"; text: string; level?: 2 | 3 | 4 }
  | { type: "divider" }
  | { type: "badge"; label: string; tone?: UITone }
  | { type: "metric"; label: string; value: UIExpression; unit?: string; detail?: string; decimals?: number }
  | { type: "progress"; label: string; value: UIExpression; max: UIExpression; unit?: string; detail?: string }
  | { type: "chart"; title: string; items: { label: string; value: UIExpression }[]; unit?: string; variant?: "bar" | "line" | "area" | "donut" }
  | { type: "table"; columns: string[]; rows: UIExpression[][]; caption?: string; searchable?: boolean; sortable?: boolean }
  | { type: "list"; title?: string; items: UIListItem[] }
  | { type: "timeline"; title?: string; items: (UIListItem & { date?: string })[] }
  | { type: "comparison"; columns: { title: string; subtitle?: string; badge?: string; items: { label: string; value: UIExpression }[] }[] }
  | { type: "input"; id: string }
  | { type: "sources"; refs: string[] };
export interface IntelligentUI { version: 1; description: string; inputs: UIInput[]; root: UINode; }
export interface UIInputSnapshot { values: Record<string, UIValue>; by: string; seq: number; }
export const UI_LIMITS = { bytes: 48_000, nodes: 80, depth: 8, inputs: 16, cells: 240, items: 240, expressions: 1200, inputText: 2000, resultText: 8000 } as const;
export class IntelligentUIError extends Error {}
const fail = (path: string, message: string): never => { throw new IntelligentUIError(`${path}: ${message}`); };
const record = (raw: unknown, path: string): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(path, "expected an object");
  return raw as Record<string, unknown>;
};
const text = (raw: unknown, path: string, max = 300): string => {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max) fail(path, `expected text, 1–${max} characters`);
  return (raw as string).trim();
};
/** Editable values preserve whitespace, including the empty string. */
const inputText = (raw: unknown, path: string, max: number): string => {
  if (typeof raw !== "string" || raw.length > max) fail(path, `expected a string of at most ${max} characters`);
  return raw as string;
};
const choice = <T extends string | number>(raw: unknown, allowed: readonly T[], path: string): T => {
  if (!allowed.includes(raw as T)) fail(path, `expected one of ${allowed.join(", ")}`);
  return raw as T;
};
const optionalText = <K extends string>(raw: Record<string, unknown>, key: K, path: string, max: number): Partial<Record<K, string>> =>
  raw[key] === undefined ? {} : { [key]: text(raw[key], `${path}.${key}`, max) } as Record<K, string>;
const optionalBoolean = <K extends string>(raw: Record<string, unknown>, key: K, path: string): Partial<Record<K, boolean>> => {
  if (raw[key] === undefined) return {};
  if (typeof raw[key] !== "boolean") fail(`${path}.${key}`, "expected boolean");
  return { [key]: raw[key] } as Record<K, boolean>;
};
const number = (raw: unknown, path: string): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || Math.abs(raw) > 1e12) fail(path, "expected a finite number between -1e12 and 1e12");
  return raw as number;
};
const list = (raw: unknown, path: string, max: number, min = 1): unknown[] => {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) fail(path, `expected ${min}–${max} items`);
  return raw as unknown[];
};
const keys = (obj: Record<string, unknown>, allowed: string[], path: string) => {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(path, `unknown field '${key}'`);
};

/** Shared by publication validation, rendering guards and CLI checks. Returns a fresh canonical tree. */
export function parseIntelligentUI(raw: unknown, refs: readonly string[] = []): IntelligentUI {
  if (typeof raw === "string") {
    if (raw.length > UI_LIMITS.bytes) fail("ui", "spec exceeds 48,000 characters");
    try { raw = JSON.parse(raw); } catch { fail("ui", "expected valid JSON"); }
  }
  let serialized: string | undefined;
  try { serialized = JSON.stringify(raw); } catch { return fail("ui", "expected JSON data"); }
  if (!serialized || serialized.length > UI_LIMITS.bytes) fail("ui", "spec exceeds 48,000 characters");
  const spec = record(raw, "ui");
  keys(spec, ["version", "description", "inputs", "root"], "ui");
  if (spec.version !== 1) fail("ui.version", "supported version is 1");
  const ids = new Set<string>();
  const inputs = list(spec.inputs ?? [], "ui.inputs", UI_LIMITS.inputs, 0).map((item, index): UIInput => {
    const path = `ui.inputs[${index}]`, input = record(item, path);
    const id = text(input.id, `${path}.id`, 40);
    if (!/^[a-z][a-z0-9_]*$/.test(id) || ["constructor", "prototype", "__proto__"].includes(id) || ids.has(id)) fail(path, "input id must be unique lowercase letters, digits or underscores, starting with a letter");
    ids.add(id);
    const label = text(input.label, `${path}.label`, 120);
    if (input.type === "number") {
      keys(input, ["id", "label", "type", "value", "min", "max", "step", "unit", "presentation"], path);
      const min = number(input.min, `${path}.min`), max = number(input.max, `${path}.max`), value = number(input.value, `${path}.value`);
      if (min >= max || value < min || value > max) fail(path, "min < max and value must be in range");
      const step = input.step === undefined ? 1 : number(input.step, `${path}.step`);
      if (step <= 0 || step > max - min) fail(path, "step must be positive and fit the range");
      return { id, label, type: "number", value, min, max, step, ...optionalText(input, "unit", path, 24), ...(input.presentation === undefined ? {} : { presentation: choice(input.presentation, ["slider", "number"] as const, `${path}.presentation`) }) };
    }
    if (input.type === "select") {
      keys(input, ["id", "label", "type", "value", "options"], path);
      const options = list(input.options, `${path}.options`, 12, 2).map(v => text(v, `${path}.options`, 80));
      if (new Set(options).size !== options.length || !options.includes(input.value as string)) fail(path, "options must be unique and include value");
      return { id, label, type: "select", value: input.value as string, options };
    }
    if (input.type === "toggle") {
      keys(input, ["id", "label", "type", "value"], path);
      if (typeof input.value !== "boolean") fail(path, "toggle value must be boolean");
      return { id, label, type: "toggle", value: input.value as boolean };
    }
    if (input.type === "text" || input.type === "textarea") {
      keys(input, ["id", "label", "type", "value", "placeholder", "maxLength"], path);
      const maxLength = input.maxLength === undefined ? UI_LIMITS.inputText : input.maxLength;
      if (!Number.isInteger(maxLength) || Number(maxLength) < 1 || Number(maxLength) > UI_LIMITS.inputText) fail(`${path}.maxLength`, "expected an integer between 1 and 2000");
      return { id, label, type: input.type, value: inputText(input.value, `${path}.value`, maxLength as number), maxLength: maxLength as number, ...optionalText(input, "placeholder", path, 300) };
    }
    return fail(path, "input type must be number, select, toggle, text or textarea");
  });
  let expressions = 0;
  const expr = (raw: unknown, path: string, depth = 0): UIExpression => {
    if (++expressions > UI_LIMITS.expressions || depth > UI_LIMITS.depth) fail(path, "expression complexity limit exceeded");
    if (typeof raw === "number") return number(raw, path);
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") return inputText(raw, path, 1000);
    const value = record(raw, path);
    if ("input" in value) {
      keys(value, ["input"], path);
      if (!ids.has(value.input as string)) fail(path, `unknown input '${String(value.input)}'`);
      return { input: value.input as string };
    }
    keys(value, ["op", "args"], path);
    if (!["add", "subtract", "multiply", "divide", "min", "max", "round", "equal", "greater", "less", "if", "length", "concat", "and", "or", "not"].includes(value.op as string)) fail(path, "unknown arithmetic operation");
    const op = value.op as Extract<UIExpression, { op: string }>["op"];
    const args = list(value.args, `${path}.args`, 8).map((a, i) => expr(a, `${path}.args[${i}]`, depth + 1));
    if (["round", "length", "not"].includes(op) && args.length !== 1) fail(path, `${op} takes one argument`);
    if (["divide", "subtract", "equal", "greater", "less"].includes(op) && args.length !== 2) fail(path, `${op} takes two arguments`);
    if (op === "if" && args.length !== 3) fail(path, "if takes three arguments");
    return { op, args };
  };
  let nodes = 0, cells = 0, items = 0;
  // The new collections share a global budget. Existing version-1 table/chart limits stay compatible.
  const countItems = (count: number, path: string) => {
    items += count;
    if (items > UI_LIMITS.items) fail(path, "at most 240 list, timeline and comparison items per tool");
  };
  const renderedInputs = new Set<string>();
  const children = (raw: unknown, path: string, depth: number) => list(raw, path, 24).map((item, i) => node(item, `${path}[${i}]`, depth + 1));
  const node = (raw: unknown, path: string, depth: number): UINode => {
    if (++nodes > UI_LIMITS.nodes || depth > UI_LIMITS.depth) fail(path, "layout complexity limit exceeded");
    const n = record(raw, path);
    switch (n.type) {
      case "stack":
        keys(n, ["type", "children"], path);
        return { type: n.type, children: children(n.children, `${path}.children`, depth) };
      case "grid":
        keys(n, ["type", "children", "columns"], path);
        return { type: "grid", children: children(n.children, `${path}.children`, depth), ...(n.columns === undefined ? {} : { columns: choice(n.columns, [2, 3, 4] as const, `${path}.columns`) }) };
      case "accordion":
        keys(n, ["type", "sections"], path);
        return { type: "accordion", sections: list(n.sections, `${path}.sections`, 12).map((item, i) => {
          const sectionPath = `${path}.sections[${i}]`, section = record(item, sectionPath);
          keys(section, ["title", "children"], sectionPath);
          return { title: text(section.title, `${sectionPath}.title`, 120), children: children(section.children, `${sectionPath}.children`, depth) };
        }) };
      case "tabs":
        keys(n, ["type", "tabs"], path);
        return { type: "tabs", tabs: list(n.tabs, `${path}.tabs`, 6, 2).map((item, i) => {
          const tab = record(item, `${path}.tabs[${i}]`);
          keys(tab, ["label", "children"], `${path}.tabs[${i}]`);
          return { label: text(tab.label, path, 60), children: children(tab.children, `${path}.tabs[${i}].children`, depth) };
        }) };
      case "text": case "callout":
        keys(n, ["type", "text", "tone"], path);
        if (n.tone !== undefined && !["neutral", "positive", "warning"].includes(n.tone as string)) fail(path, "unknown tone");
        return { type: n.type, text: text(n.text, path, 3000), ...(n.tone ? { tone: n.tone as "neutral" | "positive" | "warning" } : {}) };
      case "heading":
        keys(n, ["type", "text", "level"], path);
        return { type: "heading", text: text(n.text, `${path}.text`, 300), ...(n.level === undefined ? {} : { level: choice(n.level, [2, 3, 4] as const, `${path}.level`) }) };
      case "divider":
        keys(n, ["type"], path);
        return { type: "divider" };
      case "badge":
        keys(n, ["type", "label", "tone"], path);
        return { type: "badge", label: text(n.label, `${path}.label`, 100), ...(n.tone === undefined ? {} : { tone: choice(n.tone, ["neutral", "positive", "warning"] as const, `${path}.tone`) }) };
      case "metric":
        keys(n, ["type", "label", "value", "unit", "detail", "decimals"], path);
        if (n.decimals !== undefined && (!Number.isInteger(n.decimals) || Number(n.decimals) < 0 || Number(n.decimals) > 6)) fail(path, "decimals must be 0–6");
        return { type: "metric", label: text(n.label, path, 120), value: expr(n.value, `${path}.value`), ...(n.unit === undefined ? {} : { unit: text(n.unit, path, 24) }), ...(n.detail === undefined ? {} : { detail: text(n.detail, path, 300) }), ...(n.decimals === undefined ? {} : { decimals: n.decimals as number }) };
      case "chart":
        keys(n, ["type", "title", "items", "unit", "variant"], path);
        return { type: "chart", title: text(n.title, path, 120), items: list(n.items, `${path}.items`, 20).map((item, i) => { const bar = record(item, `${path}.items[${i}]`); keys(bar, ["label", "value"], `${path}.items[${i}]`); return { label: text(bar.label, `${path}.items[${i}].label`, 100), value: expr(bar.value, `${path}.items[${i}].value`) }; }), ...optionalText(n, "unit", path, 24), ...(n.variant === undefined ? {} : { variant: choice(n.variant, ["bar", "line", "area", "donut"] as const, `${path}.variant`) }) };
      case "progress":
        keys(n, ["type", "label", "value", "max", "unit", "detail"], path);
        return { type: "progress", label: text(n.label, `${path}.label`, 120), value: expr(n.value, `${path}.value`), max: expr(n.max, `${path}.max`), ...optionalText(n, "unit", path, 24), ...optionalText(n, "detail", path, 300) };
      case "list": case "timeline": {
        keys(n, ["type", "title", "items"], path);
        const entries = list(n.items, `${path}.items`, 24);
        countItems(entries.length, path);
        return { type: n.type, ...optionalText(n, "title", path, 120), items: entries.map((rawItem, i) => {
          const itemPath = `${path}.items[${i}]`, item = record(rawItem, itemPath);
          keys(item, n.type === "timeline" ? ["title", "detail", "status", "date"] : ["title", "detail", "status"], itemPath);
          return { title: text(item.title, `${itemPath}.title`, 120), ...optionalText(item, "detail", itemPath, 500), ...(n.type === "timeline" ? optionalText(item, "date", itemPath, 80) : {}), ...(item.status === undefined ? {} : { status: choice(item.status, ["todo", "doing", "done", "blocked"] as const, `${itemPath}.status`) }) };
        }) };
      }
      case "comparison":
        keys(n, ["type", "columns"], path);
        return { type: "comparison", columns: list(n.columns, `${path}.columns`, 4, 2).map((rawColumn, i) => {
          const columnPath = `${path}.columns[${i}]`, column = record(rawColumn, columnPath);
          keys(column, ["title", "subtitle", "badge", "items"], columnPath);
          const entries = list(column.items, `${columnPath}.items`, 24);
          countItems(entries.length, columnPath);
          return { title: text(column.title, `${columnPath}.title`, 120), ...optionalText(column, "subtitle", columnPath, 200), ...optionalText(column, "badge", columnPath, 60), items: entries.map((rawItem, j) => {
            const itemPath = `${columnPath}.items[${j}]`, item = record(rawItem, itemPath);
            keys(item, ["label", "value"], itemPath);
            return { label: text(item.label, `${itemPath}.label`, 120), value: expr(item.value, `${itemPath}.value`) };
          }) };
        }) };
      case "table": {
        keys(n, ["type", "columns", "rows", "caption", "searchable", "sortable"], path);
        const columns = list(n.columns, `${path}.columns`, 8).map(v => text(v, path, 100));
        const rows = list(n.rows, `${path}.rows`, 40).map((row, i) => list(row, `${path}.rows[${i}]`, columns.length, columns.length).map((v, j) => expr(v, `${path}.rows[${i}][${j}]`)));
        cells += columns.length * rows.length;
        if (cells > UI_LIMITS.cells) fail(path, "at most 240 table cells per tool");
        return { type: "table", columns, rows, ...optionalText(n, "caption", path, 300), ...optionalBoolean(n, "searchable", path), ...optionalBoolean(n, "sortable", path) };
      }
      case "input":
        keys(n, ["type", "id"], path);
        if (!ids.has(n.id as string) || renderedInputs.has(n.id as string)) fail(path, "input must exist and appear only once");
        renderedInputs.add(n.id as string);
        return { type: "input", id: n.id as string };
      case "sources":
        keys(n, ["type", "refs"], path);
        return { type: "sources", refs: list(n.refs, `${path}.refs`, 24).map(v => { if (typeof v !== "string" || !refs.includes(v)) fail(path, "sources must be included in component refs"); return v as string; }) };
      default: return fail(path, `unknown node type '${String(n.type)}'`);
    }
  };
  const root = node(spec.root, "ui.root", 0);
  for (const id of ids) if (!renderedInputs.has(id)) fail("ui.root", `input '${id}' needs an input node`);
  const canonical: IntelligentUI = { version: 1, description: text(spec.description, "ui.description", 500), inputs, root };
  // Defaults such as maxLength and step can make the stored tree larger than its authored JSON.
  // Anything we accept must also pass the same guard when replayed, rendered or exported.
  if (JSON.stringify(canonical).length > UI_LIMITS.bytes) fail("ui", "normalized spec exceeds 48,000 characters; shorten its content");
  return canonical;
}

export const defaultUIValues = (spec: IntelligentUI): Record<string, UIValue> => Object.fromEntries(spec.inputs.map(input => [input.id, input.value]));
export function validateUIValues(spec: IntelligentUI, raw: unknown): Record<string, UIValue> {
  const values = record(raw, "values");
  keys(values, spec.inputs.map(input => input.id), "values");
  const output: Record<string, UIValue> = {};
  for (const input of spec.inputs) {
    const value = values[input.id];
    const valid = input.type === "number" ? typeof value === "number" && Number.isFinite(value) && value >= input.min && value <= input.max
      : input.type === "select" ? typeof value === "string" && input.options.includes(value)
      : input.type === "toggle" ? typeof value === "boolean"
      : typeof value === "string" && value.length <= (input.maxLength ?? UI_LIMITS.inputText);
    if (!valid) fail(`values.${input.id}`, "value does not match the input's type or range");
    output[input.id] = value as UIValue;
  }
  return output;
}
/** Invalid arithmetic stays visibly unknown, never silently becomes zero or Infinity. */
export function evaluateUI(expr: UIExpression, values: Record<string, UIValue>): UIValue | null {
  if (typeof expr !== "object") return expr;
  if ("input" in expr) return values[expr.input] ?? null;
  const args = expr.args.map(a => evaluateUI(a, values));
  if (expr.op === "if") return typeof args[0] === "boolean" ? args[0] ? args[1]! : args[2]! : null;
  if (expr.op === "equal") return args.some(a => a === null) ? null : args[0] === args[1];
  if (expr.op === "length") return typeof args[0] === "string" ? args[0].length : null;
  if (expr.op === "concat") {
    if (args.some(a => a === null)) return null;
    const result = args.join("");
    return result.length <= UI_LIMITS.resultText ? result : null;
  }
  if (expr.op === "not") return typeof args[0] === "boolean" ? !args[0] : null;
  if (expr.op === "and" || expr.op === "or") {
    if (args.some(a => typeof a !== "boolean")) return null;
    return expr.op === "and" ? args.every(Boolean) : args.some(Boolean);
  }
  if (expr.op === "greater" || expr.op === "less") return typeof args[0] === "number" && typeof args[1] === "number" ? expr.op === "greater" ? args[0] > args[1] : args[0] < args[1] : null;
  if (args.some(a => typeof a !== "number" && typeof a !== "boolean")) return null;
  const nums = args.map(Number);
  const result = expr.op === "add" ? nums.reduce((a, b) => a + b, 0) : expr.op === "multiply" ? nums.reduce((a, b) => a * b, 1) : expr.op === "subtract" ? nums[0]! - nums[1]! : expr.op === "divide" ? nums[1] === 0 ? NaN : nums[0]! / nums[1]! : expr.op === "min" ? Math.min(...nums) : expr.op === "max" ? Math.max(...nums) : Math.round(nums[0]!);
  return Number.isFinite(result) ? result : null;
}
