import { closeSync, openSync, readSync } from "node:fs";
import { defaultUIValues, parseIntelligentUI, UI_LIMITS, validateUIValues, type UINode } from "./intelligent-ui.js";
import { intelligentUIGuide } from "./intelligent-ui-guide.js";
import { evaluateUIOutputs } from "./intelligent-ui-evaluation.js";

export const INTELLIGENT_UI_USAGE = "agoryx ui guide | agoryx ui check [--file tool.json | --body JSON | -] [--ref F1] [--values JSON | --values-file scenario.json] [--json]";
const MAX_VALUES_CHARS = 200_000;
/** Bound reads before allocation/JSON parsing; valid UTF-8 uses at most four bytes per character. */
function readBounded(file: string | undefined, maxChars: number): string {
  const ownsDescriptor = file !== undefined && file !== "-";
  const fd = ownsDescriptor ? openSync(file, "r") : 0;
  const limit = maxChars * 4;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(16_384, limit + 1 - total));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > limit) throw new Error(`input exceeds ${maxChars.toLocaleString("en-US")} characters`);
      chunks.push(buffer.subarray(0, count));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length > maxChars) throw new Error(`input exceeds ${maxChars.toLocaleString("en-US")} characters`);
    return text;
  } finally { if (ownsDescriptor) closeSync(fd); }
}
/** Local preflight never opens a room, reads credentials, publishes or starts a model. */
export function runIntelligentUICommand(argv: string[], output: (text: string) => void = console.log): number {
  const [verb, ...args] = argv;
  if (!verb || verb === "--help" || verb === "-h") { output(INTELLIGENT_UI_USAGE); return 0; }
  if (verb === "guide") {
    if (args.length) { output("ui guide takes no arguments"); return 2; }
    output(intelligentUIGuide()); return 0;
  }
  if (verb !== "check") { output(INTELLIGENT_UI_USAGE); return 2; }
  let file: string | undefined, body: string | undefined, overrideBody: string | undefined, overrideFile: string | undefined;
  const json = args.includes("--json");
  const refs: string[] = [];
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--json") continue;
      if (arg === "-" && file === undefined) { file = "-"; continue; }
      if (!["--file", "--body", "--ref", "--values", "--values-file"].includes(arg)) throw new Error(`unknown argument '${arg}'`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--ref") {
        const ref = value.trim().replace(/^#/, "").toUpperCase();
        if (!/^[QPNFSXDCW][1-9]\d*$/.test(ref)) throw new Error(`invalid table reference '${value}'`);
        if (refs.length >= 24) throw new Error("at most 24 references");
        refs.push(ref);
      } else if (arg === "--file") { if (file !== undefined) throw new Error("use one --file"); file = value; }
      else if (arg === "--body") { if (body !== undefined) throw new Error("use one --body"); body = value; }
      else if (arg === "--values") { if (overrideBody !== undefined) throw new Error("use one --values"); overrideBody = value; }
      else { if (overrideFile !== undefined) throw new Error("use one --values-file"); overrideFile = value; }
    }
    if (body !== undefined && file !== undefined) throw new Error("use --body or --file/stdin, not both");
    if (overrideBody !== undefined && overrideFile !== undefined) throw new Error("use --values or --values-file, not both");
    if (overrideFile === "-" && body === undefined && (file === undefined || file === "-")) throw new Error("the spec and input values cannot both read stdin");
    if (body === undefined && file === undefined && process.stdin.isTTY) throw new Error("give a spec with --file, --body or stdin");
    const source = body ?? readBounded(file, UI_LIMITS.bytes);
    const spec = parseIntelligentUI(source, refs);
    const rawOverrides = overrideBody ?? (overrideFile === undefined ? undefined : readBounded(overrideFile, MAX_VALUES_CHARS));
    let overrides: Record<string, unknown> = {};
    if (rawOverrides !== undefined) {
      if (rawOverrides.length > MAX_VALUES_CHARS) throw new Error("input values exceed 200,000 characters");
      let parsed: unknown;
      try { parsed = JSON.parse(rawOverrides); } catch { throw new Error("input values must be valid JSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("input values must be a JSON object keyed by input id");
      overrides = parsed as Record<string, unknown>;
    }
    const values = validateUIValues(spec, { ...defaultUIValues(spec), ...overrides });
    const outputs = evaluateUIOutputs(spec, values);
    const diagnostics = outputs.flatMap(output => output.diagnostic ? [{ path: output.path, label: output.label, message: output.diagnostic }] : []);
    const kinds = new Map<string, number>();
    const visit = (node: UINode) => {
      kinds.set(node.type, (kinds.get(node.type) ?? 0) + 1);
      if ("children" in node) node.children.forEach(visit);
      if (node.type === "tabs") node.tabs.forEach(tab => tab.children.forEach(visit));
      if (node.type === "accordion") node.sections.forEach(section => section.children.forEach(visit));
    };
    visit(spec.root);
    if (json) output(JSON.stringify({ valid: true, version: spec.version, description: spec.description, inputCount: spec.inputs.length, components: Object.fromEntries(kinds), values, outputs, diagnostics, refs, referenceCheck: "on-publication" }, null, 2));
    else {
      const metrics = outputs.filter(item => item.kind === "metric").map(item => `${item.label}: ${item.value === null ? "Unavailable" : String(item.value)}${item.unit ? ` ${item.unit}` : ""}`);
      output(`Valid Intelligent UI v${spec.version}\n${spec.description}\nInputs: ${spec.inputs.length}\nComponents: ${[...kinds].map(([kind, count]) => `${kind} × ${count}`).join(", ")}${metrics.length ? `\n${rawOverrides === undefined ? "Default values" : "Scenario values"}:\n${metrics.map(line => `  ${line}`).join("\n")}` : ""}${diagnostics.length ? `\nCalculation diagnostics:\n${diagnostics.map(item => `  ${item.path} (${item.label}): ${item.message}`).join("\n")}` : ""}\nReference existence is checked when publishing to a room.`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output(json ? JSON.stringify({ valid: false, error: message }) : `Invalid Intelligent UI: ${message}`);
    return 1;
  }
}
