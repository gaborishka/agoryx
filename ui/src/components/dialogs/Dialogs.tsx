import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Hint, Loading } from "@/components/common/states";
import { Stats } from "@/components/room/bits";
import { RefChip } from "@/components/table/OpCard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, roomPath, Unauthorized } from "@/lib/api";
import { keyLabel, SHORTCUTS, withMod } from "@/lib/keys";
import { names, plural } from "@/lib/format";
import { errText, useLoad } from "@/lib/load";
import { DEFAULT_AGENTS, ink, participant } from "@/lib/room";
import { type DialogState, type TableFormOp, useStore } from "@/lib/store";
import type { FileChange, RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const fail = (error: unknown) => {
  if (!(error instanceof Unauthorized)) toast.error(errText(error));
};

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
          <DialogTitle className="truncate text-lead">{title}</DialogTitle>
          <DialogDescription className={cn("truncate font-mono text-meta", !sub && "sr-only")}>{sub || title}</DialogDescription>
        </DialogHeader>
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 *:shrink-0">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

// --- returning the folder to a checkpoint --------------------------------------------

type RevertPlan = { to: string; undoOf?: number; subject: string; tree: string; changes: FileChange[]; since?: string[]; busy: string | null };

/** The daemon's refusals by code, in the room's words (its own text is for the CLI). */
const REVERT_ERRORS: Record<string, string> = {
  bad: "Такої контрольної точки в кімнаті немає.",
  agent: "Повернути теку може лише людина.",
  missing: "Цієї контрольної точки вже немає в репозиторії теки.",
  undone: "Це повернення вже скасовано.",
  later: "Скасувати можна лише останнє повернення.",
  busy: "Агенти зараз працюють у теці. Спершу зупиніть їх.",
  changed: "Тека змінилася, поки ви дивилися. Ось що зміниться тепер.",
  same: "Тека вже така — змінювати нічого.",
  failed: "git не зміг прочитати або записати теку, тож нічого не змінено.",
};
const revertError = (error: unknown) => {
  const code = error instanceof ApiError ? error.body.code : undefined;
  return typeof code === "string" && REVERT_ERRORS[code] ? REVERT_ERRORS[code] : errText(error);
};

const REVERT_HOW: Record<string, { text: string; className: string }> = {
  A: { text: "повернеться", className: "text-add-ink" },
  D: { text: "зникне", className: "text-del-ink" },
};

function RevertDialog({ sha, undo }: { sha?: string; undo?: number }) {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const roomId = room?.id ?? "";
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const query = undo !== undefined ? `undo=${undo}` : sha ? `sha=${encodeURIComponent(sha)}` : null;
  const plan = useLoad(query ? `${roomId}:${query}:${nonce}` : null, () =>
    api<RevertPlan>("GET", `${roomPath(roomId, "/revert")}?${query}`).catch((error: unknown) => {
      throw error instanceof Unauthorized ? error : new Error(revertError(error));
    }),
  );
  if (!query) return <CheckpointsDialog />;
  const again = () => setNonce((n) => n + 1);
  const stop = async () => {
    setBusy(true);
    try {
      await post("/stop");
      again();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    if (!plan.data) return;
    setBusy(true);
    try {
      await post("/revert", { ...(undo !== undefined ? { undo } : { sha: plan.data.to }), tree: plan.data.tree });
      toast.success(undo !== undefined ? "Повернення скасовано" : "Теку повернуто");
      openDialog(null);
    } catch (error) {
      const code = error instanceof ApiError ? error.body.code : undefined;
      if (!(error instanceof Unauthorized)) toast.error(revertError(error));
      // The folder or the room moved on: show what is true now.
      if (code === "changed" || code === "busy" || code === "same") again();
    } finally {
      setBusy(false);
    }
  };
  let body: ReactNode = <Loading />;
  if (plan.error) body = <ErrorNote>{plan.error}</ErrorNote>;
  else if (plan.data) {
    const { changes, subject } = plan.data;
    body = (
      <>
        {undo !== undefined ? (
          <Hint>Файли стануть такими, якими були перед цим поверненням.</Hint>
        ) : (
          <Hint>
            Тека стане такою, як у контрольній точці <span className="font-mono text-foreground">{plan.data.to.slice(0, 7)}</span>: {subject}
          </Hint>
        )}
        {plan.data.busy ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-destructive-soft px-3.5 py-3 text-small text-destructive">
            <span className="flex-1">Агенти зараз працюють у теці. Щоб повернути її, спершу зупиніть їх.</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={stop}>
              Зупинити агентів
            </Button>
          </div>
        ) : null}
        {plan.data.since?.length ? (
          <div className="rounded-xl bg-destructive-soft px-3.5 py-3 text-small text-destructive">
            Після повернення в теці ще змінювалися файли — ці зміни теж зникнуть: <span className="font-mono">{plan.data.since.slice(0, 12).join(", ")}</span>
            {plan.data.since.length > 12 ? ` і ще ${plan.data.since.length - 12}` : ""}.
          </div>
        ) : null}
        {changes.length ? (
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {changes.map((c) => {
              const how = REVERT_HOW[c.status] ?? { text: "зміниться", className: "text-foreground" };
              return (
                <div key={c.path} className="flex items-center gap-2 px-3 py-1.5 text-meta">
                  <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
                  <Stats added={c.added} removed={c.removed} binary={c.added === null} />
                  <span className={cn("w-20 text-right", how.className)}>{how.text}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <Hint>Тека вже така — змінювати нічого.</Hint>
        )}
        <Hint>
          Спершу Agoryx збереже теку як є, тож це можна буде скасувати. Розмова і стіл лишаються; агенти дізнаються про це в наступному ході. Файли з .gitignore не
          змінюються.
        </Hint>
      </>
    );
  }
  const count = plan.data?.changes.length ?? 0;
  return (
    <Shell title={undo !== undefined ? "Скасувати повернення" : "Повернути теку сюди"} sub={room?.workspace} size="md">
      {body}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => openDialog(null)}>
          Скасувати
        </Button>
        <Button type="button" variant="destructive" disabled={busy || !count || Boolean(plan.data?.busy)} onClick={go}>
          {undo !== undefined ? "Скасувати повернення" : `Повернути ${count ? plural(count, "файл", "файли", "файлів") : "теку"}`}
        </Button>
      </DialogFooter>
    </Shell>
  );
}

/** No checkpoint picked: the room's checkpoints to pick from, or how to get them. */
function CheckpointsDialog() {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const roomId = room?.id ?? "";
  const commits = [...(room?.commits ?? [])].reverse();
  const status = useLoad(commits.length ? null : `${roomId}:revert-status`, () => api<{ tracking: "git" | "shadow" | "none" }>("GET", roomPath(roomId, "/revert")));
  const turnOn = async () => {
    try {
      await post("/settings", { autoCommit: true });
      toast.success("Контрольні точки ввімкнено");
    } catch (error) {
      fail(error);
    }
  };
  let body: ReactNode;
  if (commits.length) {
    body = (
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        {commits.map((c) => (
          <div key={c.sha} className="flex items-center gap-2 px-3 py-1.5 text-meta">
            <span className="font-mono text-muted-foreground">{c.sha.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate">{c.subject}</span>
            <Button variant="ghost" size="xs" onClick={() => openDialog({ kind: "revert", sha: c.sha })}>
              Повернути сюди
            </Button>
          </div>
        ))}
      </div>
    );
  } else if (status.error) body = <ErrorNote>{status.error}</ErrorNote>;
  else if (!status.data) body = <Loading />;
  else if (status.data.tracking !== "git") {
    body = (
      <Hint>
        Контрольна точка — це git commit, а ця тека не git-репозиторій, тож кімната їх не робить. Зробіть у теці <code className="font-mono">git init</code> і ввімкніть
        контрольні точки в налаштуваннях кімнати.
      </Hint>
    );
  } else if (!room?.settings.autoCommit) {
    body = (
      <>
        <Hint>Контрольних точок немає. Увімкніть їх — і після кожного раунду кімната робитиме git commit, до якого можна повернути теку.</Hint>
        <Button className="w-fit" size="sm" onClick={turnOn}>
          Увімкнути контрольні точки
        </Button>
      </>
    );
  } else {
    body = <Hint>Контрольних точок ще немає. Перша з'явиться, коли агенти закінчать раунд, у якому змінили файли.</Hint>;
  }
  return (
    <Shell title="Повернути теку" sub={room?.workspace} size="md">
      {body}
    </Shell>
  );
}


// --- room settings -----------------------------------------------------------------------

function SettingsDialog() {
  const room = useStore((s) => s.snap?.state);
  const post = useStore((s) => s.post);
  const openDialog = useStore((s) => s.openDialog);
  const s = room?.settings;
  const [limited, setLimited] = useState(typeof s?.budget === "number");
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
              budget: limited ? Math.min(100, Math.max(1, Number.parseInt(budget, 10) || s.budget || 8)) : null,
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
          <label className="flex items-center justify-between gap-3 text-sm">
            Ліміт ходів на ваше повідомлення
            <Switch checked={limited} onCheckedChange={setLimited} />
          </label>
          {limited && (
            <Input id="s-budget" aria-label="Ходів агентів на ваше повідомлення" type="number" min={1} max={100} value={budget} onChange={(e) => setBudget(e.target.value)} className="w-28" />
          )}
          <Hint>
            {limited
              ? "Скільки ходів агенти роблять після вашого повідомлення, перш ніж зупинитися й чекати на вас."
              : "Без ліміту: агенти працюють, доки комусь є що додати, і кімната стихає, коли всі пасують. Зупинити можна будь-коли."}
          </Hint>
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
          <Hint>Агенти працюють, як у вашому терміналі: Claude — з вашими налаштуваннями, Codex — у своїй пісочниці. «Лише читання» чи вимкнена мережа обмежують обох.</Hint>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          Мережа для команд агентів
          <Switch checked={network} onCheckedChange={setNetwork} />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          {t.checkpoint.setting}
          <Switch checked={autoCommit} onCheckedChange={setAutoCommit} />
        </label>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-doc">Спільний документ</Label>
          <Input id="s-doc" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="README.md" spellCheck={false} className="font-mono text-small" />
          <Hint>Файл, який кімната пише разом. Порожньо — без нього.</Hint>
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
  const openDialog = useStore((s) => s.openDialog);
  // The room's own agents (any number, any mix); outside a room — the default pair.
  const agents = useStore((s) => s.snap?.state.agents) ?? DEFAULT_AGENTS;
  const at = (agent: RoomAgent) => {
    const who = participant({ agents }, agent.id);
    return (
      <span
        key={agent.id}
        style={ink(who)}
        className={cn("rounded-md px-1.5 py-0.5 font-mono text-small", who.tone === "codex" ? "bg-codex-soft text-codex" : "bg-claude-soft text-claude")}
      >
        @{agent.id}
      </span>
    );
  };
  const li = "relative pl-5 before:absolute before:top-[0.6em] before:left-1 before:size-1.5 before:rounded-full before:bg-primary/50";
  return (
    <Shell title="Як це працює">
      <div className="flex flex-col gap-3.5 text-body leading-relaxed">
        <p>
          <b>Кімната</b> — одна розмова для вас і {names(agents.map((a) => a.label))}. Agoryx задає контекст, а не ролі: агенти працюють у своїх рідних сесіях з усіма своїми
          інструментами.
        </p>
        <ul className="flex flex-col gap-2">
          <li className={li}>
            На ваше повідомлення агенти беруться <b>одночасно</b> — з того самого місця, і по ходу кажуть одне одному, хто що робить.
          </li>
          <li className={li}>
            Далі вони говорять <b>по черзі</b>: кожен бачить усе, що сказано раніше. Коли нема що додати — хід пропускається.
          </li>
          <li className={li}>Після кількох ходів розмова зупиняється й чекає на вас. Кількість — у налаштуваннях кімнати.</li>
          <li className={li}>
            {agents.map((agent, i) => [i ? (i === agents.length - 1 ? " чи " : ", ") : null, at(agent)])} — звернутися лише до одного.
          </li>
          <li className={li}>
            <b>Стіл</b> — питання, варіанти, заперечення й рішення, коли є справжні альтернативи.
          </li>
          <li className={li}>
            <b>Документ</b> — один спільний файл, кожна версія з автором.
          </li>
        </ul>
        <Hint className="text-small">
          Без браузера: <code className="font-mono">agoryx tail -f</code>, <code className="font-mono">agoryx say "…"</code>, <code className="font-mono">agoryx table</code>.
          Сесію агента можна відкрити в Claude Code чи Codex — розмова там теж потрапить у кімнату.{" "}
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => openDialog({ kind: "keys" })}>
            Клавіші
          </button>{" "}
          <Kbd>?</Kbd>

        </Hint>
      </div>
    </Shell>
  );
}

// --- keys ---------------------------------------------------------------------------------------

function KeysDialog() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <Shell title="Клавіші" size="sm">
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group} className="flex flex-col gap-1">
            <h3 className="text-meta font-medium text-muted-foreground">{group}</h3>
            <dl className="flex flex-col">
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.id} className="flex items-center gap-3 border-b border-border/60 py-1.5 last:border-0">
                  <dt className="min-w-0 flex-1 text-ui">{s.label}</dt>
                  <dd>
                    <Kbd className="font-mono">{keyLabel(s.id)}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
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
              <b className="text-ui leading-snug">{option.title}</b>
              <div className="text-meta text-muted-foreground">{participant(room, option.by).label}</div>
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
        <Hint>{op === "decide" ? "Рішення з'явиться в розмові, і агенти продовжать із нього." : "Агенти побачать це у своєму наступному ході."}</Hint>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => openDialog(null)}>
            Скасувати
          </Button>
          <Button type="submit" disabled={busy || missing} title={form.fields.some((f) => f.area) ? withMod("Enter") : undefined}>
            {op === "decide" ? `Обрати ${target}` : "Покласти на стіл"}
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

const render = (d: DialogState) => {
  switch (d.kind) {
    case "revert":
      return <RevertDialog sha={d.sha} undo={d.undo} />;
    case "settings":
      return <SettingsDialog />;
    case "help":
      return <HelpDialog />;
    case "keys":
      return <KeysDialog />;
    case "table-form":
      return <TableFormDialog key={`${d.op}:${d.target ?? ""}`} op={d.op} target={d.target} q={d.q} />;
  }
};

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const snap = useStore((s) => Boolean(s.snap));
  if (!dialog) return null;
  if (dialog.kind !== "help" && dialog.kind !== "keys" && !snap) return null;
  return render(dialog);
}

