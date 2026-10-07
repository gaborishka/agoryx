import { useEffect, useId, useState, type CSSProperties } from "react";
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon, CheckIcon, ChevronDownIcon, CircleIcon, LoaderCircleIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { evaluateUI, type IntelligentUI, type UIInput, type UINode, type UIValue } from "@agora/intelligent-ui";
import { createWorkRefResolver } from "@agora/work-table";
import type { RoomState } from "@/lib/types";
import { compareIntelligentValues, formatIntelligentValue as format } from "@/lib/intelligent-format";
import { WorkSources } from "./AgentComponent";
import "./intelligent-ui.css";

export type ToolNodeProps = { node: UINode; spec: IntelligentUI; values: Record<string, UIValue>; change: (id: string, value: UIValue) => void; room: RoomState; locked: boolean };
type ChartNode = Extract<UINode, { type: "chart" }>;
type TableNode = Extract<UINode, { type: "table" }>;
const colors = ["var(--primary)", "var(--codex)", "var(--amber)", "var(--add-ink)", "var(--muted-foreground)"];
const finite = (value: UIValue | null): value is number => typeof value === "number" && Number.isFinite(value);
const axisFormat = (value: number) => value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < .001)
  ? value.toLocaleString(undefined, { notation: "scientific", maximumSignificantDigits: 3 })
  : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });

export function ToolNode(props: ToolNodeProps) {
  const { node, spec, values, change, room, locked } = props;
  const [tab, setTab] = useState(0);
  const id = useId();
  const render = (child: UINode, index: number) => <ToolNode key={index} {...props} node={child} />;
  switch (node.type) {
    case "stack": return <div className="tool-stack">{node.children.map(render)}</div>;
    case "grid": return <div className="tool-grid" data-columns={node.columns ?? 2}>{node.children.map(render)}</div>;
    case "heading": { const Heading = `h${node.level ?? 3}` as "h2" | "h3" | "h4"; return <Heading className="tool-heading" data-level={node.level ?? 3}>{node.text}</Heading>; }
    case "divider": return <hr className="tool-divider" />;
    case "badge": return <div><span className="tool-badge" data-tone={node.tone ?? "neutral"}>{node.label}</span></div>;
    case "tabs": return <div className="tool-tabs">
      <div role="tablist" aria-label="Tool views" className="tool-tablist" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? node.tabs.length - 1 : (tab + (event.key === "ArrowRight" ? 1 : -1) + node.tabs.length) % node.tabs.length;
        setTab(next); document.getElementById(`${id}-tab-${next}`)?.focus();
      }}>{node.tabs.map((item, index) => <button key={index} id={`${id}-tab-${index}`} role="tab" type="button" aria-selected={tab === index} aria-controls={`${id}-panel-${index}`} tabIndex={tab === index ? 0 : -1} onClick={() => setTab(index)}>{item.label}</button>)}</div>
      {node.tabs.map((item, index) => <div key={index} role="tabpanel" id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={tab !== index} tabIndex={0}><div className="tool-stack">{item.children.map(render)}</div></div>)}
    </div>;
    case "text": return <p className="tool-copy">{node.text}</p>;
    case "callout": return <div className="tool-callout" data-tone={node.tone ?? "neutral"}>{node.text}</div>;
    case "metric": return <div className="tool-metric"><div className="tool-eyebrow">{node.label}</div><div className="tool-metric-value"><output aria-label={node.label}>{format(evaluateUI(node.value, values), node.decimals)}</output>{node.unit ? <span>{node.unit}</span> : null}</div>{node.detail ? <p className="tool-detail">{node.detail}</p> : null}</div>;
    case "input": return <ToolInput input={spec.inputs.find(input => input.id === node.id)!} value={values[node.id]} change={value => change(node.id, value)} locked={locked} />;
    case "chart": return <ToolChart node={node} values={values} />;
    case "table": return <ToolTable node={node} values={values} />;
    case "progress": {
      const amount = evaluateUI(node.value, values), maximum = evaluateUI(node.max, values);
      const valid = finite(amount) && finite(maximum) && maximum > 0;
      const outside = valid && (amount < 0 || amount > maximum);
      const percentage = valid ? Math.min(100, Math.max(0, amount / maximum * 100)) : 0;
      return <div className="tool-surface"><div className="tool-between"><span className="tool-label" id={id}>{node.label}</span><span className="tool-number">{valid ? `${format(amount)} / ${format(maximum)}${node.unit ? ` ${node.unit}` : ""}` : "Unavailable"}</span></div><div className="tool-progress" role={valid ? "progressbar" : undefined} aria-labelledby={id} aria-valuemin={valid ? 0 : undefined} aria-valuemax={valid ? maximum : undefined} aria-valuenow={valid ? Math.min(maximum, Math.max(0, amount)) : undefined} aria-valuetext={valid ? `${format(amount)} of ${format(maximum)}${outside ? "; outside the progress range" : ""}` : undefined}><span style={{ width: `${percentage}%` }} /></div>{node.detail ? <p className="tool-detail">{node.detail}</p> : null}{outside ? <p className="tool-note">Value is outside the progress range. The bar is limited to 0–100%.</p> : !valid ? <p className="tool-note">Progress requires a numeric value and a positive maximum.</p> : null}</div>;
    }
    case "list":
    case "timeline": return <section className="tool-surface">{node.title ? <h4 className="tool-label tool-section-title">{node.title}</h4> : null}<ol className={node.type === "timeline" ? "tool-timeline" : "tool-list"}>{node.items.map((item, index) => <li key={index} data-status={item.status}><div className="tool-state-icon" aria-hidden="true">{item.status === "done" ? <CheckIcon /> : item.status === "blocked" ? <TriangleAlertIcon /> : item.status === "doing" ? <LoaderCircleIcon /> : <CircleIcon />}</div><div className="tool-list-body"><div className="tool-between"><span className="tool-label">{item.title}</span>{"date" in item && item.date ? <span className="tool-date">{item.date}</span> : null}</div>{item.detail ? <p className="tool-detail">{item.detail}</p> : null}{item.status ? <span className="tool-state-text">{{ todo: "To do", doing: "In progress", done: "Done", blocked: "Blocked" }[item.status]}</span> : null}</div></li>)}</ol></section>;
    case "accordion": return <div className="tool-accordion">{node.sections.map((section, index) => <details key={index}><summary><span>{section.title}</span><ChevronDownIcon aria-hidden="true" /></summary><div className="tool-stack">{section.children.map(render)}</div></details>)}</div>;
    case "comparison": return <div className="tool-grid tool-comparison" data-columns={node.columns.length}>{node.columns.map((column, index) => <section className="tool-surface" key={index}><header><div className="tool-between"><h4 className="tool-heading" data-level="4">{column.title}</h4>{column.badge ? <span className="tool-badge">{column.badge}</span> : null}</div>{column.subtitle ? <p className="tool-detail">{column.subtitle}</p> : null}</header><dl>{column.items.map((item, itemIndex) => <div key={itemIndex}><dt>{item.label}</dt><dd>{format(evaluateUI(item.value, values))}</dd></div>)}</dl></section>)}</div>;
    case "sources": { const resolve = createWorkRefResolver(room); return <div className="tool-sources"><p className="tool-eyebrow">Linked evidence · current room records</p>{node.refs.map(ref => { const source = resolve(ref); return <div key={ref}><WorkSources refs={[source]} /><p className="tool-detail">{source.kind === "missing" ? "Source no longer available" : source.text ?? ref}</p></div>; })}</div>; }
  }
}

function ToolInput({ input, value, change, locked }: { input: UIInput; value: UIValue; change: (value: UIValue) => void; locked: boolean }) {
  const id = useId();
  if (input.type === "number") return <NumberInput input={input} value={Number(value)} change={change} locked={locked} />;
  return <div className="tool-input" data-kind={input.type}><label htmlFor={id} className="tool-label">{input.label}</label>
    {input.type === "toggle" ? <input id={id} type="checkbox" checked={Boolean(value)} disabled={locked} onChange={event => change(event.target.checked)} />
      : input.type === "select" ? <select id={id} value={String(value)} disabled={locked} onChange={event => change(event.target.value)}>{input.options.map(option => <option key={option}>{option}</option>)}</select>
        : input.type === "textarea" ? <textarea id={id} value={String(value)} placeholder={input.placeholder} maxLength={input.maxLength ?? 2000} disabled={locked} onChange={event => change(event.target.value)} rows={4} />
          : <input id={id} type="text" value={String(value)} placeholder={input.placeholder} maxLength={input.maxLength ?? 2000} disabled={locked} onChange={event => change(event.target.value)} />}
    {(input.type === "text" || input.type === "textarea") && input.maxLength ? <span className="tool-input-count">{String(value).length} / {input.maxLength}</span> : null}
  </div>;
}

function NumberInput({ input, value, change, locked }: { input: Extract<UIInput, { type: "number" }>; value: number; change: (value: UIValue) => void; locked: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  const numeric = draft.trim() === "" ? NaN : Number(draft);
  const invalid = !Number.isFinite(numeric) || numeric < input.min || numeric > input.max;
  return <div className="tool-input"><div className="tool-between"><label htmlFor={id} className="tool-label">{input.label}</label>{input.unit ? <span className="tool-unit">{input.unit}</span> : null}</div>
    <input id={id} type="number" inputMode="decimal" min={input.min} max={input.max} step="any" value={editing ? draft : String(value)} disabled={locked} aria-invalid={editing && invalid || undefined} aria-describedby={`${id}-help`} onFocus={() => { setDraft(String(value)); setEditing(true); }} onChange={event => { const next = event.target.value; setDraft(next); const number = next.trim() === "" ? NaN : Number(next); if (Number.isFinite(number) && number >= input.min && number <= input.max) change(number); }} onBlur={() => { setEditing(false); setDraft(String(value)); }} />
    {input.presentation !== "number" ? <input aria-label={`${input.label} slider`} type="range" min={input.min} max={input.max} step={input.step ?? 1} value={value} disabled={locked} onChange={event => { const next = Number(event.target.value); setEditing(false); setDraft(String(next)); change(next); }} /> : null}
    <div className="tool-range-bounds" id={`${id}-help`}><span>{format(input.min)}</span><span>{format(input.max)}</span></div>
    {editing && invalid ? <p className="tool-note" role="status">Enter a number from {format(input.min)} to {format(input.max)}. Results use {format(value)} until a valid value is entered.</p> : null}
  </div>;
}

function ToolTable({ node, values }: { node: TableNode; values: Record<string, UIValue> }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ column: number; direction: "asc" | "desc" } | null>(null);
  const id = useId();
  const rows = node.rows.map((row, index) => ({ index, cells: row.map(cell => evaluateUI(cell, values)) }))
    .filter(row => !query.trim() || row.cells.some(cell => `${format(cell)} ${cell ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  if (sort) rows.sort((a, b) => compareIntelligentValues(a.cells[sort.column] ?? null, b.cells[sort.column] ?? null, sort.direction) || a.index - b.index);
  return <section className="tool-table-shell">
    {node.searchable ? <div className="tool-table-search"><label htmlFor={id}><SearchIcon aria-hidden="true" /><span className="sr-only">Search {node.caption ?? "table"}</span></label><input id={id} type="search" placeholder="Search rows…" value={query} onChange={event => setQuery(event.target.value)} /><span role="status" className="tool-detail">{rows.length} / {node.rows.length}</span></div> : null}
    <div className="tool-table-scroll" role="region" aria-label={node.caption ?? "Data table"} tabIndex={0}><table><caption className={node.caption ? undefined : "sr-only"}>{node.caption ?? "Tool data"}</caption><thead><tr>{node.columns.map((column, index) => <th key={index} scope="col" aria-sort={sort?.column === index ? sort.direction === "asc" ? "ascending" : "descending" : node.sortable ? "none" : undefined}>{node.sortable ? <button type="button" onClick={() => setSort(previous => ({ column: index, direction: previous?.column === index && previous.direction === "asc" ? "desc" : "asc" }))}>{column}{sort?.column === index ? sort.direction === "asc" ? <ArrowUpIcon aria-hidden="true" /> : <ArrowDownIcon aria-hidden="true" /> : <ArrowUpDownIcon aria-hidden="true" />}</button> : column}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.index}>{row.cells.map((cell, index) => <td key={index}>{format(cell)}</td>)}</tr>)}{!rows.length ? <tr><td colSpan={node.columns.length} className="tool-table-empty">No rows match “{query}”.</td></tr> : null}</tbody></table></div>
  </section>;
}

function ToolChart({ node, values }: { node: ChartNode; values: Record<string, UIValue> }) {
  const id = useId();
  const amounts = node.items.map(item => evaluateUI(item.value, values));
  const numbers = amounts.filter(finite);
  const variant = node.variant ?? "bar";
  const minimum = Math.min(0, ...numbers), maximum = Math.max(0, ...numbers);
  // Normalize first: two finite endpoints can still overflow when subtracted.
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
  const low = minimum / scale, high = maximum / scale;
  const extent = high - low || 1;
  const hasUnknown = amounts.some(amount => !finite(amount));
  const continuous = variant === "line" || variant === "area";
  const legend = <ul className="tool-chart-legend">{node.items.map((item, index) => <li key={index}><span className="tool-chart-dot" style={{ background: continuous ? "var(--codex)" : colors[index % colors.length] }} aria-hidden="true" /><span>{continuous ? `${index + 1} · ` : ""}{item.label}</span><span className="tool-number">{finite(amounts[index] ?? null) ? format(amounts[index]!) : "Unavailable"}</span></li>)}</ul>;
  let visual;
  if (variant === "donut") {
    const sum = numbers.reduce((total, amount) => total + amount, 0);
    const valid = !hasUnknown && minimum >= 0 && sum > 0 && Number.isFinite(sum);
    let offset = 0;
    visual = <div className="tool-donut-layout">{valid ? <svg className="tool-donut" viewBox="0 0 160 160" role="img" aria-labelledby={`${id}-title`}><title id={`${id}-title`}>{node.title} — values listed below</title><circle cx="80" cy="80" r="58" fill="none" stroke="var(--secondary)" strokeWidth="20" />{numbers.map((amount, index) => { const fraction = amount / sum * 100, start = offset; offset += fraction; return <circle className="tool-donut-segment" key={index} cx="80" cy="80" r="58" fill="none" stroke={colors[index % colors.length]} strokeWidth="20" pathLength="100" strokeDasharray={`${fraction} ${100 - fraction}`} strokeDashoffset={-start} transform="rotate(-90 80 80)" />; })}<text x="80" y="78" textAnchor="middle" className="tool-donut-total">{axisFormat(sum)}</text><text x="80" y="98" textAnchor="middle" className="tool-svg-label">Total{node.unit ? ` · ${node.unit}` : ""}</text></svg> : <div className="tool-chart-empty">{hasUnknown ? "A share is unavailable." : minimum < 0 ? "A part-to-whole chart cannot represent negative values." : !Number.isFinite(sum) ? "Total cannot be represented." : "No positive total to display."}</div>}{legend}</div>;
  } else if (variant === "line" || variant === "area") {
    const left = 56, right = 476, top = 22, bottom = 184;
    const x = (index: number) => node.items.length === 1 ? (left + right) / 2 : left + index / (node.items.length - 1) * (right - left);
    const y = (amount: number) => bottom - (amount / scale - low) / extent * (bottom - top);
    const segments: { x: number; y: number; index: number }[][] = [];
    let current: { x: number; y: number; index: number }[] = [];
    amounts.forEach((amount, index) => { if (finite(amount)) current.push({ x: x(index), y: y(amount), index }); else if (current.length) { segments.push(current); current = []; } });
    if (current.length) segments.push(current);
    visual = <><svg className="tool-line-chart" viewBox="0 0 500 224" role="img" aria-labelledby={`${id}-title`}><title id={`${id}-title`}>{node.title} — values listed below; missing values leave gaps</title><defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--codex)" stopOpacity="0.28" /><stop offset="100%" stopColor="var(--codex)" stopOpacity="0.025" /></linearGradient></defs>{[0, 0.5, 1].map(fraction => { const amount = (low + extent * fraction) * scale, ordinate = y(amount); return <g key={fraction}><line x1={left} x2={right} y1={ordinate} y2={ordinate} className="tool-chart-gridline" /><text x={left - 8} y={ordinate + 4} textAnchor="end" className="tool-svg-label">{axisFormat(amount)}</text></g>; })}{minimum < 0 && maximum > 0 ? <line x1={left} x2={right} y1={y(0)} y2={y(0)} className="tool-chart-zero" /> : null}{segments.map((segment, index) => { const path = segment.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${point.x},${point.y}`).join(" "); return <g key={index}>{variant === "area" ? <path className="tool-area-path" d={`${path} L${segment.at(-1)!.x},${y(0)} L${segment[0]!.x},${y(0)} Z`} fill={`url(#${id}-fill)`} /> : null}<path className="tool-line-path" d={path} fill="none" stroke="var(--codex)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />{segment.map(point => <circle className="tool-line-point" key={point.index} cx={point.x} cy={point.y} r="3.5" fill="var(--card)" stroke="var(--codex)" strokeWidth="2"><title>{node.items[point.index]!.label}: {format(amounts[point.index]!)}</title></circle>)}</g>; })}<text x={left} y="210" className="tool-svg-label">1</text><text x={right} y="210" textAnchor="end" className="tool-svg-label">{node.items.length}</text></svg>{hasUnknown ? <p className="tool-note">Unavailable points are shown as gaps.</p> : null}{legend}</>;
  } else {
    const zero = -low / extent * 100;
    visual = <div className="tool-bars">{node.items.map((item, index) => { const amount = amounts[index] ?? null; const point = finite(amount) ? (amount / scale - low) / extent * 100 : zero; return <div key={index}><div className="tool-between"><span>{item.label}</span><span className="tool-number">{finite(amount) ? format(amount) : "Unavailable"}</span></div><div className="tool-bar-track" aria-hidden="true"><span className="tool-bar-zero" style={{ left: `${zero}%` }} /><span className="tool-bar-fill" style={{ left: `${Math.min(zero, point)}%`, width: `${Math.abs(point - zero)}%`, background: colors[index % colors.length] }} /></div></div>; })}{minimum < 0 ? <p className="tool-note">Bars extend left of zero for negative values.</p> : null}</div>;
  }
  return <figure className="tool-surface tool-chart" style={{ "--tool-chart-color": "var(--codex)" } as CSSProperties}><figcaption className="tool-label">{node.title}{node.unit ? <span className="tool-unit"> · {node.unit}</span> : null}</figcaption>{visual}</figure>;
}
