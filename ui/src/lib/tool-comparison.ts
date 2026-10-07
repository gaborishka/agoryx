import { validateUIValues, type IntelligentUI, type UIValue } from "../../../internal/agora/intelligent-ui.js";
import { evaluateUIOutputs } from "../../../internal/agora/intelligent-ui-evaluation.js";

export interface ToolComparisonRow {
  id: string;
  label: string;
  left: UIValue | null;
  right: UIValue | null;
  unit?: string;
  changed: boolean;
  delta: number | null;
  leftDiagnostic?: string;
  rightDiagnostic?: string;
}

const row = (id: string, label: string, left: UIValue | null, right: UIValue | null, unit?: string): ToolComparisonRow => {
  const difference = typeof left === "number" && typeof right === "number" ? right - left : NaN;
  return { id, label, left, right, ...(unit ? { unit } : {}), changed: left !== right, delta: Number.isFinite(difference) ? difference : null };
};

/** Both sides must use the same validated model; old revisions are never reinterpreted. */
export function compareToolValues(spec: IntelligentUI, rawLeft: Record<string, UIValue>, rawRight: Record<string, UIValue>) {
  const left = validateUIValues(spec, rawLeft), right = validateUIValues(spec, rawRight);
  const inputs = spec.inputs.map(input => row(`input.${input.id}`, input.label, left[input.id]!, right[input.id]!, "unit" in input ? input.unit : undefined));
  const leftOutputs = new Map(evaluateUIOutputs(spec, left).map(output => [output.path, output]));
  const outputs = evaluateUIOutputs(spec, right).map(output => {
    const previous = leftOutputs.get(output.path);
    return { ...row(output.path, output.label, previous?.value ?? null, output.value, output.unit), ...(previous?.diagnostic ? { leftDiagnostic: previous.diagnostic } : {}), ...(output.diagnostic ? { rightDiagnostic: output.diagnostic } : {}), ...(previous?.diagnostic || output.diagnostic ? { delta: null } : {}) };
  });
  return { inputs, outputs, changed: [...inputs, ...outputs].filter(item => item.changed).length, unavailable: outputs.filter(item => item.left === null || item.right === null).length, warnings: outputs.filter(item => item.leftDiagnostic || item.rightDiagnostic).length };
}
