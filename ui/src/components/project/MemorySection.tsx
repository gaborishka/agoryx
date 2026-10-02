import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Hint } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, Unauthorized } from "@/lib/api";
import { ago } from "@/lib/format";
import { errText } from "@/lib/load";
import type { MemoryEntry, MemoryKind, MemoryVoice, ProjectView } from "@/lib/types";

/**
 * The project's memory: what its rooms decided, found and still disagree about. Every entry is someone's claim, shown
 * with who holds it; open disagreements come first, with every side and the objections still standing against it.
 * Anyone edits it here or with `agoryx memory`; each edit saves itself, and one made against an older version is
 * refused rather than overwriting someone else's.
 */

const KINDS: Array<{ kind: MemoryKind; head: string }> = [
  { kind: "disagreement", head: "Open disagreements" },
  { kind: "decision", head: "Decisions" },
  { kind: "fact", head: "Facts" },
  { kind: "person", head: "People" },
  { kind: "preference", head: "Preferences" },
];

const claimant = (entry: MemoryEntry): string => {
  if (!entry.source) return entry.author === entry.by ? `noted by ${entry.by}` : `${entry.author}, noted by ${entry.by}`;
  const own = `${entry.author}’s ${entry.source.ref} in “${entry.source.roomName}”`;
  return entry.decidedBy ? `${own}, decided by ${entry.decidedBy}` : own;
};

function Voices({ voices, label }: { voices?: MemoryVoice[]; label: string }) {
  if (!voices?.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {voices.map((voice, index) => (
        <li key={index} className="text-small text-muted-foreground">
          <span className="text-destructive">✗</span> {label} <span className="text-foreground">{voice.by}</span>: <span className="whitespace-pre-wrap">{voice.text}</span>
        </li>
      ))}
    </ul>
  );
}

function EntryCard({ entry, hash, onSaved }: { entry: MemoryEntry; hash: string; onSaved: (project: ProjectView) => void }) {
  const [text, setText] = useState(entry.text);
  const [why, setWhy] = useState(entry.why ?? "");
  /** The version this card last loaded or saved: edits are sent against it. */
  const [base, setBase] = useState(entry);
  const [theirs, setTheirs] = useState<MemoryEntry | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");

  // Someone else's version arrives while nothing is typed here: show it.
  useEffect(() => {
    if (entry.seq === base.seq) return;
    if (text.trim() === base.text && why.trim() === (base.why ?? "")) {
      setText(entry.text);
      setWhy(entry.why ?? "");
      setBase(entry);
    }
  }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = text.trim() !== base.text || why.trim() !== (base.why ?? "");
  const save = useCallback(
    async (seq: number) => {
      setSaving("saving");
      try {
        const got = await api<{ project: ProjectView }>("PATCH", `/api/projects/${hash}/memory/${entry.id}`, { seq, text, why: why.trim() || null });
        const saved = got.project.memory.find((item) => item.id === entry.id);
        if (saved) setBase(saved);
        setTheirs(null);
        onSaved(got.project);
        setSaving("saved");
      } catch (err) {
        setSaving("idle");
        if (err instanceof ApiError && err.status === 409 && err.body.entry) setTheirs(err.body.entry as MemoryEntry);
        else if (!(err instanceof Unauthorized)) toast.error(errText(err));
      }
    },
    [hash, entry.id, text, why, onSaved],
  );

  useEffect(() => {
    if (!dirty || theirs || !text.trim()) return;
    const timer = setTimeout(() => void save(base.seq), 900);
    return () => clearTimeout(timer);
  }, [text, why, dirty, theirs, base.seq, save]);

  const remove = async () => {
    try {
      onSaved((await api<{ project: ProjectView }>("DELETE", `/api/projects/${hash}/memory/${entry.id}`)).project);
    } catch (err) {
      if (!(err instanceof Unauthorized)) toast.error(errText(err));
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border/70 px-3.5 py-3">
      <div className="flex items-baseline gap-2 text-meta text-faint">
        <span className="font-mono text-foreground/80">{entry.id}</span>
        <span className="min-w-0 flex-1 truncate">{claimant(entry)}</span>
        <span className="shrink-0">{saving === "saving" ? "Saving…" : dirty && !theirs ? "Edited" : saving === "saved" ? "Saved" : null}</span>
        <button type="button" onClick={() => void remove()} className="shrink-0 transition hover:text-foreground">
          Remove
        </button>
      </div>
      {entry.about ? <p className="text-small text-muted-foreground">About {entry.about}</p> : null}
      <Textarea
        aria-label={`${entry.id} text`}
        value={text}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        onChange={(event) => setText(event.target.value)}
        className="min-h-0 resize-y border-transparent bg-transparent px-0 py-0 text-small leading-relaxed shadow-none focus-visible:border-border focus-visible:px-2 focus-visible:py-1"
      />
      {entry.positions?.length ? (
        <ul className="flex flex-col gap-2 border-l border-border/70 pl-3">
          {entry.positions.map((position, index) => (
            <li key={position.ref ?? index} className="flex flex-col gap-1">
              <p className="text-small">
                <span className="font-mono text-meta text-faint">{position.ref}</span> <span className="font-medium">{position.by}</span> holds:{" "}
                <span className="whitespace-pre-wrap">{position.text}</span>
              </p>
              <Voices voices={position.objections} label="objected by" />
            </li>
          ))}
        </ul>
      ) : null}
      <Voices voices={entry.objections} label="still objected to by" />
      <Input aria-label={`${entry.id} reason`} value={why} placeholder="Why (optional)" onChange={(event) => setWhy(event.target.value)} className="h-8 text-small" />
      {theirs ? (
        <div className="flex flex-col gap-2 rounded-lg bg-amber-soft px-3 py-2 text-small">
          <span>
            <span className="font-medium">Changed since you opened it</span> ({theirs.revisedBy ?? theirs.by}):{" "}
            <span className="whitespace-pre-wrap text-muted-foreground">{theirs.text}</span>
            {theirs.why ? <span className="text-muted-foreground"> — why: {theirs.why}</span> : null}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(theirs.text);
                setWhy(theirs.why ?? "");
                setBase(theirs);
                setTheirs(null);
              }}
            >
              Take theirs
            </Button>
            <Button type="button" size="sm" onClick={() => void save(theirs.seq)}>
              Save mine
            </Button>
          </div>
        </div>
      ) : null}
      <p className="text-meta text-faint">
        written by {entry.from ? `${entry.from.label} in “${entry.from.roomName}”` : entry.by} {ago(entry.at)}
        {entry.revisedBy ? ` · revised by ${entry.revisedBy}` : ""}
      </p>
    </li>
  );
}

function NoteForm({ hash, onSaved }: { hash: string; onSaved: (project: ProjectView) => void }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const keep = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      onSaved((await api<{ project: ProjectView }>("POST", `/api/projects/${hash}/memory`, { note: { text, kind, why: why.trim() || undefined } })).project);
      setText("");
      setWhy("");
    } catch (err) {
      if (!(err instanceof Unauthorized)) toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void keep();
      }}
    >
      <Textarea
        aria-label="New memory entry"
        rows={2}
        value={text}
        placeholder="Something every Work room here should know: a decision, a fact, who to ask, how you like to work"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void keep();
          }
        }}
        className="resize-y text-small leading-relaxed"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(value) => setKind(value as MemoryKind)}>
          <SelectTrigger className="w-36" aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.filter((entry) => entry.kind !== "disagreement").map((entry) => (
              <SelectItem key={entry.kind} value={entry.kind}>
                {entry.kind[0]!.toUpperCase() + entry.kind.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={why} placeholder="Why (optional)" onChange={(event) => setWhy(event.target.value)} className="min-w-40 flex-1" aria-label="Why" />
        <Button type="submit" disabled={!text.trim() || busy}>
          Keep
        </Button>
      </div>
    </form>
  );
}

export function MemorySection({ project, onChange }: { project: ProjectView; onChange: (project: ProjectView) => void }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline gap-3">
        <h2 className="font-display text-lead font-semibold">Memory</h2>
        <span className="min-w-0 truncate font-mono text-meta text-faint" title={project.memoryPath}>
          {project.memory.length ? `${project.memory.length} · ` : ""}
          {project.memoryPath}
        </span>
      </header>
      <p className="text-small leading-relaxed text-muted-foreground">
        What the rooms here decided, found and still disagree about. Agents get an index of it, open disagreements first, with every fresh Work session.
        Anyone can keep a table item as the table holds it: <code className="font-mono text-meta">agoryx memory promote S3|D1|Q1</code>.
      </p>
      {project.memory.length === 0 ? <Hint>Nothing kept yet.</Hint> : null}
      {KINDS.map(({ kind, head }) => {
        const entries = project.memory.filter((entry) => entry.kind === kind);
        if (!entries.length) return null;
        return (
          <div key={kind} className="flex flex-col gap-2">
            <h3 className="text-ui font-medium">{head}</h3>
            <ul className="flex flex-col gap-2">
              {entries.map((entry) => (
                <EntryCard key={entry.id} entry={entry} hash={project.hash} onSaved={onChange} />
              ))}
            </ul>
          </div>
        );
      })}
      <NoteForm hash={project.hash} onSaved={onChange} />
    </section>
  );
}
