import type { AgentKind, AgentModels, RoomAgent } from "./types";

export const KIND_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
export const KIND_SHORT: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

/** The daemon's bound on a role (roster.ts MAX_ROLE_CHARS). */
export const MAX_ROLE = 2_000;

/** Roles to start from: a click fills the field, the words stay the human's to change. */
export const ROLE_IDEAS: Array<{ name: string; text: string }> = [
  { name: "Reviewer", text: "Reviewer: look for bugs, risks and missed cases in what the others do. Do not write code — say where and why." },
  { name: "Implementer", text: "Implementer: write and run the code. Less talk, more done — and say which files you changed." },
  { name: "Tester", text: "Tester: write and run tests for what the others do, and say what failed." },
  { name: "Critic", text: "Critic: find the strongest arguments against what is proposed. Agree only when no objection is really left." },
  { name: "Researcher", text: "Researcher: read the code, the docs and the sources, and bring facts with links. Do not make the decisions." },
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
