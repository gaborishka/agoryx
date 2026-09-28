import { CopyIcon, ExternalLinkIcon, FileIcon, FolderOpenIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CodeFile, Patch } from "@/components/code/Code";
import { LiveFrame } from "@/components/md/LiveFrame";
import { Markdown, MermaidFile, rawUrl } from "@/components/md/Markdown";
import { DataTable, Player } from "@/components/md/Media";
import { Avatar, Stats } from "@/components/room/bits";
import { RefChip } from "@/components/table/OpCard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, roomPath, Unauthorized } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { AUDIO_EXT, baseName, DIAGRAM_EXT, ext, FRAME_EXT, fullDate, IMAGE_EXT, kb, TABLE_EXT, VIDEO_EXT } from "@/lib/format";
import { participant } from "@/lib/room";
import { type DialogState, type TableFormOp, useStore } from "@/lib/store";
import type { FileChange } from "@/lib/types";
import { cn } from "@/lib/utils";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const fail = (error: unknown) => {
  if (!(error instanceof Unauthorized)) toast.error(errText(error));
};

/** Fetch once per key; returns [data, error]. */
function useLoad<T>(key: string | null, fetcher: () => Promise<T>) {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string }>({ key: null });
  useEffect(() => {
    if (!key) return;
    let live = true;
    setState({ key });
    fetcher()
      .then((data) => live && setState({ key, data }))
      .catch((error) => live && !(error instanceof Unauthorized) && setState({ key, error: errText(error) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { key };
}

const Loading = () => (
  <div className="flex flex-col gap-2.5 py-2">
    <Skeleton className="h-4 w-1/3" />
    <Skeleton className="h-40 w-full" />
  </div>
);
const Err = ({ children }: { children: ReactNode }) => <div className="rounded-xl bg-destructive-soft px-3.5 py-3 text-[13px] text-destructive">{children}</div>;
const Faint = ({ children, className }: { children: ReactNode; className?: string }) => <p className={cn("text-[12.5px] leading-relaxed text-muted-foreground", className)}>{children}</p>;

function Shell({ title, sub, size = "md", children }: { title: ReactNode; sub?: ReactNode; size?: "sm" | "md" | "lg"; children: ReactNode }) {
  const openDialog = useStore((s) => s.openDialog);
  return (
    <Dialog open onOpenChange={(open) => !open && openDialog(null)}>
      <DialogContent
        className={cn(
          "flex max-h-[min(88vh,960px)] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-lift",
          size === "sm" && "sm:max-w-md",
          size === "md" && "sm:max-w-2xl",
          size === "lg" && "sm:max-w-[min(1100px,94vw)]",
        )}
      >
        <DialogHeader className="shrink-0 gap-0.5 border-b border-border px-5 pt-4 pb-3.5 pr-12 text-left">
          <DialogTitle className="truncate text-[16px]">{title}</DialogTitle>
          <DialogDescription className={cn("truncate font-mono text-[11.5px]", !sub && "sr-only")}>{sub || title}</DialogDescription>
        </DialogHeader>
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 *:shrink-0">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

// --- a file in the workspace --------------------------------------------------

type FileView = { path: string; text: string; size: number; mtime: string; binary: boolean; truncated: boolean };

function FileDialog({ path }: { path: string }) {
  const roomId = useStore((s) => s.snap?.state.id ?? "");
  const rawBase = useStore((s) => s.snap?.rawBase ?? "");
  const kind = ext(path);
  const url = rawUrl(rawBase, path);
  const image = IMAGE_EXT.has(kind) && kind !== "svg";
  const media = VIDEO_EXT.has(kind) || AUDIO_EXT.has(kind);
  const file = useLoad(image || media ? null : `${roomId}:${path}`, () => api<FileView>("GET", `${roomPath(roomId, "/file")}?path=${encodeURIComponent(path)}`));
  const open = (
    <Button asChild variant="outline" size="sm" className="w-fit">
      <a href={url} target="_blank" rel="noopener noreferrer">
        <ExternalLinkIcon className="size-3.5" />
        Відкрити в новій вкладці
      </a>
    </Button>
  );
  let body: ReactNode = <Loading />;
  if (image) {
    body = (
      <>
        <div className="grid place-items-center rounded-xl border border-border bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-[length:16px_16px] p-3">
          <img src={url} alt={path} className="max-h-[70vh] max-w-full object-contain" />
        </div>
        {open}
      </>
    );
  } else if (media) {
    body = (
      <>
        <div className="grid place-items-center">
          <Player url={url} kind={VIDEO_EXT.has(kind) ? "video" : "audio"} title={path} className={VIDEO_EXT.has(kind) ? "max-h-[70vh]" : undefined} />
        </div>
        {open}
      </>
    );
  } else if (file.error) body = <Err>{file.error}</Err>;
  else if (file.data) {
    const f = file.data;
    const meta = (
      <Faint className="tabular">
        {kb(f.size)} · змінено {fullDate(f.mtime)}
        {f.truncated ? " · показано початок" : ""}
      </Faint>
    );
    if (FRAME_EXT.has(kind) || kind === "svg") {
      body = (
        <>
          {meta}
          <div className="overflow-hidden rounded-xl border border-border bg-white">
            <LiveFrame src={url} title={path} initial={520} max={1600} />
          </div>
          {open}
          {!f.binary ? (
            <details className="group">
              <summary className="cursor-pointer text-[13px] text-muted-foreground select-none hover:text-foreground">Код</summary>
              <CodeFile name={path} text={f.text} className="mt-2" />
            </details>
          ) : null}
        </>
      );
    } else if ((TABLE_EXT.has(kind) || DIAGRAM_EXT.has(kind)) && !f.binary) {
      body = (
        <>
          {meta}
          {TABLE_EXT.has(kind) ? (
            <DataTable text={f.text} sep={kind === "tsv" ? "\t" : ","} cut={f.truncated} limit={1000} />
          ) : (
            <div className="rounded-xl border border-border bg-paper p-3">
              <MermaidFile url={url} />
            </div>
          )}
          {open}
          <details>
            <summary className="cursor-pointer text-[13px] text-muted-foreground select-none hover:text-foreground">Сирий текст</summary>
            <CodeFile name={path} text={f.text} className="mt-2" />
          </details>
        </>
      );
    } else if (f.binary) {
      body = (
        <>
          {meta}
          <Faint>Двійковий файл — попередній перегляд недоступний.</Faint>
          {open}
        </>
      );
    } else if (kind === "md" || kind === "markdown") {
      body = (
        <>
          {meta}
          <article className="rounded-xl border border-border bg-paper px-6 py-5">
            <Markdown text={f.text} variant="doc" />
          </article>
          <details>
            <summary className="cursor-pointer text-[13px] text-muted-foreground select-none hover:text-foreground">Сирий текст</summary>
            <CodeFile name={path} text={f.text} className="mt-2" />
          </details>
        </>
      );
    } else {
      body = (
        <>
          {meta}
          <CodeFile name={path} text={f.text} />
        </>
      );
    }
  }
  return (
    <Shell title={baseName(path)} sub={path} size="lg">
      {body}
    </Shell>
  );
}

// --- what one turn changed ------------------------------------------------------

function TurnDiffDialog({ turnId, path }: { turnId: string; path?: string }) {
  const room = useStore((s) => s.snap?.state);
  const openDialog = useStore((s) => s.openDialog);
  const roomId = room?.id ?? "";
  const turn = room?.turns.find((t) => t.id === turnId);
  const diff = useLoad(`${roomId}:${turnId}`, () =>
    api<{ changes: FileChange[]; patch: string; truncated: boolean }>("GET", `${roomPath(roomId, "/turn-diff")}?turn=${encodeURIComponent(turnId)}`),
  );
  const [only, setOnly] = useState<string | undefined>(path);
  useEffect(() => setOnly(path), [path]);
  const who = turn ? participant(room, turn.agent).label : "";
  let body: ReactNode = <Loading />;
  if (diff.error) body = <Err>{diff.error}</Err>;
  else if (diff.data) {
    const { changes, patch, truncated } = diff.data;
    const narrowed = only && changes.length > 1 ? only : undefined;
    const shown = narrowed
      ? (patch.split(/(?=^diff --git )/m).find((part) => {
          const first = part.split("\n", 1)[0] ?? "";
          return first.endsWith(` b/${narrowed}`) || first.includes(` a/${narrowed} `);
        }) ?? patch)
      : patch;
    body = (
      <>
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
          {changes.map((c) => (
            <div key={c.path} className={cn("flex items-center gap-2 px-3 py-1.5 text-[12.5px]", narrowed === c.path && "bg-secondary/60")}>
              <button type="button" className="min-w-0 flex-1 truncate text-left font-mono hover:underline" title="Показати лише цей файл" onClick={() => setOnly(c.path)}>
                {c.path}
              </button>
              <Stats added={c.added} removed={c.removed} deleted={c.status === "D"} binary={c.added === null} isNew={c.status === "A"} />
              {c.status !== "D" ? (
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => openDialog({ kind: "file", path: c.path })}>
                  файл
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {narrowed ? (
          <Faint>
            Лише <span className="font-mono">{narrowed}</span> ·{" "}
            <button type="button" className="text-primary hover:underline" onClick={() => setOnly(undefined)}>
              усі файли ходу
            </button>
          </Faint>
        ) : null}
        {truncated ? (
          <Faint>
            Патч великий — показано початок. Повністю: <code className="font-mono">agoryx diff {turnId}</code>
          </Faint>
        ) : null}
        <Patch patch={shown} />
        <Faint>
          Точно те, що цей хід змінив у робочій теці: знімок git до і після ходу. Інші агенти бачать ці +/− у своїй дельті й можуть узяти патч командою{" "}
          <code className="font-mono">agoryx diff {turnId}</code>.
        </Faint>
      </>
    );
  }
  return (
    <Shell
      title={
        <span className="flex items-center gap-2">
          {turn ? <Avatar handle={turn.agent} size={22} /> : null}
          Що змінив хід {who ? `${who} ` : ""}
          <span className="font-mono text-[13px] text-muted-foreground">{turnId}</span>
        </span>
      }
      sub={turn?.endedAt ? fullDate(turn.endedAt) : undefined}
      size="lg"
    >
      {body}
    </Shell>
  );
}

// --- a checkpoint commit ----------------------------------------------------------

function CommitDialog({ sha }: { sha: string }) {
  const roomId = useStore((s) => s.snap?.state.id ?? "");
  const commit = useLoad(`${roomId}:${sha}`, () => api<{ sha: string; text: string }>("GET", `${roomPath(roomId, "/commit")}?sha=${encodeURIComponent(sha)}`));
  let body: ReactNode = <Loading />;
  if (commit.error) body = <Err>{commit.error}</Err>;
  else if (commit.data) {
    const text = commit.data.text;
    const at = text.search(/^diff --git /m);
    const head = at < 0 ? text : text.slice(0, at);
    const patch = at < 0 ? "" : text.slice(at);
    body = (
      <>
        <pre className="scroll-thin overflow-x-auto rounded-xl border border-border bg-muted/50 px-3.5 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{head.trim()}</pre>
        {patch ? <Patch patch={patch} /> : null}
      </>
    );
  }
  return (
    <Shell title={`Контрольна точка ${sha.slice(0, 7)}`} sub="git show" size="lg">
      {body}
    </Shell>
  );
}

// --- the workspace -----------------------------------------------------------------

function FilesDialog() {
  const room = useStore((s) => s.snap?.state);
  const openDialog = useStore((s) => s.openDialog);
  const roomId = room?.id ?? "";
  const tree = useLoad(`${roomId}:tree`, () => api<{ files: string[] }>("GET", roomPath(roomId, "/tree")));
  const [q, setQ] = useState("");
  let body: ReactNode = <Loading />;
  if (tree.error) body = <Err>{tree.error}</Err>;
  else if (tree.data) {
    const files = tree.data.files.filter((f) => !q || f.toLowerCase().includes(q.toLowerCase()));
    body = tree.data.files.length ? (
      <>
        {tree.data.files.length > 12 ? <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Знайти файл…" className="h-8" autoFocus /> : null}
        <div className="flex flex-col">
          {files.map((f) => (
            <button key={f} type="button" onClick={() => openDialog({ kind: "file", path: f })} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent">
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-[12.5px]">
                <span className="text-muted-foreground">{f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : ""}</span>
                {baseName(f)}
              </span>
            </button>
          ))}
        </div>
      </>
    ) : (
      <Faint>Поки що порожньо — агенти ще нічого не створили.</Faint>
    );
  }
  return (
    <Shell
      title={
        <span className="flex items-center gap-2">
          <FolderOpenIcon className="size-4.5 text-primary" />
          Робоча тека
        </span>
      }
      sub={room?.workspace}
    >
      <Faint>Спільна git-тека кімнати. Агенти читають і пишуть тут (у пісочниці).</Faint>
      {body}
    </Shell>
  );
}

// --- agent sessions -------------------------------------------------------------------

function SessionsDialog() {
  const snap = useStore((s) => s.snap);
  if (!snap) return null;
  const st = snap.state;
  return (
    <Shell title="Сесії агентів">
      <Faint className="text-[13.5px]">
        Agoryx не перепаковує агентів: кожен працює у своїй справжній сесії, і розмова в кімнаті — це їхні ходи в цих сесіях. Відкрийте сесію в терміналі, щоб
        побачити все, що агент робив, або поговорити сам-на-сам — кімната це теж побачить.
      </Faint>
      {st.agents.map((a) => {
        const session = st.sessions[a.id];
        const command = snap.resume?.[a.id];
        return (
          <div key={a.id} className="flex items-start gap-3 rounded-xl border border-border bg-card p-3.5">
            <Avatar handle={a.id} size={34} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <b className="text-[14.5px]">{a.label}</b>
                {a.model ? <span className="font-mono text-[11px] text-faint">{a.model}</span> : null}
              </div>
              <span className="truncate text-xs text-muted-foreground">
                {session ? (
                  <>
                    сесія <span className="font-mono">{session.sessionId}</span>
                  </>
                ) : (
                  "Ще не говорив у кімнаті — сесія з'явиться після першого ходу"
                )}
              </span>
              {command ? <CopyLine text={command} /> : null}
            </div>
          </div>
        );
      })}
      <Faint>
        Уся кімната в терміналі: <code className="font-mono">agoryx tail -f</code> · <code className="font-mono">agoryx say "…"</code> ·{" "}
        <code className="font-mono">agoryx table</code>
      </Faint>
    </Shell>
  );
}

function CopyLine({ text }: { text: string }) {
  const code = useRef<HTMLElement>(null);
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-code py-1 pr-1 pl-2.5">
      <code ref={code} className="scroll-thin min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-nowrap">
        {text}
      </code>
      <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Копіювати" title="Копіювати" onClick={() => void copyText(text, code.current)}>
        <CopyIcon className="size-3.5" />
      </Button>
    </div>
  );
}

// --- room settings -----------------------------------------------------------------------

function SettingsDialog() {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const s = room?.settings;
  const [budget, setBudget] = useState(String(s?.budget ?? 8));
  const [access, setAccess] = useState<string>(s?.access ?? "workspace");
  const [network, setNetwork] = useState(s?.network ?? true);
  const [autoCommit, setAutoCommit] = useState(s?.autoCommit ?? true);
  const [doc, setDoc] = useState(s?.doc ?? "");
  const [busy, setBusy] = useState(false);
  if (!room || !s) return null;
  return (
    <Shell title="Налаштування кімнати" sub={room.name} size="sm">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await post("/settings", {
              budget: Math.max(1, Number.parseInt(budget, 10) || s.budget),
              access,
              network,
              autoCommit,
              doc: doc.trim() || null,
            });
            openDialog(null);
            toast.success("Збережено");
          } catch (error) {
            fail(error);
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-budget">Ходів агентів на ваше повідомлення</Label>
          <Input id="s-budget" type="number" min={1} max={100} value={budget} onChange={(e) => setBudget(e.target.value)} className="w-28" />
          <Faint>Скільки ходів агенти роблять після вашого повідомлення, перш ніж зупинитися й чекати на вас.</Faint>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Доступ агентів</Label>
          <Select value={access} onValueChange={setAccess}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="workspace">Читання і запис у робочій теці</SelectItem>
              <SelectItem value="readonly">Лише читання</SelectItem>
            </SelectContent>
          </Select>
          <Faint>Агенти завжди працюють у пісочниці; поза робочою текою писати не можуть.</Faint>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          Мережа для команд агентів
          <Switch checked={network} onCheckedChange={setNetwork} />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          Контрольна точка (git commit) після кожного раунду
          <Switch checked={autoCommit} onCheckedChange={setAutoCommit} />
        </label>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-doc">Спільний документ</Label>
          <Input id="s-doc" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="README.md" spellCheck={false} className="font-mono text-[13px]" />
          <Faint>Файл, який кімната пише разом. Порожньо — без нього.</Faint>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => openDialog(null)}>
            Скасувати
          </Button>
          <Button type="submit" disabled={busy}>
            Зберегти
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

// --- help -------------------------------------------------------------------------------------

function HelpDialog() {
  const at = (who: "claude" | "codex") => (
    <span className={cn("rounded-md px-1.5 py-0.5 font-mono text-[12.5px]", who === "claude" ? "bg-claude-soft text-claude" : "bg-codex-soft text-codex")}>@{who}</span>
  );
  const li = "relative pl-5 before:absolute before:top-[0.6em] before:left-1 before:size-1.5 before:rounded-full before:bg-primary/50";
  return (
    <Shell title="Як це працює">
      <div className="flex flex-col gap-3.5 text-[14.5px] leading-relaxed">
        <p>
          <b>Кімната</b> — одна розмова для вас, Claude і Codex. Agoryx задає контекст, а не ролі: агенти працюють у своїх рідних сесіях з усіма своїми
          інструментами.
        </p>
        <ul className="flex flex-col gap-2">
          <li className={li}>
            На ваше повідомлення агенти відповідають <b>незалежно</b> — одночасно, не бачачи одне одного.
          </li>
          <li className={li}>
            Далі вони говорять <b>по черзі</b>: кожен бачить усе, що сказано раніше. Коли нема що додати — хід пропускається.
          </li>
          <li className={li}>Після кількох ходів розмова зупиняється й чекає на вас. Кількість — у налаштуваннях кімнати.</li>
          <li className={li}>
            {at("claude")} чи {at("codex")} — звернутися лише до одного.
          </li>
          <li className={li}>
            <b>Стіл</b> — питання, варіанти, заперечення й рішення, коли є справжні альтернативи.
          </li>
          <li className={li}>
            <b>Документ</b> — один спільний файл, кожна версія з автором.
          </li>
        </ul>
        <Faint className="text-[13px]">
          Без браузера: <code className="font-mono">agoryx tail -f</code>, <code className="font-mono">agoryx say "…"</code>, <code className="font-mono">agoryx table</code>.
          Сесію агента можна відкрити в Claude Code чи Codex — розмова там теж потрапить у кімнату. <kbd className="font-mono">⌘K</kbd> — усі дії.
        </Faint>
      </div>
    </Shell>
  );
}

// --- table forms --------------------------------------------------------------------------------

type Field = { name: string; label: string; area?: boolean; placeholder?: string; required?: boolean };
const FORMS: Record<TableFormOp, { title: string; fields: Field[] }> = {
  ask: { title: "Нове питання", fields: [{ name: "text", label: "Питання", area: true, placeholder: "Що треба вирішити?", required: true }] },
  propose: {
    title: "Нова пропозиція",
    fields: [
      { name: "title", label: "Коротка назва", placeholder: "напр. SQLite замість JSON", required: true },
      { name: "body", label: "Що і чому", area: true },
      { name: "file", label: "Файл у робочій теці (необов'язково)", placeholder: "mockup.html" },
    ],
  },
  object: { title: "Заперечення", fields: [{ name: "text", label: "Чому ні", area: true, placeholder: "Що саме не так і що змінило б цю думку?", required: true }] },
  support: { title: "Підтримка", fields: [{ name: "text", label: "Чому так", area: true, required: true }] },
  evidence: {
    title: "Доказ",
    fields: [
      { name: "text", label: "Що встановлено", area: true, required: true },
      { name: "source", label: "Джерело (URL або файл)" },
    ],
  },
  decide: { title: "Обрати", fields: [{ name: "note", label: "Чому саме цей варіант (необов'язково)", area: true }] },
  settle: { title: "Висновок", fields: [{ name: "text", label: "Що тепер вважаємо встановленим", area: true, required: true }] },
  next: { title: "Наступний крок", fields: [{ name: "text", label: "Конкретна дія", area: true, required: true }] },
};

function TableFormDialog({ op, target, q }: { op: TableFormOp; target?: string; q?: string }) {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const [values, setValues] = useState<Record<string, string>>({ q: q ?? "" });
  const [busy, setBusy] = useState(false);
  if (!room) return null;
  const form = FORMS[op];
  const option = target ? room.table.options.find((o) => o.id === target) : undefined;
  const open = room.table.questions.filter((x) => x.status === "open");
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  const submit = async () => {
    const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, x.trim()]));
    let body: Record<string, unknown> = { op };
    if (op === "propose") body = { op, title: v.title, ...(v.body ? { body: v.body } : {}), ...(v.file ? { file: v.file } : {}), ...(v.q ? { q: v.q } : {}) };
    else if (op === "decide") body = { op, target, ...(v.note ? { note: v.note } : {}) };
    else if (op === "object" || op === "support" || op === "evidence") body = { op, target, text: v.text, ...(v.source ? { source: v.source } : {}) };
    else if (op === "settle") body = { op, text: v.text, ...(v.q ? { q: v.q } : {}) };
    else body = { op, text: v.text };
    setBusy(true);
    try {
      await post("/table", body);
      openDialog(null);
    } catch (error) {
      fail(error);
      setBusy(false);
    }
  };
  const missing = form.fields.some((f) => f.required && !values[f.name]?.trim());
  return (
    <Shell title={op === "decide" ? `Обрати ${target}` : form.title} size="sm">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {option ? (
          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2.5">
            <RefChip id={option.id} className="mt-0.5" />
            <div className="min-w-0">
              <b className="text-[13.5px] leading-snug">{option.title}</b>
              <div className="text-[11.5px] text-muted-foreground">{participant(room, option.by).label}</div>
            </div>
          </div>
        ) : null}
        {form.fields.map((f, index) => (
          <div key={f.name} className="flex flex-col gap-1.5">
            <Label htmlFor={`tf-${f.name}`}>{f.label}</Label>
            {f.area ? (
              <Textarea
                id={`tf-${f.name}`}
                autoFocus={index === 0}
                value={values[f.name] ?? ""}
                onChange={(e) => set(f.name, e.target.value)}
                placeholder={f.placeholder}
                className="min-h-24"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !missing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            ) : (
              <Input id={`tf-${f.name}`} autoFocus={index === 0} value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />
            )}
          </div>
        ))}
        {(op === "propose" || op === "settle") && open.length ? (
          <div className="flex flex-col gap-1.5">
            <Label>{op === "settle" ? "Відповідає на питання (і закриває його)" : "До питання"}</Label>
            <Select value={values.q || "none"} onValueChange={(v) => set("q", v === "none" ? "" : v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{op === "settle" ? "— просто узгоджено —" : "— без питання —"}</SelectItem>
                {open.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.id} · {x.text.slice(0, 70)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Faint>{op === "decide" ? "Рішення з'явиться в розмові, і агенти продовжать із нього." : "Агенти побачать це у своєму наступному ході."}</Faint>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => openDialog(null)}>
            Скасувати
          </Button>
          <Button type="submit" disabled={busy || missing}>
            {op === "decide" ? `Обрати ${target}` : "Покласти на стіл"}
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

const render = (d: DialogState) => {
  switch (d.kind) {
    case "file":
      return <FileDialog key={d.path} path={d.path} />;
    case "turn-diff":
      return <TurnDiffDialog turnId={d.turnId} path={d.path} />;
    case "commit":
      return <CommitDialog sha={d.sha} />;
    case "files":
      return <FilesDialog />;
    case "sessions":
      return <SessionsDialog />;
    case "settings":
      return <SettingsDialog />;
    case "help":
      return <HelpDialog />;
    case "table-form":
      return <TableFormDialog key={`${d.op}:${d.target ?? ""}`} op={d.op} target={d.target} q={d.q} />;
  }
};

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const snap = useStore((s) => Boolean(s.snap));
  if (!dialog) return null;
  if (dialog.kind !== "help" && !snap) return null;
  return render(dialog);
}

