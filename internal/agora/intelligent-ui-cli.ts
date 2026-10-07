import { readFileSync } from "node:fs";
import { defaultUIValues, evaluateUI, parseIntelligentUI, type UINode } from "./intelligent-ui.js";
import { intelligentUIGuide } from "./intelligent-ui-guide.js";

export const INTELLIGENT_UI_USAGE = "agoryx ui guide | agoryx ui check [--file tool.json | --body JSON | -] [--ref F1]";
/** Local preflight never opens a room, reads credentials, publishes or starts a model. */
export function runIntelligentUICommand(argv: string[], output: (text: string) => void = console.log): number {
  const [verb, ...args] = argv;
  if (!verb || verb === "--help" || verb === "-h") { output(INTELLIGENT_UI_USAGE); return 0; }
  if (verb === "guide") {
    if (args.length) { output("ui guide takes no arguments"); return 2; }
    output(intelligentUIGuide()); return 0;
  }
  if (verb !== "check") { output(INTELLIGENT_UI_USAGE); return 2; }
  let file: string | undefined, body: string | undefined;
  const refs: string[] = [];
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-" && file === undefined) { file = "-"; continue; }
      if (!["--file", "--body", "--ref"].includes(arg)) throw new Error(`unknown argument '${arg}'`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--ref") {
        const ref = value.trim().replace(/^#/, "").toUpperCase();
        if (!/^[QPNFSXDCW][1-9]\d*$/.test(ref)) throw new Error(`invalid table reference '${value}'`);
        if (refs.length >= 24) throw new Error("at most 24 references");
        refs.push(ref);
      } else if (arg === "--file") { if (file !== undefined) throw new Error("use one --file"); file = value; }
      else { if (body !== undefined) throw new Error("use one --body"); body = value; }
    }
    if (body !== undefined && file !== undefined) throw new Error("use --body or --file/stdin, not both");
    if (body === undefined && file === undefined && process.stdin.isTTY) throw new Error("give a spec with --file, --body or stdin");
    const source = body ?? readFileSync(file && file !== "-" ? file : 0, "utf8");
    const spec = parseIntelligentUI(source, refs);
    const values = defaultUIValues(spec);
    const kinds = new Map<string, number>();
    const metrics: string[] = [];
    const visit = (node: UINode) => {
      kinds.set(node.type, (kinds.get(node.type) ?? 0) + 1);
      if (node.type === "metric") {
        const result = evaluateUI(node.value, values);
        metrics.push(`${node.label}: ${result === null ? "Unavailable" : String(result)}${node.unit ? ` ${node.unit}` : ""}`);
      }
      if ("children" in node) node.children.forEach(visit);
      if (node.type === "tabs") node.tabs.forEach(tab => tab.children.forEach(visit));
      if (node.type === "accordion") node.sections.forEach(section => section.children.forEach(visit));
    };
    visit(spec.root);
    output(`Valid Intelligent UI v${spec.version}\n${spec.description}\nInputs: ${spec.inputs.length}\nComponents: ${[...kinds].map(([kind, count]) => `${kind} × ${count}`).join(", ")}${metrics.length ? `\nDefault values:\n${metrics.map(line => `  ${line}`).join("\n")}` : ""}\nReference existence is checked when publishing to a room.`);
    return 0;
  } catch (error) { output(`Invalid Intelligent UI: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
