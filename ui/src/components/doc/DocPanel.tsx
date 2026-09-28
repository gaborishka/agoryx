import { ArrowLeftIcon, FileTextIcon, HistoryIcon, MessageSquareIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeFile, DocDiff } from "@/components/code/Code";
import { Markdown } from "@/components/md/Markdown";
import { Avatar, Name, NativeBadge, Stats } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, roomPath, Unauthorized } from "@/lib/api";
import { ago, ext, fullDate, plural, PROSE_EXT } from "@/lib/format";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { DocNow, DocRevision, DocRevisionView, RoomState } from "@/lib/types";
import { cn } from "@/lib/utils";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const revAuthor = (room: RoomState, r: DocRevision) => (r.by === "agoryx" ? "Початкова версія" : participant(room, r.by).label);

const revWhere = (room: RoomState, r: DocRevision) => {
  if (r.by === "agoryx") return "з неї кімната почала";
  const who = participant(room, r.by);
  if (r.turnId) return "хід у кімнаті";
  if (r.native && who.agent) return "у своїй сесії";
  return who.agent ? "поза ходом" : "редактор або ця сторінка";
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

const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-[13.5px] text-muted-foreground">{children}</p>;

function Loading() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function NoDoc() {
  const post = useStore((s) => s.post);
  const driven = useStore((s) => s.snap?.driven);
  const [path, setPath] = useState("README.md");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-secondary text-primary">
        <FileTextIcon className="size-5" />
      </span>
      <h3 className="text-[17px] font-semibold">Спільний документ</h3>
      <p className="max-w-[44ch] text-[14px] leading-relaxed text-pretty text-muted-foreground">
        Кімната може писати один спільний текст — рішення, есе, специфікацію. Agoryx не каже, що в ньому має бути: лише пам'ятає кожну версію з автором і показує
        кожному агенту, що змінили інші.
      </p>
      {driven ? (
        <form
          className="flex w-full max-w-sm gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await post("/settings", { doc: path.trim() || null });
              toast.success("Документ призначено");
            } catch (error) {
              if (!(error instanceof Unauthorized)) toast.error(errText(error));
              setBusy(false);
            }
          }}
        >
          <Input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} aria-label="Файл у робочій теці" className="font-mono text-[13px]" />
          <Button type="submit" disabled={busy || !path.trim()}>
            Призначити
          </Button>
        </form>
      ) : null}
    </div>
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
    setView("now");
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
      setDoc({ path: saved.path, text: saved.text, hash: saved.hash, exists: saved.exists });
      setView("now");
      toast.success(saved.revision ? "Збережено — агенти побачать диф" : "Без змін");
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
          <span className="font-mono text-[12.5px]">{path}</span>
          <span className="text-xs text-faint">редагування</span>
        </Bar>
        {edit.conflict !== undefined ? (
          <div className="mb-3 flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive-soft px-3.5 py-3 text-[13px] text-destructive">
            <span className="flex items-center gap-2 font-medium">
              <TriangleAlertIcon className="size-4" />
              Поки ви редагували, файл змінився. Ваш текст нікуди не дівся.
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
                Відкинути мою правку
              </Button>
              <Button type="button" size="sm" variant="destructive" disabled={saving} onClick={() => void save(true)}>
                Зберегти мою поверх
              </Button>
            </div>
          </div>
        ) : stale ? (
          <div className="mb-3 rounded-xl bg-amber-soft px-3.5 py-2.5 text-[13px] text-amber">
            Тим часом файл змінено ({participant(room, stale).label}). Збереження нічого не перезапише мовчки — спершу покажемо конфлікт.
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
          className="scroll-thin min-h-[320px] w-full flex-1 resize-none rounded-xl border border-input bg-paper p-4 font-mono text-[13px] leading-relaxed outline-none focus:border-ring/60 focus:ring-3 focus:ring-ring/15"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">Правка не будить агентів — вони побачать диф у своєму наступному ході.</span>
          <Button type="button" variant="ghost" className="ml-auto" onClick={() => setEdit(null)}>
            Скасувати
          </Button>
          <Button type="submit" disabled={saving}>
            Зберегти
          </Button>
        </div>
      </form>
    );
  }

  // --- one revision ----------------------------------------------------------
  if (typeof view === "number") {
    const r = list.find((x) => x.seq === view);
    const rev = revs.get(view);
    let body: React.ReactNode = <Loading />;
    if (rev && "error" in rev) body = <div className="rounded-xl bg-destructive-soft px-3.5 py-3 text-[13px] text-destructive">{rev.error}</div>;
    else if (rev) {
      if (rev.truncated) body = <Muted>Ця версія завелика (понад 256 КБ), тому Agoryx зберіг лише її відбиток і статистику.</Muted>;
      else if (rev.previous == null && rev.text != null) body = <DocBody path={path} text={rev.text} />;
      else if (rev.text === null) body = <Muted>У цій версії файл видалено.</Muted>;
      else body = rev.diff?.some((i) => "t" in i && i.t !== " ") ? <DocDiff items={rev.diff} /> : <Muted>Текст не змінився.</Muted>;
    }
    const message = r?.turnId ? room.messages.find((m) => m.turnId === r.turnId) : undefined;
    return (
      <div className="px-4 pb-6">
        <Bar>
          <Button size="sm" variant="ghost" className="-ml-2 h-7" onClick={() => setView("history")}>
            <ArrowLeftIcon className="size-3.5" />
            Історія
          </Button>
          {r ? (
            <>
              <Avatar handle={r.by} size={20} />
              <b className="text-[13px]">{revAuthor(room, r)}</b>
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
              Хід у розмові
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
            Текст
          </Button>
          <span className="text-xs text-muted-foreground">
            {plural(list.length, "версія", "версії", "версій")} <span className="font-mono">{path}</span>
          </span>
        </Bar>
        <p className="mb-4 text-[12.5px] leading-relaxed text-muted-foreground">
          Хто б і де б не змінив файл — хід у кімнаті, власна сесія агента чи ваш редактор, — версія лишається тут з автором, а інші бачать диф у своєму
          наступному ході.
        </p>
        {list.length ? (
          <ol className="relative flex flex-col before:absolute before:top-3 before:bottom-3 before:left-[22px] before:w-px before:bg-border">
            {[...list].reverse().map((r) => {
              const who = participant(room, r.by);
              return (
                <li key={r.seq}>
                  <button type="button" onClick={() => setView(r.seq)} className="relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-accent">
                    <Avatar handle={r.by} size={24} className="ring-4 ring-background" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2 text-[13.5px] font-medium">
                        {revAuthor(room, r)}
                        {r.native && who.agent ? <NativeBadge agent={r.by} label="у своїй сесії" tip={`Змінено в рідній сесії ${who.label}, поза ходом у кімнаті.`} /> : null}
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
          <Muted>Версій ще немає.</Muted>
        )}
      </div>
    );
  }

  // --- current text ----------------------------------------------------------
  if (!doc || ("path" in doc && doc.path !== path)) return <Loading />;
  if ("error" in doc) return <div className="m-4 rounded-xl bg-destructive-soft px-3.5 py-3 text-[13px] text-destructive">{doc.error}</div>;
  const last = list.at(-1);
  return (
    <div className="px-4 pb-6">
      <Bar>
        <FileTextIcon className="size-4 text-primary" />
        <span className="truncate font-mono text-[12.5px]" title="Спільний документ кімнати">
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
              Історія · {list.length}
            </Button>
          ) : null}
          {driven ? (
            <Button size="sm" variant="outline" className="h-7" onClick={() => setEdit({ base: doc.hash, text: doc.text, startTick: docTick })}>
              <PencilIcon className="size-3.5" />
              {doc.exists ? "Редагувати" : "Почати"}
            </Button>
          ) : null}
        </span>
      </Bar>
      {doc.exists ? (
        doc.text.trim() ? (
          <DocBody path={path} text={doc.text} />
        ) : (
          <Muted>Файл порожній.</Muted>
        )
      ) : (
        <div className={cn("rounded-2xl border border-dashed border-border px-6 py-8 text-center text-[13.5px] text-muted-foreground")}>
          Файлу <code className="font-mono">{path}</code> ще немає. Агенти створять його, коли буде що записати, — або почніть ви.
        </div>
      )}
    </div>
  );
}
