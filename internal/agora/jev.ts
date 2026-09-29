// Jev (TypeSafe's decision model, https://typesafe.ai) answers small yes/no questions for the room, cheaply
// (a few hundred milliseconds, a few hundred tokens):
// - when the human put something to one agent alone and its answer names no one, is a second look from
//   another agent worth a turn?
// - who is an agent's message meant for, @name or not, and which of its paragraphs holds a position the room
//   still has to settle?
// Without a key nothing is asked: the room goes by @names and its own word lists alone. Asking sends the
// texts to TypeSafe (or OpenRouter), so it is on only where the daemon has a key.
// With no key, but the human signed in with ChatGPT (`agoryx login chatgpt`, plan use granted), the same
// questions go to a small model on their ChatGPT plan instead: slower (seconds, not milliseconds), no key.

import { parseEnv } from "node:util";
import { activeAccount, chatgptDir, planUsageOn } from "../chatgpt/credentials.js";
import { PlanError, streamResponse } from "../chatgpt/responses.js";
import { freshAccount } from "../chatgpt/session.js";

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
  /** Who answered, as the room is told ("Jev", or the ChatGPT model); Jev when not given. */
  by?: string;
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
  /** Who answered, as the room is told; Jev when not given. */
  by?: string;
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

/** The model asked on the human's ChatGPT plan: AGORYX_JEV_MODEL, else a small fast one. */
export const JEV_CHATGPT_MODEL = "gpt-5.6-luna";
const CHATGPT_TIMEOUT_MS = 20_000;

export type JevProvider =
  | { name: "typesafe" | "openrouter"; label: "Jev"; via: string }
  | { name: "chatgpt"; label: string; via: string; model: string; dir: string };

/**
 * Who answers the room's questions, as the daemon's environment sets it up: a Jev key, else a ChatGPT sign-in
 * that granted plan use. JEV_PROVIDER=typesafe|openrouter takes that key only, JEV_PROVIDER=chatgpt the sign-in
 * only. Null: nobody to ask, or AGORYX_JEV=off.
 */
export function jevProvider(env: NodeJS.ProcessEnv): JevProvider | null {
  if (String(env.AGORYX_JEV ?? "").trim().toLowerCase() === "off") return null;
  const wanted = String(env.JEV_PROVIDER ?? "").trim().toLowerCase();
  if (wanted !== "chatgpt") {
    const names = (wanted in PROVIDERS ? [wanted] : Object.keys(PROVIDERS)) as Array<keyof typeof PROVIDERS>;
    const keyed = names.find((candidate) => env[PROVIDERS[candidate].keyName]);
    if (keyed) return { name: keyed, label: "Jev", via: PROVIDERS[keyed].keyName };
    if (wanted in PROVIDERS) return null;
  }
  const dir = chatgptDir(env);
  let account: ReturnType<typeof activeAccount>;
  try {
    account = activeAccount(dir);
  } catch {
    return null;
  }
  if (!account?.accessToken || !planUsageOn(account)) return null;
  const model = env.AGORYX_JEV_MODEL?.trim() || JEV_CHATGPT_MODEL;
  return { name: "chatgpt", label: model, via: `ChatGPT plan, ${account.email ?? account.clientId}`, model, dir };
}

const CHATGPT_INSTRUCTIONS =
  "You answer small yes/no questions about a moment in a shared room, for the software that runs the room. " +
  "For each question id, give the probability, from 0 to 1, that the answer is the question's \"yes\". " +
  "Judge only from the texts given; when they do not settle it, stay near the middle. Reply with the JSON object alone.";

/** The questions, put to a model on the human's ChatGPT plan: one request, a probability per question. */
function chatgptAsk(provider: Extract<JevProvider, { name: "chatgpt" }>, fetchImpl: typeof fetch): Ask {
  // "none" is the quickest where the model takes it; a model that does not is asked without it from then on.
  let effort: string | undefined = "none";
  return async (state, questions) => {
    const ids = Object.keys(questions);
    const input = JSON.stringify({
      situation: state,
      questions: Object.fromEntries(ids.map((id) => [id, { question: questions[id]!.instructions, yes: questions[id]!.criteria.true, no: questions[id]!.criteria.false }])),
    });
    const format = {
      name: "answers",
      schema: { type: "object", properties: Object.fromEntries(ids.map((id) => [id, { type: "number" }])), required: ids, additionalProperties: false },
    };
    const account = await freshAccount(provider.dir, fetchImpl);
    const send = () =>
      streamResponse(
        account.accessToken!,
        { model: provider.model, instructions: CHATGPT_INSTRUCTIONS, input, format, ...(effort ? { effort } : {}), signal: AbortSignal.timeout(CHATGPT_TIMEOUT_MS) },
        fetchImpl,
      );
    let done: Awaited<ReturnType<typeof streamResponse>>;
    try {
      done = await send();
    } catch (error) {
      if (!(effort && error instanceof PlanError && error.param === "reasoning.effort")) throw error;
      effort = undefined;
      done = await send();
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(done.text) as Record<string, unknown>;
    } catch {
      throw new Error(`${provider.model} did not answer in JSON: ${done.text.slice(0, 120)}`);
    }
    const answers: Record<string, number> = {};
    for (const id of ids) {
      const p = body[id];
      if (typeof p === "number" && Number.isFinite(p)) answers[id] = Math.min(1, Math.max(0, p));
    }
    return { answers, ms: done.ms, tokens: done.usage?.input_tokens ?? 0 };
  };
}

/** The room's questions as the daemon's environment sets them up (see jevProvider), or null: nobody to ask. */
function jevAsk(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): { ask: Ask; by: string } | null {
  const chosen = jevProvider(env);
  if (!chosen) return null;
  if (chosen.name === "chatgpt") return { ask: chatgptAsk(chosen, fetchImpl), by: chosen.label };
  const provider = PROVIDERS[chosen.name];
  const apiKey = env[provider.keyName]!;
  const ask: Ask = async (state, questions) => {
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
  return { ask, by: chosen.label };
}

/** Jev's second look, or null: nobody to ask (see jevProvider). */
export function jevSecondLook(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): SecondLook | null {
  const asker = jevAsk(env, fetchImpl);
  if (!asker) return null;
  const { ask, by } = asker;
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
    return { worth, ms, tokens, by };
  };
}

/** Jev's reading of agent messages, or null: nobody to ask (see jevProvider). */
export function jevReadMessage(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): ReadMessage | null {
  const asker = jevAsk(env, fetchImpl);
  if (!asker) return null;
  const { ask, by } = asker;
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
    return { addressed, stances: entry.paragraphs.map((_, index) => answers[`p${index + 1}`] ?? null), ms, tokens, by };
  };
}

/** The daemon's own Jev settings: never passed on to the agents it runs. */
export const JEV_ENV = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEV_PROVIDER"] as const;

/**
 * Jev's settings from a `.env` file's text, into `env`: these names only, and never over what the environment
 * already sets. Returns the names taken.
 */
export function jevEnvFrom(text: string, env: NodeJS.ProcessEnv): string[] {
  const values = parseEnv(text);
  return JEV_ENV.filter((name) => {
    const value = values[name]?.trim();
    if (!value || env[name]) return false;
    env[name] = value;
    return true;
  });
}

/** How sure Jev must be before another agent is woken (AGORYX_JEV_THRESHOLD, 0–1; default one half). */
export function jevThreshold(env: NodeJS.ProcessEnv): number {
  const value = Number(env.AGORYX_JEV_THRESHOLD);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.5;
}
