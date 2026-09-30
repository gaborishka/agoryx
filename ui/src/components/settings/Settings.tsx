import {
  BotIcon,
  GaugeIcon,
  InfoIcon,
  type LucideIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Hint, Loading } from "@/components/common/states";
import { PhonePanel } from "@/components/dialogs/PhoneDialog";
import { Avatar } from "@/components/room/bits";
import { LimitsCard } from "@/components/room/Limits";
import { ModelMenu } from "@/components/room/ModelMenu";
import { NavButton } from "@/components/room/RoomHeader";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, local, Unauthorized } from "@/lib/api";
import { keyLabel, withMod } from "@/lib/keys";
import { errText } from "@/lib/load";
import { useModels } from "@/lib/models";
import { DEFAULT_AGENTS } from "@/lib/room";
import { type SettingsSection, useStore } from "@/lib/store";
import { type ThemePref, useTheme } from "@/lib/theme";
import type { AgentKind, AgentModels, LimitSnapshot, RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Agoryx's own settings, not a room's: how the page looks, what new rooms start with, the human's profile,
 * the agents new rooms seat, this computer's phone, the subscriptions' limits. A room's own settings stay in
 * the room (⋯ → Налаштування кімнати).
 */

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "Загальне", icon: SlidersHorizontalIcon },
  { id: "profile", label: "Профіль", icon: UserRoundIcon },
  { id: "agents", label: "Агенти", icon: BotIcon },
  { id: "phone", label: "Телефон", icon: SmartphoneIcon },
  { id: "limits", label: "Ліміти", icon: GaugeIcon },
  { id: "about", label: "Про Agoryx", icon: InfoIcon },
];

const fail = (error: unknown) => {
  if (!(error instanceof Unauthorized)) toast.error(errText(error));
};

function Section({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-serif text-title font-semibold tracking-tight">{title}</h2>
        {sub ? <p className="max-w-[60ch] text-small leading-relaxed text-muted-foreground">{sub}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** A labelled setting: the name and what it does on the left, the control on the right (under it on a phone). */
function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="text-ui font-medium">
          {label}
        </label>
        {hint ? <p className="text-small leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {title ? <h3 className="text-meta font-medium tracking-wide text-faint uppercase">{title}</h3> : null}
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-4">{children}</div>
    </div>
  );
}

// --- general ------------------------------------------------------------------------------------

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "system", label: "Як у системі" },
  { id: "light", label: "Світла" },
  { id: "dark", label: "Темна" },
];

const BUDGETS = [4, 8, 16, 32];

/** What the start screen remembers on this device (StartScreen.tsx reads the same keys). */
const readBudget = (): number | null => {
  const n = Number.parseInt(local.get("budget") ?? "", 10);
  return n >= 1 && n <= 100 ? n : null;
};

function General() {
  const { pref, set } = useTheme();
  const openDialog = useStore((s) => s.openDialog);
  const [budget, setBudget] = useState<number | null>(readBudget);
  const [worktree, setWorktree] = useState(() => local.get("worktree") === "1");
  return (
    <Section title="Загальне" sub="Як виглядає Agoryx і з чим починаються нові кімнати на цьому пристрої.">
      <Group title="Вигляд">
        <Row label="Тема">
          <div role="radiogroup" aria-label="Тема" className="inline-flex rounded-lg bg-muted p-0.5">
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={pref === theme.id}
                onClick={() => set(theme.id)}
                className={cn(
                  "h-7 rounded-md px-3 text-small transition",
                  pref === theme.id ? "bg-card font-medium text-foreground shadow-edge" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Нові кімнати">
        <Row
          label="Ліміт ходів"
          hint={
            budget === null
              ? "Без ліміту: агенти працюють, доки комусь є що додати, і кімната стихає, коли всі пасують."
              : `Після вашого повідомлення агенти роблять щонайбільше ${budget} ходів і чекають на вас.`
          }
        >
          <Select
            value={budget === null ? "none" : String(budget)}
            onValueChange={(value) => {
              const next = value === "none" ? null : Number(value);
              setBudget(next);
              local.set("budget", next === null ? null : String(next));
            }}
          >
            <SelectTrigger className="w-40" aria-label="Ліміт ходів">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Без ліміту</SelectItem>
              {BUDGETS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} ходів
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Окрема гілка для git-теки" hint="Кімната в git-репозиторії працює в новому worktree, а ваша тека лишається як є.">
          <Switch
            checked={worktree}
            onCheckedChange={(on) => {
              setWorktree(on);
              local.set("worktree", on ? "1" : null);
            }}
            aria-label="Окрема гілка для git-теки"
          />
        </Row>
      </Group>
      <Group title="Клавіші">
        <Row label="Усі клавіші" hint={<>Пошук і всі дії — <Kbd>{withMod("K")}</Kbd>, налаштування — <Kbd>{keyLabel("settings")}</Kbd>.</>}>
          <Button variant="outline" size="sm" onClick={() => openDialog({ kind: "keys" })}>
            Показати
          </Button>
        </Row>
      </Group>
    </Section>
  );
}

// --- profile ------------------------------------------------------------------------------------

interface ProfileFile {
  path: string;
  text: string;
  max: number;
}

function Profile() {
  const [file, setFile] = useState<ProfileFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<ProfileFile>("GET", "/api/profile")
      .then((got) => {
        setFile(got);
        setText(got.text);
      })
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, []);
  const dirty = file !== null && text !== file.text;
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      const got = await api<ProfileFile>("PUT", "/api/profile", { text });
      setFile(got);
      setText(got.text);
      toast.success("Профіль збережено. Агенти отримають його з наступного ходу.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const chars = text.trim().length;
  return (
    <Section
      title="Профіль"
      sub="Хто ви, як працюєте, що для вас важливо — своїми словами. Його отримують агенти кожної кімнати (крім тих, кому ви його вимкнули в «Агентах»). Agoryx нікуди його не копіює: ні в теку, ні в журнал кімнати, ні в коміти."
    >
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !file ? (
        <Loading lines={2} block />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
              }
            }}
            placeholder={"Я пишу бекенд на Go і TypeScript.\nПишіть мені українською, коротко і по суті.\nСпершу дія, потім пояснення."}
            aria-label="Профіль"
            className="min-h-[280px] resize-y font-mono text-small leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-3">
            <span className={cn("text-meta tabular-nums", chars > file.max ? "text-amber-ink" : "text-faint")}>
              {chars} / {file.max} знаків{chars > file.max ? " — агенти отримають лише початок" : ""}
            </span>
            <span className="truncate font-mono text-meta text-faint" title={file.path}>
              {file.path}
            </span>
            <div className="ml-auto flex gap-2">
              {dirty ? (
                <Button type="button" variant="ghost" onClick={() => setText(file.text)}>
                  Скасувати
                </Button>
              ) : null}
              <Button type="submit" disabled={!dirty || busy}>
                Зберегти
              </Button>
            </div>
          </div>
        </form>
      )}
    </Section>
  );
}

// --- agents -------------------------------------------------------------------------------------

interface RosterFile {
  path: string;
  custom: boolean;
  agents?: RoomAgent[];
  rosterError?: string;
}

const KIND_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
const KIND_SHORT: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

/**
 * An agent is its CLI and its model, and so is its name: "Claude Opus", "Codex GPT-5" — never just "Opus",
 * which reads as a third vendor next to Claude. The CLI's default model is plain "Claude"; a repeat gets 2, 3, …
 */
const nameFor = (kind: AgentKind, model: string | undefined, models: AgentModels | null, others: readonly RoomAgent[]) => {
  const label = model ? (models?.[kind]?.models.find((m) => m.id === model)?.label ?? model) : "";
  const base = label ? `${KIND_SHORT[kind]} ${label}` : KIND_SHORT[kind];
  const free = (name: string) => !others.some((agent) => agent.label.toLowerCase() === name.toLowerCase() || agent.id === handleFor(name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (free(name)) return name;
  }
};

/** "Opus 2" → "opus-2": the @handle the daemon takes (a letter, then letters, digits, _ and -). */
const handleFor = (label: string) =>
  label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);

/** Only the fields the roster file takes. */
const entry = ({ id, kind, label, model, effort, profile }: RoomAgent): RoomAgent => ({
  id,
  kind,
  label,
  ...(model ? { model } : {}),
  ...(effort ? { effort } : {}),
  ...(profile === false ? { profile } : {}),
});

function Agents() {
  const models = useModels();
  const [file, setFile] = useState<RosterFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<RoomAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<AgentKind>("claude");
  const [model, setModel] = useState<string>("");
  const take = useCallback((got: RosterFile) => {
    setFile(got);
    setAgents(got.agents ?? DEFAULT_AGENTS);
  }, []);
  useEffect(() => {
    api<RosterFile>("GET", "/api/roster")
      .then(take)
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, [take]);
  const saved = JSON.stringify((file?.agents ?? DEFAULT_AGENTS).map(entry));
  const dirty = file !== null && JSON.stringify(agents.map(entry)) !== saved;
  const change = (id: string, patch: Partial<RoomAgent>) =>
    setAgents((list) =>
      list.map((agent) => {
        if (agent.id !== id) return agent;
        const next: RoomAgent = { ...agent, ...patch };
        for (const key of ["model", "effort"] as const) if (key in patch && !patch[key]) delete next[key];
        if (next.profile !== false) delete next.profile;
        // A name made from the model follows the model ("Claude Opus" → "Claude Sonnet"); a name of one's own stays.
        const others = list.filter((a) => a.id !== id);
        if ("model" in patch && agent.label === nameFor(agent.kind, agent.model, models, others) && agent.label !== KIND_SHORT[agent.kind]) {
          next.label = nameFor(agent.kind, next.model, models, others);
          if (agent.id === handleFor(agent.label)) next.id = handleFor(next.label);
        }
        return next;
      }),
    );
  const name = nameFor(kind, model || undefined, models, agents);
  const add = () => {
    setAgents((list) => [...list, { id: handleFor(name), kind, label: name, ...(model ? { model } : {}) }]);
    setModel("");
  };
  const done = (got: RosterFile, message: string) => {
    take(got);
    // The start screen's own picks were on top of the old roster: the new one is what it starts from.
    local.set("start.models", null);
    toast.success(message);
  };
  const save = async () => {
    setBusy(true);
    try {
      done(await api<RosterFile>("PUT", "/api/roster", { agents: agents.map(entry) }), "Збережено. Так сидітимуть нові кімнати.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    try {
      done(await api<RosterFile>("DELETE", "/api/roster"), "Знову Claude і Codex.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Агенти"
      sub="Хто сидить у кожній новій кімнаті, з якою моделлю і зусиллям. Кімнати, що вже є, лишаються як були: там модель змінюється внизу кімнати."
    >
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !file ? (
        <Loading lines={3} />
      ) : (
        <>
          {file.rosterError ? (
            <ErrorNote>
              Файл агентів не читається: {file.rosterError}. Збережіть список нижче, щоб переписати його, або поверніть Claude і Codex.
            </ErrorNote>
          ) : null}
          <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
            {agents.map((agent) => (
              <div key={agent.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar handle={agent.id} roster={agents} size={32} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-ui font-medium">{agent.label}</span>
                    <span className="truncate text-meta text-muted-foreground">
                      @{agent.id} · {KIND_NAME[agent.kind]}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ModelMenu
                    agent={agent}
                    seating={{ agents }}
                    models={models}
                    side="bottom"
                    variant="field"
                    onSet={(patch) => change(agent.id, pick(patch))}
                  />
                  <label className="flex items-center gap-2 text-small text-muted-foreground" title="Чи отримує цей агент ваш профіль">
                    Профіль
                    <Switch
                      checked={agent.profile !== false}
                      onCheckedChange={(on) => change(agent.id, { profile: on ? undefined : false })}
                      aria-label={`Профіль для ${agent.label}`}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    disabled={agents.length < 2}
                    aria-label={`Прибрати ${agent.label}`}
                    title={agents.length < 2 ? "У кімнаті має бути хоч один агент" : `Прибрати ${agent.label}`}
                    onClick={() => setAgents((list) => list.filter((a) => a.id !== agent.id))}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as AgentKind);
                setModel("");
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Який CLI">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
            <Select value={model || "default"} onValueChange={(value) => setModel(value === "default" ? "" : value)}>
              <SelectTrigger className="w-full sm:flex-1" aria-label="Модель">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Типова модель CLI</SelectItem>
                {(models?.[kind]?.models ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline" className="gap-1.5">
              <PlusIcon className="size-4" />
              Додати
            </Button>
          </form>
          <Hint>
            Додасться «{name}» (@{handleFor(name)}). Кілька агентів одного CLI можуть сидіти разом — напр. Claude на Opus і Claude на
            Sonnet: ім'я кожного каже, на якій він моделі.
          </Hint>
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <span className="truncate font-mono text-meta text-faint" title={file.path}>
              {file.custom ? file.path : "Типово: Claude і Codex"}
            </span>
            <div className="ml-auto flex gap-2">
              {file.custom ? (
                <Button variant="ghost" onClick={() => void reset()} disabled={busy}>
                  Повернути Claude і Codex
                </Button>
              ) : null}
              {dirty ? (
                <Button variant="ghost" onClick={() => setAgents(file.agents ?? DEFAULT_AGENTS)}>
                  Скасувати
                </Button>
              ) : null}
              <Button onClick={() => void save()} disabled={!dirty || busy}>
                Зберегти
              </Button>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

/** ModelMenu says only what changed: a key that is absent must stay as it was. */
const pick = (patch: { model?: string | null; effort?: string | null }): Partial<RoomAgent> => {
  const out: Partial<RoomAgent> = {};
  if ("model" in patch) out.model = patch.model ?? undefined;
  if ("effort" in patch) out.effort = patch.effort ?? undefined;
  return out;
};

// --- phone, limits, about ------------------------------------------------------------------------

function Phone() {
  const device = useStore((s) => s.device);
  return (
    <Section
      title={device ? "Цей пристрій" : "Телефон"}
      sub={device ? undefined : "Кімнати на телефоні: через Wi‑Fi чи Tailscale, з кодом або QR. Кожен пристрій має свій ключ, і його можна відкликати."}
    >
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
        <PhonePanel />
      </div>
    </Section>
  );
}

function Limits() {
  const [limits, setLimits] = useState<LimitSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ limits: LimitSnapshot[] }>("GET", "/api/limits")
      .then((got) => setLimits(got.limits))
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, []);
  return (
    <Section title="Ліміти підписок" sub="Що кожен CLI востаннє сказав про ліміти вашої підписки. Agoryx нічого не обмежує сам — лише показує.">
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !limits ? (
        <Loading lines={3} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <LimitsCard kind="claude" limits={limits} />
          <LimitsCard kind="codex" limits={limits} />
        </div>
      )}
    </Section>
  );
}

interface Info {
  version?: string | null;
  url: string;
  pid: number;
  home: string;
  rooms: number;
}

function About() {
  const openDialog = useStore((s) => s.openDialog);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Info>("GET", "/api/info")
      .then(setInfo)
      .catch((err) => !(err instanceof Unauthorized) && setError(errText(err)));
  }, []);
  const line = (label: string, value: ReactNode, mono = false) => (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <span className="text-small text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 break-all text-small sm:text-right", mono && "font-mono")}>{value}</span>
    </div>
  );
  return (
    <Section title="Про Agoryx" sub="Спільна кімната для людей і агентів: кожен агент — у своїй рідній сесії, з усіма своїми інструментами.">
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : !info ? (
        <Loading lines={4} />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-4">
          {line("Версія", info.version ?? "невідома")}
          {line("Демон", `${info.url} · pid ${info.pid}`, true)}
          {line("Дані", info.home, true)}
          {line("Кімнат", info.rooms)}
        </div>
      )}
      <div>
        <Button variant="outline" onClick={() => openDialog({ kind: "help" })}>
          Як це працює
        </Button>
      </div>
    </Section>
  );
}

// --- the screen ---------------------------------------------------------------------------------

const BODY: Record<SettingsSection, () => ReactNode> = {
  general: () => <General />,
  profile: () => <Profile />,
  agents: () => <Agents />,
  phone: () => <Phone />,
  limits: () => <Limits />,
  about: () => <About />,
};

export function Settings({ section }: { section: SettingsSection }) {
  const go = useStore((s) => s.go);
  useEffect(() => {
    document.title = "Налаштування · Agoryx";
  }, [section]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-5">
        <NavButton />
        <h1 className="font-serif text-lead font-semibold tracking-tight">Налаштування</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Розділи налаштувань"
          className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 px-3 py-2 md:w-52 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:px-2 md:py-4"
        >
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => go({ kind: "settings", section: id })}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-small whitespace-nowrap transition",
                section === id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div key={section} className="mx-auto flex w-full max-w-[720px] flex-col px-4 py-8 sm:px-8">
            {BODY[section]()}
          </div>
        </div>
      </div>
    </div>
  );
}
