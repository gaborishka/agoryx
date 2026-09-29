// Jev (TypeSafe's decision model, https://typesafe.ai) answers small yes/no questions for the room, cheaply
// (a few hundred milliseconds, a few hundred tokens):
// - when the human put something to one agent alone and its answer names no one, is a second look from
//   another agent worth a turn?
// - who is an agent's message meant for, @name or not, and which of its paragraphs holds a position the room
//   still has to settle?
// Without a key nothing is asked: the room goes by @names and its own word lists alone. Asking sends the
// texts to TypeSafe (or OpenRouter), so it is on only where the daemon has a key.

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

export interface MessageCase {
  /** Who wrote it (a label: "Claude"). */
  author: string;
  /** The message, split into paragraphs. */
  paragraphs: string[];
  /** The agents it might be meant for: id and label. */
  others: Array<{ id: string; label: string }>;
}

export interface MessageVerdict {
  /** Each other agent's probability that the message is meant for it: asks it something, hands it work, waits on it. */
  addressed: Record<string, number>;
  /** Per paragraph, the probability it holds a position the room still has to settle; null: not asked (too short, or past the first few). */
  stances: Array<number | null>;
  ms: number;
  tokens: number;
}

/** Reads one agent message: who it is meant for, and which paragraphs take a position; rejects when Jev cannot be reached. */
export type ReadMessage = (entry: MessageCase) => Promise<MessageVerdict>;

const PROVIDERS = {
  typesafe: { keyName: "TYPESAFE_API_KEY", url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  openrouter: { keyName: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" },
} as const;

const TIMEOUT_MS = 8_000;
/** Enough of a long answer to judge it: its start and its end. */
const MAX_TEXT = 6_000;
/** A message's paragraphs asked about: the first MAX_PARAGRAPHS of at least MIN_PARAGRAPH characters. */
const MAX_PARAGRAPHS = 10;
const MIN_PARAGRAPH = 24;
const SEEN_IN = "Agoryx, a shared room where one human and several AI coding agents work in one conversation";

const clip = (text: string): string =>
  text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT / 2)}\n…\n${text.slice(-MAX_TEXT / 2)}`;

type Question = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
type Ask = (state: Record<string, string>, questions: Record<string, Question>) => Promise<{ answers: Record<string, number>; ms: number; tokens: number }>;

/** Jev as the daemon's environment sets it up, or null: no key, or AGORYX_JEV=off. */
function jevAsk(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Ask | null {
  if (String(env.AGORYX_JEV ?? "").trim().toLowerCase() === "off") return null;
  const wanted = String(env.JEV_PROVIDER ?? "").trim().toLowerCase();
  const names = (wanted in PROVIDERS ? [wanted] : Object.keys(PROVIDERS)) as Array<keyof typeof PROVIDERS>;
  const name = names.find((candidate) => env[PROVIDERS[candidate].keyName]);
  if (!name) return null;
  const provider = PROVIDERS[name];
  const apiKey = env[provider.keyName]!;
  return async (state, questions) => {
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
    const answers: Record<string, number> = {};
    for (const id of Object.keys(questions)) {
      const p = body.answers?.[id]?.noul;
      if (typeof p === "number" && Number.isFinite(p)) answers[id] = p;
    }
    return { answers, ms: Date.now() - sentAt, tokens: body.usage?.input_tokens ?? 0 };
  };
}

/** Jev's second look, or null: no key, or AGORYX_JEV=off. */
export function jevSecondLook(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): SecondLook | null {
  const ask = jevAsk(env, fetchImpl);
  if (!ask) return null;
  return async (entry) => {
    const questions = Object.fromEntries(
      entry.others.map((other): [string, Question] => [
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
      seen_in: SEEN_IN,
      question: clip(entry.question),
      answered_by: entry.answeredBy,
      answer: clip(entry.answer),
      ...(entry.changed.length ? { files_changed_by_the_answer: entry.changed.slice(0, 40).join("\n") } : {}),
    };
    const { answers, ms, tokens } = await ask(state, questions);
    const worth: Record<string, number> = {};
    for (const other of entry.others) {
      const p = answers[`look:${other.id}`];
      if (p !== undefined) worth[other.id] = p;
    }
    return { worth, ms, tokens };
  };
}

/** Jev's reading of agent messages, or null: no key, or AGORYX_JEV=off. */
export function jevReadMessage(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): ReadMessage | null {
  const ask = jevAsk(env, fetchImpl);
  if (!ask) return null;
  return async (entry) => {
    const asked = entry.paragraphs
      .map((text, index) => (text.trim().length >= MIN_PARAGRAPH ? index : -1))
      .filter((index) => index >= 0)
      .slice(0, MAX_PARAGRAPHS);
    const questions: Record<string, Question> = {};
    for (const other of entry.others) {
      questions[`to:${other.id}`] = {
        type: "noul",
        instructions:
          `Is this message by ${entry.author} meant for ${other.label} — does it ask ${other.label} something, hand ${other.label} work, or wait on ${other.label} to answer or act — whether or not it writes @${other.id}? ` +
          `Saying what ${other.label} did, or thanking ${other.label}, is not.`,
        criteria: { true: `Yes, it is meant for ${other.label}`, false: "No" },
      };
    }
    for (const index of asked) {
      questions[`p${index + 1}`] = {
        type: "noul",
        instructions:
          `Paragraph ${index + 1}: does it take a position the room still has to settle — disagree with someone's choice, prefer another way, or leave a question open for someone to decide? ` +
          "Plain coordination (who takes which file, what I am doing now), status reports, test results, and asking someone to do a task are not.",
        criteria: { true: "Yes, an open position", false: "No" },
      };
    }
    const state: Record<string, string> = { seen_in: SEEN_IN, author: entry.author };
    if (asked.length) for (const index of asked) state[`paragraph_${index + 1}`] = clip(entry.paragraphs[index]!);
    else state.message = clip(entry.paragraphs.join("\n\n"));
    const { answers, ms, tokens } = await ask(state, questions);
    const addressed: Record<string, number> = {};
    for (const other of entry.others) {
      const p = answers[`to:${other.id}`];
      if (p !== undefined) addressed[other.id] = p;
    }
    return { addressed, stances: entry.paragraphs.map((_, index) => answers[`p${index + 1}`] ?? null), ms, tokens };
  };
}

/** How sure Jev must be before another agent is woken (AGORYX_JEV_THRESHOLD, 0–1; default one half). */
export function jevThreshold(env: NodeJS.ProcessEnv): number {
  const value = Number(env.AGORYX_JEV_THRESHOLD);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.5;
}
