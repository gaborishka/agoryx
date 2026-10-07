import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, DownloadIcon, HistoryIcon, RotateCcwIcon, SaveIcon, SlidersHorizontalIcon, Undo2Icon } from "lucide-react";
import { defaultUIValues, parseIntelligentUI, type IntelligentUI, type UIValue } from "@agora/intelligent-ui";
import type { WorkComponentView } from "@agora/work-table";
import type { TableScenario } from "@agora/types";
import type { RoomState } from "@/lib/types";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestNonce } from "@/lib/request-nonce";
import { readToolDraft, writeToolDraft } from "@/lib/tool-draft";
import { acknowledgedScenario, safeInputSnapshot, safeScenarios, safePreviousDrafts } from "@/lib/tool-session";
import { ToolNode } from "./ToolNode";
import "./intelligent-ui.css";

const readable = (value: UIValue) => typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
const download = (filename: string, data: unknown, compact = false) => {
  // Tool definitions must round-trip through the same bounded authoring input.
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, compact ? undefined : 2) + (compact ? "" : "\n")], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export function IntelligentTool({ component, room, disabled }: { component: WorkComponentView; room: RoomState; disabled: boolean }) {
  const parsed = useMemo(() => {
    try { return { spec: parseIntelligentUI(component.ui, component.refs.map(ref => ref.id)) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [component.ui, component.refs]);
  if (!parsed.spec) return <p role="alert" className="text-small text-amber-ink">This tool could not be rendered. Its sources and history are preserved. {parsed.error}</p>;
  return <ToolSession key={`${room.id}:${component.id}:${component.contentSeq ?? component.seq}`} spec={parsed.spec} component={component} room={room} disabled={disabled} />;
}

function ToolSession({ spec, component, room, disabled }: { spec: IntelligentUI; component: WorkComponentView; room: RoomState; disabled: boolean }) {
  const post = useStore(s => s.post);
  const revision = component.contentSeq ?? component.seq;
  const draftKey = `agoryx.tool-draft.${room.id}.${component.id}.${revision}`;
  const [restored] = useState(() => readToolDraft(draftKey, spec));
  const saved = useMemo(() => safeInputSnapshot(spec, component.inputSnapshot), [spec, component.inputSnapshot]);
  const historyState = useMemo(() => safeScenarios(component.scenarios), [component.scenarios]);
  const latestValues = saved.snapshot?.values ?? defaultUIValues(spec);
  const currentSeq = saved.snapshot?.seq ?? 0;
  const [previousDrafts, setPreviousDrafts] = useState(() => safePreviousDrafts(`agoryx.tool-draft.${room.id}.${component.id}.`, draftKey));
  const [values, setValues] = useState(() => restored?.values ?? latestValues);
  const [baseSeq, setBaseSeq] = useState(restored?.baseSeq ?? currentSeq);
  const [name, setName] = useState(restored?.name ?? "");
  const [dirty, setDirty] = useState(!!restored);
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState(false);
  const [message, setMessage] = useState<string | null>(restored ? "Your unsaved exploration was restored on this device." : null);
  const [error, setError] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const saveBody = (inputValues: Record<string, UIValue>, scenarioName: string, seq: number) => ({ op: "component-input", target: component.id, revision, inputSeq: seq, values: inputValues, ...(scenarioName.trim() ? { name: scenarioName.trim() } : {}) });
  const retry = useRef<{ nonce: string; payload: string } | null>(restored?.saveNonce ? { nonce: restored.saveNonce, payload: JSON.stringify(saveBody(restored.values, restored.name, restored.baseSeq)) } : null);
  const inFlight = useRef<string | null>(null);
  const receipt = useStore(s => s.snap?.state.id === room.id && retry.current ? acknowledgedScenario(s.snap.ops, { nonce: retry.current.nonce, target: component.id, revision, by: room.human }) : null);
  const conflict = dirty && currentSeq !== baseSeq && receipt === null;
  const scenarios = [...historyState.scenarios].reverse();
  useEffect(() => {
    if (receipt === null || !retry.current) return;
    if (inFlight.current === retry.current.nonce) { inFlight.current = null; setPending(false); }
    retry.current = null; setDirty(false); setName(""); setError(null);
    setMessage("Scenario saved. Your team can read it; no decision has been made.");
  }, [receipt]);

  useEffect(() => {
    if (!dirty) { setValues(saved.snapshot?.values ?? defaultUIValues(spec)); setBaseSeq(currentSeq); }
  }, [currentSeq, saved.snapshot, spec, dirty]);
  useEffect(() => {
    setStorageFailed(!writeToolDraft(draftKey, dirty ? { version: 1, baseSeq, values, name, ...(retry.current ? { saveNonce: retry.current.nonce } : {}) } : null));
  }, [draftKey, dirty, baseSeq, values, name, pending]);

  const explore = (next: Record<string, UIValue>, scenarioName?: string) => {
    setValues(next); setDirty(true); setMessage(null); setError(null); retry.current = null;
    if (scenarioName !== undefined) setName(scenarioName);
  };
  const change = (id: string, value: UIValue) => explore({ ...values, [id]: value });
  const loadLatest = () => {
    setValues(latestValues); setBaseSeq(currentSeq); setDirty(false); setName(""); setError(null); retry.current = null;
    setMessage("Loaded the latest saved scenario.");
  };
  const save = async () => {
    if (disabled || pending || conflict || useStore.getState().snap?.state.id !== room.id) return;
    const body = saveBody(values, name, baseSeq);
    const payload = JSON.stringify(body);
    if (retry.current?.payload !== payload) retry.current = { nonce: requestNonce(), payload };
    const nonce = retry.current.nonce;
    inFlight.current = nonce;
    setPending(true); setError(null);
    writeToolDraft(draftKey, { version: 1, baseSeq, values, name, saveNonce: nonce });
    try {
      await post("/table", { ...body, nonce });
      if (retry.current?.nonce === nonce) {
        setDirty(false); setName(""); retry.current = null;
        setMessage("Scenario saved. Your team can read it; no decision has been made.");
      }
    } catch (e) {
      const snap = useStore.getState().snap;
      const confirmed = snap?.state.id === room.id && acknowledgedScenario(snap.ops, { nonce, target: component.id, revision, by: room.human }) !== null;
      if (!confirmed && retry.current?.nonce === nonce) setError(e instanceof Error ? e.message : String(e));
    } finally { if (inFlight.current === nonce) { inFlight.current = null; setPending(false); } }
  };
  const useScenario = (scenario: TableScenario) => {
    explore({ ...scenario.values }, `${scenario.name} copy`.slice(0, 80));
    setBaseSeq(currentSeq); setMessage(`Exploring ${scenario.name}. Save to share this version.`);
  };

  return <div className="intelligent-tool">
    <p className="mb-5 text-small leading-relaxed text-muted-foreground">{spec.description}</p>
    {saved.invalid || historyState.invalid ? <p role="alert" className="mb-4 rounded-xl bg-amber-soft/40 p-3 text-small text-amber-ink">Some saved scenario data could not be read. The tool remains available; its original history is preserved.</p> : null}
    {previousDrafts.map(previous => <div key={previous.key} role="status" className="mb-4 rounded-xl border border-amber/25 bg-amber-soft/30 p-3 text-small text-amber-ink"><p>This tool was updated. Your unsaved inputs from the earlier version are available to export.</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => download(`${component.id}-draft-${previous.revision}.json`, previous.draft)}>Export earlier draft</Button><Button size="sm" variant="ghost" onClick={() => { writeToolDraft(previous.key, null); setPreviousDrafts(items => items.filter(item => item.key !== previous.key)); }}>Dismiss</Button></div></div>)}
    <ToolNode node={spec.root} spec={spec} values={values} change={change} room={room} locked={pending} />
    <div className="mt-5 space-y-3 border-t border-border/70 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto inline-flex items-center gap-1.5 text-meta text-muted-foreground"><SlidersHorizontalIcon className="size-3.5" />{dirty ? "Exploring · not shared yet" : saved.snapshot ? `Saved by ${saved.snapshot.by}` : spec.inputs.length ? "Explore a scenario" : "Built for this task"}</span>
        <Button size="sm" variant="ghost" onClick={() => download(`${component.id}-tool.json`, spec, true)} aria-label={`Export tool definition: ${component.title}`}><DownloadIcon className="size-3.5" />Export</Button>
        {scenarios.length ? <Button size="sm" variant="ghost" onClick={() => setHistory(!history)} aria-expanded={history} aria-controls={`scenarios-${component.id}`}><HistoryIcon className="size-3.5" />Scenarios · {scenarios.length}</Button> : null}
        {spec.inputs.length ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => explore(defaultUIValues(spec))}><RotateCcwIcon className="size-3" />Reset</Button> : null}
        {dirty ? <Button size="sm" variant="ghost" disabled={pending} onClick={loadLatest}><Undo2Icon className="size-3" />Discard changes</Button> : null}
      </div>
      {spec.inputs.length ? <div className="flex flex-wrap items-end gap-2 rounded-xl bg-secondary/35 p-3">
        <label className="min-w-[min(100%,180px)] flex-1 text-meta font-medium text-muted-foreground">Scenario name <span className="font-normal">(optional)</span><Input aria-label="Scenario name" value={name} maxLength={80} disabled={pending} placeholder="For example: conservative estimate" onChange={e => { setName(e.target.value); setDirty(true); retry.current = null; }} className="mt-1.5 bg-card text-small" /></label>
        <Button size="sm" className="min-h-9" disabled={disabled || pending || conflict || !dirty && !!saved.snapshot} onClick={() => void save()}><SaveIcon className="size-3.5" />{pending ? "Saving…" : "Save scenario"}</Button>
      </div> : null}
      {conflict ? <div role="alert" className="rounded-xl border border-amber/25 bg-amber-soft/30 p-3 text-small text-amber-ink"><p>Another scenario was saved while you were exploring. Your inputs are still here.</p><div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={loadLatest}>Load latest</Button><Button size="sm" variant="ghost" onClick={() => { setBaseSeq(currentSeq); setError(null); retry.current = null; setMessage("The latest scenario stays in history. Save your exploration as a new scenario."); }}>Keep my exploration</Button></div></div> : null}
      {storageFailed && dirty ? <p role="status" className="text-meta text-amber-ink">Browser storage is unavailable. Save your scenario before leaving this view.</p> : null}
      {error ? <p role="alert" className="text-small text-destructive">{error} Your inputs are preserved; you can retry saving.</p> : null}
      {message ? <p role="status" className="flex items-start gap-1.5 text-meta text-muted-foreground"><CheckIcon className="mt-0.5 size-3 shrink-0" />{message}</p> : null}
      {history ? <section id={`scenarios-${component.id}`} aria-label="Saved scenarios" className="space-y-2">
        <p className="text-meta text-muted-foreground">Recent scenarios (up to 24). Earlier model versions stay available for inspection; the complete history remains in the room log.</p>
        {scenarios.map(scenario => <details key={scenario.seq} className="rounded-xl border border-border bg-secondary/15 p-3">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-small"><span className="font-medium [overflow-wrap:anywhere]">{scenario.name}</span><span className="text-meta text-muted-foreground">{scenario.by} · #{scenario.seq}{scenario.revision !== revision ? " · earlier model" : scenario.seq === currentSeq ? " · current" : ""}</span></summary>
          <dl className="my-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-small">{Object.entries(scenario.values).map(([key, value]) => <div key={key} className="contents"><dt className="text-muted-foreground [overflow-wrap:anywhere]">{scenario.revision === revision ? spec.inputs.find(input => input.id === key)?.label ?? key : key}</dt><dd className="whitespace-pre-wrap text-right tabular-nums [overflow-wrap:anywhere]">{readable(value)}</dd></div>)}</dl>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={pending || scenario.revision !== revision} onClick={() => useScenario(scenario)}>Use these inputs</Button><Button size="sm" variant="ghost" onClick={() => download(`${component.id}-scenario-${scenario.seq}.json`, { component: component.id, ...scenario })}>Export scenario</Button></div>
        </details>)}
      </section> : null}
    </div>
  </div>;
}
