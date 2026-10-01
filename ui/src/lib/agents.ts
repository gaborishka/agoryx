import type { AgentKind, AgentModels, RoomAgent } from "./types";

export const KIND_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
export const KIND_SHORT: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

/** The daemon's bound on a role (roster.ts MAX_ROLE_CHARS). */
export const MAX_ROLE = 2_000;

/** Roles to start from: a click fills the field, the words stay the human's to change. */
export const ROLE_IDEAS: Array<{ name: string; text: string }> = [
  { name: "Рецензент", text: "Рецензент: шукай помилки, ризики й пропущені випадки в тому, що роблять інші. Код не пиши — лише вказуй, де і чому." },
  { name: "Виконавець", text: "Виконавець: пиши й запускай код. Менше обговорень — більше зробленого, і кажи, які файли змінив." },
  { name: "Тестувальник", text: "Тестувальник: пиши й запускай тести до того, що роблять інші, і кажи, що впало." },
  { name: "Критик", text: "Опонент: шукай найсильніші аргументи проти запропонованого. Погоджуйся, лише коли заперечень справді не лишилось." },
  { name: "Дослідник", text: "Дослідник: читай код, документацію й джерела, приноси факти з посиланнями. Рішень не ухвалюй." },
];

/**
 * An agent is its CLI and its model, and so is its name: "Claude Opus", "Codex GPT-5" — never just "Opus",
 * which reads as a third vendor next to Claude. The CLI's default model is plain "Claude"; a repeat gets 2, 3, …
 * `taken`: handles that cannot be reused (agents that were in the room and left, of another CLI).
 */
export const nameFor = (kind: AgentKind, model: string | undefined, models: AgentModels | null, others: readonly RoomAgent[], taken: readonly string[] = []) => {
  const label = model ? (models?.[kind]?.models.find((m) => m.id === model)?.label ?? model) : "";
  const base = label ? `${KIND_SHORT[kind]} ${label}` : KIND_SHORT[kind];
  const free = (name: string) =>
    !others.some((agent) => agent.label.toLowerCase() === name.toLowerCase() || agent.id === handleFor(name)) && !taken.includes(handleFor(name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (free(name)) return name;
  }
};

/** "Opus 2" → "opus-2": the @handle the daemon takes (a letter, then letters, digits, _ and -). */
export const handleFor = (label: string) =>
  label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);

/** Only the fields a roster takes. */
export const rosterEntry = ({ id, kind, label, model, effort, profile, role }: RoomAgent): RoomAgent => ({
  id,
  kind,
  label,
  ...(model ? { model } : {}),
  ...(effort ? { effort } : {}),
  ...(profile === false ? { profile } : {}),
  ...(role ? { role } : {}),
});

/**
 * A model as a person reads it: the catalogue's name, else the id made readable —
 * "claude-opus-5-5" → "Opus 5.5", "gpt-5.6" → "GPT-5.6".
 */
export const modelName = (kind: AgentKind, model: string | undefined, models: AgentModels | null): string | undefined => {
  if (!model) return undefined;
  const known = models?.[kind]?.models.find((m) => m.id === model)?.label;
  if (known) return known;
  if (/^gpt-/i.test(model)) return `GPT-${model.slice(4)}`;
  const parts = model.replace(/^claude-/i, "").split("-");
  const words = parts.filter((part) => !/^\d+$/.test(part)).map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  const version = parts.filter((part) => /^\d+$/.test(part) && part.length < 4).join(".");
  return [...words, version].filter(Boolean).join(" ") || model;
};

/** What the name does not already say about the model: nothing for "Claude Opus" on Opus 5.5, "Opus 5.5" for plain "Claude". */
export const modelBeyondName = (agent: RoomAgent, models: AgentModels | null): string | undefined => {
  const name = modelName(agent.kind, agent.model, models);
  if (!name) return undefined;
  const first = name.split(/[\s-]/)[0]!.toLowerCase();
  return agent.label.toLowerCase().includes(first) ? undefined : name;
};
