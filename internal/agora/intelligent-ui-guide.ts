import type { IntelligentUI } from "./intelligent-ui.js";

/** A small valid starting point, shared by the discoverable CLI guide and native agent briefings. */
export const INTELLIGENT_UI_EXAMPLE: IntelligentUI = {
  version: 1,
  description: "Illustrative model: work divides evenly; dependencies and coordination are excluded.",
  inputs: [{ id: "people", label: "Team size", type: "number", value: 3, min: 1, max: 10, step: 1, presentation: "number" }],
  root: { type: "stack", children: [
    { type: "input", id: "people" },
    { type: "metric", label: "Build time", value: { op: "divide", args: [30, { input: "people" }] }, unit: "days" },
  ] },
};

/** No filesystem/provider dependencies: this is also available to resumed agents through tool requests. */
export const intelligentUIGuide = (cli = "agoryx"): string => [
  "Intelligent UI: compose a native interface for the actual task when interaction helps the human understand or explore it. Choose a focused layout; do not turn every answer into a generic dashboard.",
  `Discover this contract any time with ${cli} ui guide. Validate without publishing: ${cli} ui check --file tool.json (include --ref F1 for each real source used by sources nodes).`,
  `Test scenarios before publishing: ${cli} ui check --file tool.json --values '{"people":5}' --json, or --values-file values.json. Supply a JSON object of input IDs to values; partial overrides merge with defaults and unknown keys/types/ranges are rejected. --json reports all metric, chart, progress, table and comparison outputs with stable paths, context labels and calculation diagnostics, including inactive views. Valid grammar can still yield Unavailable; inspect diagnostics and compare multiple realistic/boundary scenarios. No model calls or publication occur.`,
  `Publish: ${cli} table component "A useful title" --kind interactive --body-file tool.json [--ref F1]. Read: ${cli} table show W1. Refine your own component with --target W1; use its real supporting source refs, not a circular --ref W1.`,
  "Use a temporary JSON file or --body - on stdin for agent publication; do not modify project code to prepare a table tool. Only actual existing record IDs are valid sources; omit --ref when the tool has none.",
  `The JSON envelope is {version:1,description:string,inputs:[],root:node}. Complete minimal example: ${JSON.stringify(INTELLIGENT_UI_EXAMPLE)}`,
  'Every node has a "type". Allowed nodes and fields (? = optional; omit it in JSON):',
  "  stack {children:[nodes]}; grid {children:[nodes],columns?:2|3|4}; tabs {tabs:[{label,children:[nodes]}]} (2–6 tabs); accordion {sections:[{title,children:[nodes]}]} (1–12 sections). Children: 1–24 nodes per container.",
  "  heading {text,level?:2|3|4}; text/callout {text,tone?:neutral|positive|warning}; divider {}; badge {label,tone?:neutral|positive|warning}. Text is plain text, not HTML or Markdown.",
  "  metric {label,value:expression,unit?,detail?,decimals?:0..6}; progress {label,value:expression,max:expression,unit?,detail?} (use a positive max).",
  "  chart {title,items:[{label,value:expression}],unit?,variant?:bar|line|area|donut}. Use bar for categories, line/area for ordered series, donut only for nonnegative parts of a meaningful whole. Maximum 20 items.",
  "  table {columns:[strings],rows:[[expressions]],caption?,searchable?:boolean,sortable?:boolean}. Row width must match columns; at most 8 columns, 40 rows, 240 cells across the tool.",
  "  list {title?,items:[{title,detail?,status?:todo|doing|done|blocked}]}; timeline {title?,items:[{title,detail?,date?,status?:todo|doing|done|blocked}]} (1–24 items). Statuses are descriptive author claims, never room workflow actions or approvals.",
  "  comparison {columns:[{title,subtitle?,badge?,items:[{label,value:expression}]}]} (2–4 columns, 1–24 items each). Align labels across alternatives so their differences are easy to compare.",
  "  input {id}; sources {refs:[IDs declared with --ref]}. Each declared input must appear in exactly one input node. Source labels use current room records, while your authored model remains a snapshot until you refine it.",
  "Inputs all have {id,label,type,value}. IDs are unique lowercase letters/digits/underscores, starting with a letter. number adds {min,max,step?,unit?,presentation?:slider|number}; min < max, positive step defaults to 1, value within range. Use presentation:number for exact quantities; slider for exploration. select adds {options:[2–12 unique strings]} and value must be one of them. toggle uses boolean value. text/textarea use string value (empty allowed), optional placeholder and maxLength (1–2000, default 2000).",
  'Expressions: literal string/number/boolean, {"input":"id"}, or {"op":"operation","args":[expressions]}. Arithmetic add/multiply/min/max accepts 1–8 args; subtract/divide exactly 2; round exactly 1. Arithmetic accepts numbers/toggles, never numeric strings. equal/greater/less take 2; greater/less require numbers. if takes [boolean,then,else]. and/or take 1–8 booleans; not takes 1 boolean. length takes 1 string and returns its UTF-16 length; concat joins 1–8 primitive values without a separator (max result 8000 characters).',
  "Division by zero, overflow and incompatible expressions display Unavailable. Use equal and if for select choices. Numeric literals/bounds must be finite within ±1e12. Unknown fields, scripts, CSS, URLs and room actions are rejected.",
  "Bounds: 48,000 JSON characters, 80 layout nodes, depth 8, 16 inputs, 1200 expression nodes, 240 list/timeline/comparison items. Prefer a few well-chosen controls and clear units over using every component.",
  "Choose the representation deliberately: alternatives → comparison; ordered events → timeline; detailed evidence → searchable table/accordion; scenarios → exact inputs and computed metrics/charts; explanation → headings, steps, focused tabs. Use explicit assumptions, honest unknowns and grounded defaults; label illustrative data. Use the existing custom sandboxed HTML format for interactions beyond this grammar.",
  "Human exploration stays local until Save scenario records it. Read saved values with table show W1 before refinement and preserve useful context. Saved inputs are exploration, not approval, and do not start model turns. Never manufacture evidence, encode an approval control or imply a proposed task was executed.",
].join("\n");
