// Jev (TypeSafe's decision model, https://typesafe.ai) answers one question for the room: when the human
// put something to one agent alone and its answer names no one, is a second look from another agent worth
// a turn? Without a key nothing is asked and nobody else is woken. Asking sends the human's question and
// the answer to TypeSafe (or OpenRouter), so it is on only where the daemon has a key.

export interface SecondLookCase {
  /** What the human asked, and of whom. */
  question: string;
  answeredBy: string;
  answer: string;
  /** Files the answering turn changed, as "path +a −r". */
  changed: string[];
  /** The agents who could take a look: id and label. */
  others: Array<{ id: string; label: string }>;
}

export interface SecondLookVerdict {
  /** Each other agent's probability that its look is worth a turn. */
  worth: Record<string, number>;
  ms: number;
  tokens: number;
}

/** Asks whether each other agent should take a look; rejects when Jev cannot be reached. */
export type SecondLook = (entry: SecondLookCase) => Promise<SecondLookVerdict>;

const PROVIDERS = {
  typesafe: { keyName: "TYPESAFE_API_KEY", url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  openrouter: { keyName: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" },
} as const;

const TIMEOUT_MS = 8_000;
/** Enough of a long answer to judge it: its start and its end. */
const MAX_TEXT = 6_000;

const clip = (text: string): string =>
  text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT / 2)}\n…\n${text.slice(-MAX_TEXT / 2)}`;

/** Jev as the daemon's environment sets it up, or null: no key, or AGORYX_JEV=off. */
export function jevSecondLook(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): SecondLook | null {
  if (String(env.AGORYX_JEV ?? "").trim().toLowerCase() === "off") return null;
  const wanted = String(env.JEV_PROVIDER ?? "").trim().toLowerCase();
  const names = (wanted in PROVIDERS ? [wanted] : Object.keys(PROVIDERS)) as Array<keyof typeof PROVIDERS>;
  const name = names.find((candidate) => env[PROVIDERS[candidate].keyName]);
  if (!name) return null;
  const provider = PROVIDERS[name];
  const apiKey = env[provider.keyName]!;
  return async (entry) => {
    const questions = Object.fromEntries(
      entry.others.map((other) => [
        `look:${other.id}`,
        {
          type: "noul",
          instructions:
            `The human asked ${entry.answeredBy} alone, and ${entry.answeredBy} answered without asking anyone else. ` +
            `Would it be worth waking ${other.label}, another AI agent in the room with its own blind spots, to check or add to this answer? ` +
            "Yes when the answer makes claims or changes that could be wrong, misses part of the question, or rests on a judgement another agent might see differently. " +
            "No when the answer is complete and simple enough that another agent would only agree or pass.",
          criteria: { true: `Yes, wake ${other.label}`, false: "No, the answer can stand" },
        },
      ]),
    );
    const state = {
      seen_in: "Agoryx, a shared room where one human and several AI coding agents work in one conversation",
      question: clip(entry.question),
      answered_by: entry.answeredBy,
      answer: clip(entry.answer),
      ...(entry.changed.length ? { files_changed_by_the_answer: entry.changed.slice(0, 40).join("\n") } : {}),
    };
    const sentAt = Date.now();
    const response = await fetchImpl(provider.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: provider.model, state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      answers?: Record<string, { noul?: number }>;
      usage?: { input_tokens?: number };
      detail?: unknown;
      message?: unknown;
      error?: unknown;
    };
    if (!response.ok) {
      const problem = body.detail ?? body.message ?? body.error ?? "request failed";
      throw new Error(`Jev ${response.status}: ${(typeof problem === "string" ? problem : JSON.stringify(problem)).slice(0, 200)}`);
    }
    const worth: Record<string, number> = {};
    for (const other of entry.others) {
      const p = body.answers?.[`look:${other.id}`]?.noul;
      if (typeof p === "number" && Number.isFinite(p)) worth[other.id] = p;
    }
    return { worth, ms: Date.now() - sentAt, tokens: body.usage?.input_tokens ?? 0 };
  };
}

/** How sure Jev must be before another agent is woken (AGORYX_JEV_THRESHOLD, 0–1; default one half). */
export function jevThreshold(env: NodeJS.ProcessEnv): number {
  const value = Number(env.AGORYX_JEV_THRESHOLD);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.5;
}
