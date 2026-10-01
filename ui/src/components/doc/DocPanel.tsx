import { ArrowLeftIcon, FileTextIcon, HistoryIcon, MessageSquareIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeFile, DocDiff } from "@/components/code/Code";
import { EmptyState, Hint, Loading } from "@/components/common/states";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Name, NativeBadge, Stats } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, roomPath, Unauthorized } from "@/lib/api";
import { ago, ext, fullDate, plural, PROSE_EXT } from "@/lib/format";
import { withMod } from "@/lib/keys";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { DocNow, DocRevision, DocRevisionView, RoomState } from "@/lib/types";
import { cn } from "@/lib/utils";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const revAuthor = (room: RoomState, r: DocRevision) =>
  r.by === "agoryx" ? "Initial version" : r.among ? r.among.map((id) => participant(room, id).label).join(" or ") : participant(room, r.by).label;

/** A revision made during parallel turns has no single author to show a face for. */
const revHandle = (r: DocRevision) => (r.among ? "agoryx" : r.by);

const revWhere = (room: RoomState, r: DocRevision) => {
  if (r.by === "agoryx") return "the room started from it";
  if (r.among) return "parallel turns — can’t tell whose";
  const who = participant(room, r.by);
  if (r.turnId) return "a turn in the room";
  if (r.native && who.agent) return "in their own session";
  return who.agent ? "outside a turn" : "an editor or this page";
};

function DocBody({ path, text }: { path: string; text: string }) {
  if (PROSE_EXT.has(ext(path))) {
    return (
      <article className="mx-auto w-full max-w-[72ch] rounded-2xl border border-border bg-paper px-6 py-7 shadow-soft sm:px-9">
        <Markdown text={text} variant="doc" />
      </article>
    );
  }
  return <CodeFile name={path} text={text} />;
}

function Bar({ children }: { children: React.ReactNode }) {
  return <div className="sticky top-0 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-border/70 bg-background/90 px-4 py-2.5 backdrop-blur">{children}</div>;
}

function NoDoc() {
  const post = useStore((s) => s.post);
  const driven = useStore((s) => s.snap?.driven);
  const [path, setPath] = useState("README.md");
  const [busy, setBusy] = useState(false);
  return (
    <EmptyState
      icon={FileTextIcon}
      title="Shared document"
      text="The room can write one shared text — a decision, an essay, a spec. Agoryx doesn’t say what goes in it: it only remembers every version with its author and shows each agent what the others changed."
    >
      {driven ? (
        <form
          className="flex w-full max-w-sm gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await post("/settings", { doc: path.trim() || null });
              toast.success("Document set");
            } catch (error) {
              if (!(error instanceof Unauthorized)) toast.error(errText(error));
              setBusy(false);
            }
          }}
        >
          <Input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} aria-label="File in the working folder" className="font-mono text-small" />
          <Button type="submit" disabled={busy || !path.trim()}>
            Set
          </Button>
        </form>
      ) : null}
    </EmptyState>
  );
}

type Edit = { base: string; text: string; startTick: number; conflict?: { hash: string; text: string } | null };

export function DocPanel() {
  const room = useStore((s) => s.snap?.state);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const docTick = useStore((s) => s.docTick);
  const docReset = useStore((s) => s.docReset);
  const lastRev = useStore((s) => s.lastDocRevision);
  const focus = useStore((s) => s.docFocus);
  const goToRef = useStore((s) => s.goToRef);
  const path = room?.settings.doc ?? null;
  const roomId = room?.id;

  const [doc, setDoc] = useState<DocNow | { error: string } | null>(null);
  const [view, setView] = useState<"now" | "history" | number>("now");
  const [revs, setRevs] = useState<Map<number, DocRevisionView | { error: string }>>(new Map());
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!roomId || !path) return;
    try {
      const next = await api<DocNow>("GET", roomPath(roomId, "/doc"));
      setDoc(next);
    } catch (error) {
      if (!(error instanceof Unauthorized)) setDoc({ error: errText(error) });
    }
  }, [roomId, path]);

  // A new room or a reassigned file starts clean.
  useEffect(() => {
    setDoc(null);
    setEdit(null);
    // A revision named in the address survives the room loading under it.
    setView(useStore.getState().docFocus ?? "now");
    setRevs(new Map());
  }, [roomId, docReset]);
  useEffect(() => {
    if (!edit) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, docTick]);
  useEffect(() => {
    if (focus == null) return;
    setEdit(null);
    setView(focus);
  }, [focus]);
  // The revision on screen is the one in the address.
  useEffect(() => {
    const seq = typeof view === "number" ? view : null;
    if (useStore.getState().docFocus !== seq) useStore.getState().setDocFocus(seq);
  }, [view]);
  useEffect(() => {
    if (typeof view !== "number" || revs.has(view) || !roomId) return;
    api<DocRevisionView>("GET", `${roomPath(roomId, "/doc")}?rev=${view}`)
      .then((rev) => setRevs((m) => new Map(m).set(view, rev)))
      .catch((error) => setRevs((m) => new Map(m).set(view, { error: errText(error) })));
  }, [view, revs, roomId]);

  const list = useMemo(() => (room && path ? (room.docRevisions ?? []).filter((r) => r.path === path) : []), [room, path]);

  if (!room) return null;
  if (!path) return <NoDoc />;

  const save = async (force = false) => {
    if (!edit) return;
    setSaving(true);
    const base = force && edit.conflict ? edit.conflict.hash : edit.base;
    try {
      const saved = await api<DocNow & { revision?: number | null }>("POST", roomPath(room.id, "/doc"), { text: edit.text, base });
      setEdit(null);
      setDoc({ path: saved.path, text: saved.text, hash: saved.hash, exists: saved.exists, truncated: saved.truncated });
      setView("now");
      toast.success(saved.revision ? "Saved — the agents will see the diff" : "No changes");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const current = (error.body as { current?: { hash: string; text: string } } | undefined)?.current ?? null;
        setEdit((e) => (e ? { ...e, conflict: current } : e));
      } else if (!(error instanceof Unauthorized)) toast.error(errText(error));
    } finally {
      setSaving(false);
    }
  };

  // --- editing -------------------------------------------------------------
  if (edit) {
    const stale = docTick !== edit.startTick && lastRev ? lastRev.by : null;
    return (
      <form
        className="flex h-full flex-col px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Bar>
          <FileTextIcon className="size-4 text-primary" />
          <span className="font-mono text-small">{path}</span>
          <span className="text-xs text-faint">editing</span>
        </Bar>
        {edit.conflict !== undefined ? (
          <div className="mb-3 flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive-soft px-3.5 py-3 text-small text-destructive">
            <span className="flex items-center gap-2 font-medium">
              <TriangleAlertIcon className="size-4" />
              The file changed while you were editing. Your text is still here.
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEdit(null);
                  void load();
                }}
              >
                Discard my edit
              </Button>
              <Button type="button" size="sm" variant="destructive" disabled={saving} onClick={() => void save(true)}>
                Save mine over it
              </Button>
            </div>
          </div>
        ) : stale ? (
          <div className="mb-3 rounded-xl bg-amber-soft px-3.5 py-2.5 text-small text-amber">
            Meanwhile the file was changed ({participant(room, stale).label}). Saving won’t silently overwrite anything — you’ll see the conflict first.
          </div>
        ) : null}
        <textarea
          autoFocus
          value={edit.text}
          onChange={(event) => setEdit({ ...edit, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          spellCheck
          aria-label={path}
          className="scroll-thin min-h-[320px] w-full flex-1 resize-none rounded-xl border border-input bg-paper p-4 font-mono text-small leading-relaxed outline-none focus:border-ring/60 focus:ring-3 focus:ring-ring/15"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">An edit doesn’t wake the agents — they see the diff on their next turn.</span>
          <Button type="button" variant="ghost" className="ml-auto" onClick={() => setEdit(null)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} title={withMod("S")}>
            Save
          </Button>
        </div>
      </form>
    );
  }

  // --- one revision ----------------------------------------------------------
  if (typeof view === "number") {
    const r = list.find((x) => x.seq === view);
    const rev = revs.get(view);
    let body: React.ReactNode = <Loading lines={3} className="p-4" />;
    if (rev && "error" in rev) body = <div className="rounded-xl bg-destructive-soft px-3.5 py-3 text-small text-destructive">{rev.error}</div>;
    else if (rev) {
      if (rev.truncated) body = <Hint className="text-ui">This version is too large (over 256 KB), so Agoryx kept only its hash and stats.</Hint>;
      else if (rev.previous == null && rev.text != null) body = <DocBody path={path} text={rev.text} />;
      else if (rev.text === null) body = <Hint className="text-ui">The file was deleted in this version.</Hint>;
      else body = rev.diff?.some((i) => "t" in i && i.t !== " ") ? <DocDiff items={rev.diff} /> : <Hint className="text-ui">The text didn’t change.</Hint>;
    }
    const message = r?.turnId ? room.messages.find((m) => m.turnId === r.turnId && m.kind !== "update") : undefined;
    return (
      <div className="px-4 pb-6">
        <Bar>
          <Button size="sm" variant="ghost" className="-ml-2 h-7" onClick={() => setView("history")}>
            <ArrowLeftIcon className="size-3.5" />
            History
          </Button>
          {r ? (
            <>
              <Avatar handle={revHandle(r)} size={20} />
              <b className="text-small">{revAuthor(room, r)}</b>
              <span className="text-xs text-muted-foreground">
                <time title={fullDate(r.ts)}>{ago(r.ts)}</time> · {revWhere(room, r)}
              </span>
              {r.by !== "agoryx" ? (
                <span className="text-xs">
                  <Stats added={r.added} removed={r.removed} deleted={r.deleted} />
                </span>
              ) : null}
            </>
          ) : null}
          {message ? (
            <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => goToRef(`m-${message.id}`)}>
              <MessageSquareIcon className="size-3.5" />
              Turn in conversation
            </Button>
          ) : null}
        </Bar>
        {body}
      </div>
    );
  }

  // --- history ---------------------------------------------------------------
  if (view === "history") {
    return (
      <div className="px-4 pb-6">
        <Bar>
          <Button size="sm" variant="ghost" className="-ml-2 h-7" onClick={() => setView("now")}>
            <ArrowLeftIcon className="size-3.5" />
            Text
          </Button>
          <span className="text-xs text-muted-foreground">
            {plural(list.length, "version", "versions")} of <span className="font-mono">{path}</span>
          </span>
        </Bar>
        <p className="mb-4 text-small leading-relaxed text-muted-foreground">
          Whoever changes the file and wherever — a turn in the room, an agent’s own session or your editor — the version stays here with its author, and the others
          see the diff on their next turn.
        </p>
        {list.length ? (
          <ol className="relative flex flex-col before:absolute before:top-3 before:bottom-3 before:left-[22px] before:w-px before:bg-border">
            {[...list].reverse().map((r) => {
              const who = participant(room, r.by);
              return (
                <li key={r.seq}>
                  <button type="button" onClick={() => setView(r.seq)} className="relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-accent">
                    <Avatar handle={revHandle(r)} size={24} className="ring-4 ring-background" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2 text-ui font-medium">
                        {revAuthor(room, r)}
                        {r.native && who.agent ? <NativeBadge agent={r.by} label="in their own session" tip={`Changed in ${who.label}’s own session, outside a turn in the room.`} /> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <time dateTime={r.ts} title={fullDate(r.ts)}>
                          {ago(r.ts)}
                        </time>{" "}
                        · {revWhere(room, r)}
                      </span>
                    </span>
                    {r.by !== "agoryx" ? (
                      <span className="text-xs">
                        <Stats added={r.added} removed={r.removed} deleted={r.deleted} />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <Hint className="text-ui">No versions yet.</Hint>
        )}
      </div>
    );
  }

  // --- current text ----------------------------------------------------------
  if (!doc || ("path" in doc && doc.path !== path)) return <Loading lines={3} className="p-4" />;
  if ("error" in doc) return <div className="m-4 rounded-xl bg-destructive-soft px-3.5 py-3 text-small text-destructive">{doc.error}</div>;
  const last = list.at(-1);
  return (
    <div className="px-4 pb-6">
      <Bar>
        <FileTextIcon className="size-4 text-primary" />
        <span className="truncate font-mono text-small" title="The room’s shared document">
          {path}
        </span>
        {last && last.by !== "agoryx" ? (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            · <Name handle={last.by} className="font-medium" /> {ago(last.ts)}
          </span>
        ) : null}
        <span className="ml-auto flex gap-1.5">
          {list.length ? (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setView("history")}>
              <HistoryIcon className="size-3.5" />
              History · {list.length}
            </Button>
          ) : null}
          {driven && !doc.truncated ? (
            <Button size="sm" variant="outline" className="h-7" onClick={() => setEdit({ base: doc.hash, text: doc.text, startTick: docTick })}>
              <PencilIcon className="size-3.5" />
              {doc.exists ? "Edit" : "Start"}
            </Button>
          ) : null}
        </span>
      </Bar>
      {doc.truncated ? (
        <Hint className="text-ui">The file is too large to edit here: below is only its beginning. The full file is in the working folder.</Hint>
      ) : null}
      {doc.exists ? (
        doc.text.trim() ? (
          <DocBody path={path} text={doc.text} />
        ) : (
          <Hint className="text-ui">The file is empty.</Hint>
        )
      ) : (
        <div className={cn("rounded-2xl border border-dashed border-border px-6 py-8 text-center text-ui text-muted-foreground")}>
          <code className="font-mono">{path}</code> doesn’t exist yet. The agents will create it when there’s something to write — or you can start it.
        </div>
      )}
    </div>
  );
}
