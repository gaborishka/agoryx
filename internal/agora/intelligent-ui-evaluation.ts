import { evaluateUI, validateUIValues, type IntelligentUI, type UIExpression, type UINode, type UIValue } from "./intelligent-ui.js";

export type UIOutputKind = "metric" | "chart" | "progress" | "table" | "comparison";
export interface UIOutput {
  /** Schema path, stable for a particular model revision. */
  path: string;
  label: string;
  kind: UIOutputKind;
  value: UIValue | null;
  unit?: string;
  diagnostic?: string;
}

/** Explain an unavailable result without evaluating source code or inventing a numeric fallback. */
function unavailableReason(expression: UIExpression, values: Record<string, UIValue>): string {
  if (typeof expression !== "object") return "The value is unavailable.";
  if ("input" in expression) return `Input '${expression.input}' has no value.`;
  const args = expression.args.map(argument => evaluateUI(argument, values));
  if (expression.op === "if") {
    if (typeof args[0] !== "boolean") return "if requires a boolean condition.";
    return unavailableReason(expression.args[args[0] ? 1 : 2]!, values);
  }
  const unknown = args.findIndex(argument => argument === null);
  if (unknown !== -1) return unavailableReason(expression.args[unknown]!, values);
  if (expression.op === "length") return "length requires a string.";
  if (expression.op === "not" || expression.op === "and" || expression.op === "or") return `${expression.op} requires boolean arguments.`;
  if (expression.op === "greater" || expression.op === "less") return `${expression.op} requires numeric arguments.`;
  if (expression.op === "concat") return "The concatenated result exceeds 8000 characters.";
  if (args.some(argument => typeof argument !== "number" && typeof argument !== "boolean")) return `${expression.op} requires numbers or toggles; strings are not converted to numbers.`;
  if (expression.op === "divide" && Number(args[1]) === 0) return "Division by zero.";
  return "The arithmetic result is not finite.";
}

/** Evaluate all visible-value expressions, including inactive tabs/accordions, using a validated complete scenario. */
export function evaluateUIOutputs(spec: IntelligentUI, values: Record<string, UIValue>): UIOutput[] {
  const inputs = validateUIValues(spec, values);
  const outputs: UIOutput[] = [];
  const emit = (path: string, label: string, kind: UIOutputKind, expression: UIExpression, unit?: string, numeric = false) => {
    const result = evaluateUI(expression, inputs);
    const incompatible = numeric && typeof result !== "number";
    const value = incompatible ? null : result;
    const diagnostic = result === null ? unavailableReason(expression, inputs) : incompatible ? "This visual requires a numeric result." : undefined;
    outputs.push({ path, label, kind, value, ...(unit === undefined ? {} : { unit }), ...(diagnostic ? { diagnostic } : {}) });
  };
  const visit = (node: UINode, path: string) => {
    switch (node.type) {
      case "metric": emit(`${path}.value`, node.label, "metric", node.value, node.unit); break;
      case "chart": {
        const start = outputs.length;
        node.items.forEach((item, index) => emit(`${path}.items[${index}].value`, `${node.title} · ${item.label}`, "chart", item.value, node.unit, true));
        if (node.variant === "donut") {
          const parts = outputs.slice(start);
          const numbers = parts.filter((part): part is UIOutput & { value: number } => typeof part.value === "number").map(part => part.value);
          const sum = numbers.reduce((total, number) => total + number, 0);
          const diagnostic = numbers.length !== parts.length ? "The donut cannot be drawn until every part has a numeric value."
            : numbers.some(number => number < 0) ? "A donut cannot represent negative values."
            : !Number.isFinite(sum) ? "The donut total is not finite."
            : sum <= 0 ? "A donut requires a positive total."
            : undefined;
          if (diagnostic) for (const part of parts) part.diagnostic = part.diagnostic ?? diagnostic;
        }
        break;
      }
      case "progress": {
        emit(`${path}.value`, `${node.label} · value`, "progress", node.value, node.unit, true);
        emit(`${path}.max`, `${node.label} · maximum`, "progress", node.max, node.unit, true);
        const amount = outputs.at(-2)!, maximum = outputs.at(-1)!;
        if (amount.value === null || maximum.value === null || Number(maximum.value) <= 0) {
          const diagnostic = amount.diagnostic ?? maximum.diagnostic ?? `Progress requires a positive maximum; received ${String(maximum.value)}.`;
          amount.value = null; maximum.value = null;
          amount.diagnostic = diagnostic; maximum.diagnostic = diagnostic;
        } else if (Number(amount.value) < 0 || Number(amount.value) > Number(maximum.value)) {
          amount.diagnostic = `Progress value ${String(amount.value)} is outside 0–${String(maximum.value)}; the bar is limited to 0–100%.`;
        }
        break;
      }
      case "table":
        node.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => emit(`${path}.rows[${rowIndex}][${columnIndex}]`, `${node.caption ?? "Table"} · row ${rowIndex + 1} · ${node.columns[columnIndex]}`, "table", cell)));
        break;
      case "comparison":
        node.columns.forEach((column, columnIndex) => column.items.forEach((item, itemIndex) => emit(`${path}.columns[${columnIndex}].items[${itemIndex}].value`, `${column.title} · ${item.label}`, "comparison", item.value)));
        break;
      case "stack": case "grid": node.children.forEach((child, index) => visit(child, `${path}.children[${index}]`)); break;
      case "tabs": node.tabs.forEach((tab, index) => tab.children.forEach((child, childIndex) => visit(child, `${path}.tabs[${index}].children[${childIndex}]`))); break;
      case "accordion": node.sections.forEach((section, index) => section.children.forEach((child, childIndex) => visit(child, `${path}.sections[${index}].children[${childIndex}]`))); break;
    }
  };
  visit(spec.root, "ui.root");
  return outputs;
}
