import { useId, useMemo, useState } from "react";
import { defaultUIValues, type IntelligentUI, type UIValue } from "@agora/intelligent-ui";
import type { TableScenario } from "@agora/types";
import { scenarioValuesForModel } from "@/lib/tool-session";
import { compareToolValues, type ToolComparisonRow } from "@/lib/tool-comparison";
import { formatIntelligentValue } from "@/lib/intelligent-format";

export function ToolScenarioComparison({ spec, revision, values, scenarios, invalidCurrent }: { spec: IntelligentUI; revision: number; values: Record<string, UIValue>; scenarios: TableScenario[]; invalidCurrent: boolean }) {
  const id = useId();
  const [leftId, setLeftId] = useState("defaults");
  const [rightId, setRightId] = useState("current");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const options = useMemo(() => [
    { id: "defaults", label: "Author defaults", values: defaultUIValues(spec) },
    { id: "current", label: "Current exploration", values },
    ...scenarios.flatMap(scenario => {
      const checked = scenarioValuesForModel(spec, revision, scenario);
      return checked.values ? [{ id: String(scenario.seq), label: `${scenario.name} · #${scenario.seq}`, values: checked.values }] : [];
    }),
  ], [spec, revision, values, scenarios]);
  const left = options.find(option => option.id === leftId) ?? options[0]!;
  const right = options.find(option => option.id === rightId) ?? options[1]!;
  const selectionMissing = left.id !== leftId || right.id !== rightId;
  const result = useMemo(() => {
    if (selectionMissing) return { error: "A selected scenario is no longer available in this model's recent history. Choose another scenario to compare." };
    if (invalidCurrent && (left.id === "current" || right.id === "current")) return { error: "Correct the invalid number fields before comparing your current exploration." };
    try { return { comparison: compareToolValues(spec, left.values, right.values) }; }
    catch { return { error: "These inputs cannot be compared with the current model. Choose another scenario." }; }
  }, [spec, left, right, invalidCurrent, selectionMissing]);
  const comparison = result.comparison;
  const visible = (rows: ToolComparisonRow[]) => rows.filter(item => !onlyChanged || item.changed || item.left === null || item.right === null || item.leftDiagnostic || item.rightDiagnostic);
  const inputRows = comparison ? visible(comparison.inputs) : [];
  const resultRows = comparison ? visible(comparison.outputs) : [];
  const display = (value: UIValue | null) => value === "" ? "(empty)" : formatIntelligentValue(value);
  const table = (title: string, rows: ToolComparisonRow[]) => <div className="tool-table-scroll rounded-xl border border-border" role="region" aria-label={title} tabIndex={0}>
    <table><caption className="px-3 py-2 text-left text-small font-semibold">{title}</caption><thead><tr>
      <th scope="col">Value</th><th scope="col">{left.label}</th><th scope="col">{right.label}</th><th scope="col">Difference</th>
    </tr></thead><tbody>{rows.map(item => <tr key={item.id} className={item.changed ? "bg-codex-soft/15" : undefined}>
      <th scope="row" title={item.id} className="!bg-transparent !text-foreground">{item.label}{item.unit ? <span className="block text-meta font-normal text-muted-foreground">{item.unit}</span> : null}</th>
      <td className="whitespace-pre-wrap">{display(item.left)}{item.leftDiagnostic ? <p className="mt-1 text-meta text-amber-ink">{item.leftDiagnostic}</p> : null}</td><td className="whitespace-pre-wrap">{display(item.right)}{item.rightDiagnostic ? <p className="mt-1 text-meta text-amber-ink">{item.rightDiagnostic}</p> : null}</td>
      <td>{item.left === null || item.right === null ? "Unavailable" : item.leftDiagnostic || item.rightDiagnostic ? "See warning" : item.delta !== null ? `${item.delta > 0 ? "+" : ""}${formatIntelligentValue(item.delta)}` : item.changed ? "Changed" : "—"}</td>
    </tr>)}</tbody></table>
  </div>;
  return <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-xl border border-codex/20 bg-codex-soft/10 p-3">
    <div><h3 id={`${id}-title`} className="text-small font-semibold">Compare scenarios</h3><p className="mt-1 text-meta text-muted-foreground">Compare inputs and computed results without changing your exploration. Only scenarios from this model are available.</p></div>
    <div className="grid gap-3 @sm:grid-cols-2">{[{ side: "Baseline", selectedId: leftId, option: left, change: setLeftId }, { side: "Compare with", selectedId: rightId, option: right, change: setRightId }].map(({ side, selectedId, option, change }) => <label key={side} className="flex min-w-0 flex-col gap-1.5 text-meta font-medium">{side}<select aria-label={side} className="min-h-10 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-small" value={selectedId} onChange={event => { change(event.target.value); setExpanded(false); }}>{option.id !== selectedId ? <option value={selectedId} disabled>Unavailable scenario · #{selectedId}</option> : null}{options.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>)}</div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-meta"><label className="inline-flex items-center gap-2"><input type="checkbox" checked={onlyChanged} onChange={event => setOnlyChanged(event.target.checked)} className="size-4" />Differences only</label>{comparison ? <span role="status" className="text-muted-foreground">{comparison.changed} differences{comparison.unavailable ? ` · ${comparison.unavailable} unavailable results` : ""}{comparison.warnings ? ` · ${comparison.warnings} results with warnings` : ""}</span> : null}</div>
    {result.error ? <p role="status" className="text-small text-amber-ink">{result.error}</p> : <>
      {inputRows.length ? table("Inputs", inputRows) : null}
      {resultRows.length ? table("Computed results", expanded ? resultRows : resultRows.slice(0, 60)) : null}
      {!inputRows.length && !resultRows.length ? <p className="py-3 text-small text-muted-foreground">These scenarios have the same inputs and computed results.</p> : null}
      {resultRows.length > 60 ? <button type="button" className="min-h-9 text-small underline underline-offset-4" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer results" : `Show all ${resultRows.length} results`}</button> : null}
      <p className="text-meta text-muted-foreground">Numeric differences are right minus left. A difference does not mean an improvement; unavailable values remain unknown.</p>
    </>}
  </section>;
}
