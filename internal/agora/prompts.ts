import { originName } from "./actor.js";
import { PASS_RESPONSE_TOKEN } from "../events/pass-token.js";
import { describeTableOp, summarizeTable } from "./table.js";
import type { FileChange, RoomAgent, RoomEvent, RoomMessage, RoomState, TableOp } from "./types.js";
import { changeStats } from "./workspace.js";

export const PASS_TOKEN = PASS_RESPONSE_TOKEN;

/**
 * A reply is a pass when it is empty or starts with the token (possibly
 * wrapped in quotes/backticks). Returns the optional note after the token,
 * or null when the reply is a real message.
 */
export const passNote = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const core = trimmed.replace(/^[`"'*_\s]+/, "");
  if (!core.toLowerCase().startsWith(PASS_TOKEN)) return null;
  const rest = core.slice(PASS_TOKEN.length).replace(/^[`"'*_\s.:—–-]+/, "").trim();
  return rest.length > 280 ? null : rest;
};

const clock = (iso: string): string => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const displayName = (state: RoomState, handle: string): string => {
  const agent = state.agents.find((entry) => entry.id === handle);
  if (agent) return agent.label;
  if (handle === state.human) return `${state.human} (human)`;
  const guest = state.guests?.[handle];
  return guest ? originName(guest) : handle;
};

/** An excerpt is not the author's position: what was cut may qualify or reverse what was kept. */
const readHint = (id: string, shown: number, total: number): string =>
  `[excerpt — ${shown} of ${total} chars; the omitted part may qualify or reverse what is shown. Before you agree with it, answer it or build on it: agoryx read ${id}]`;

/** An agent's message up to this long arrives whole; a longer one arrives as its gist. */
export const AGENT_MESSAGE_FULL_CHARS = 1_200;
const GIST_HEAD_CHARS = 500;
const GIST_TAIL_CHARS = 400;

/**
 * Words that mark a paragraph as a stance against something — kept whole in a gist, because a clipped
 * objection stops being one. A heuristic on top of the table: `object`/`concede` moves always arrive in full.
 */
const DISSENT =
  /\b(disagree|object(?:ion)?s?|i don'?t (?:think|agree|buy)|not convinced|push back|wrong|won'?t work|concede|changed my mind|instead)\b|не\s+згод|не\s+погодж|заперечу|заперечен|(?<!\p{L})проти(?!\p{L})|не\s+переконал|не\s+спрацю|помилк|передума|натомість|(?<!\p{L})не\s+так(?!\p{L})/iu;
// `\b` is ASCII-only even with /u: a Cyrillic word needs letter lookarounds, or "проти" never matches.

/** Use the same protection rule for paragraph selection and whole-delta fitting. */
const protectedStance = (text: string, reader: { id: string }): boolean =>
  DISSENT.test(text) || parseMentions(text, [reader.id]).length > 0;

/** Paragraphs, with a fenced block (```…```) kept as one piece. */
const paragraphs = (text: string): string[] => {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "" && current.length) {
      out.push(current.join("\n"));
      current = [];
    } else if (line.trim() !== "" || fenced) current.push(line);
  }
  if (current.length) out.push(current.join("\n"));
  return out;
};

const cutHead = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const at = text.lastIndexOf(" ", max);
  return `${text.slice(0, at > max / 2 ? at : max)} …`;
};

const cutTail = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const at = text.indexOf(" ", text.length - max);
  return `… ${text.slice(at >= 0 && at < text.length - max / 2 ? at + 1 : text.length - max)}`;
};

/**
 * What of a colleague's message goes into the delta. Short messages, and whatever the reader cannot afford to
 * get wrong, arrive whole: the human's words, Agoryx notices and decisions. A long agent message arrives as its
 * start, its end (where the conclusion usually is), and, whole, every paragraph that addresses the reader by
 * @name or takes a stance against something — so an objection or a question to the reader is never cut to a
 * fragment. The rest is one `agoryx read` away.
 */
export const messageGist = (
  message: { id: string; author: string; kind: RoomMessage["kind"]; text: string },
  reader: { id: string },
  human: string,
): string => {
  const text = message.text.trim();
  const whole = message.kind === "human" || message.kind === "system" || message.kind === "decision" || message.author === human;
  if (whole || text.length <= AGENT_MESSAGE_FULL_CHARS) return text;

  const parts = paragraphs(text);
  const keep = parts.map((part, index) => index === 0 || index === parts.length - 1 || protectedStance(part, reader));
  const pieces: string[] = [];
  let gap = false;
  parts.forEach((part, index) => {
    if (!keep[index]) {
      gap = true;
      return;
    }
    if (gap && pieces.length) pieces.push("[…]");
    gap = false;
    // A paragraph kept for what it says is kept whole; the start and the end are only cut to size.
    if (protectedStance(part, reader)) pieces.push(part);
    // Omit a large code block as a unit rather than emitting an unclosed fence.
    else if (/^\s*(```|~~~)/m.test(part)) pieces.push("[code block omitted — read the full message]");
    else if (parts.length === 1) pieces.push(`${cutHead(part, GIST_HEAD_CHARS)}\n[…]\n${cutTail(part, GIST_TAIL_CHARS)}`);
    else pieces.push(index === 0 ? cutHead(part, GIST_HEAD_CHARS) : cutTail(part, GIST_TAIL_CHARS));
  });
  const gist = pieces.join("\n\n");
  // Nearly everything was worth keeping: then the message itself is the gist.
  if (gist.length >= text.length * 0.8) return text;
  return `${gist}\n${readHint(message.id, gist.length, text.length)}`;
};

interface TurnFiles {
  agent: string;
  files: string[];
  changes?: FileChange[];
}

/** "↳ changed: a.ts +12 −3, b.ts +40 −0 (new) — the exact diff: agoryx diff t7" */
const changedLine = (turnId: string, entry: TurnFiles): string => {
  if (!entry.changes?.length) {
    const { files } = entry;
    return `   ↳ changed: ${files.slice(0, 20).join(", ")}${files.length > 20 ? ` (+${files.length - 20} more)` : ""}`;
  }
  const shown = entry.changes
    .slice(0, 20)
    .map((change) => `${change.path} ${changeStats(change)}${change.status === "A" ? " (new)" : change.status === "D" ? " (deleted)" : ""}`);
  const more = entry.changes.length > 20 ? ` (+${entry.changes.length - 20} more)` : "";
  return `   ↳ changed: ${shown.join(", ")}${more} — the exact diff: agoryx diff ${turnId}`;
};

/**
 * The two lines that nudge agents to disagree rather than agree for politeness. On by default;
 * AGORYX_PROMPT_NORMS=off drops them, for control runs that test whether agents object unprompted.
 */
export const promptNorms = (env: NodeJS.ProcessEnv = process.env): boolean => env.AGORYX_PROMPT_NORMS?.trim().toLowerCase() !== "off";

export interface BriefingInput {
  state: RoomState;
  agent: RoomAgent;
  /** How agents invoke the room tools; `path` is the absolute fallback if PATH is reset. */
  agentCli: { command: string; path?: string };
  /** The room's environment, for AGORYX_PROMPT_NORMS; the host's when not given. */
  env?: NodeJS.ProcessEnv;
  /**
   * The human's profile block (profile.ts): in a fresh session's briefing, or, in a running one, only when it is new
   * to that session. Null for an agent the profile is off for — it gets nothing of it.
   */
  profile?: string | null;
}

/**
 * First-turn context. Deliberately no role: who is here, where the work lives,
 * how turns and passing work, and how to use the table.
 */
export const buildBriefing = ({ state, agent, agentCli: cli, env, profile }: BriefingInput): string => {
  const agentCli = cli.command;
  const norms = promptNorms(env);
  const others = state.agents.filter((entry) => entry.id !== agent.id);
  const peers = others.map((entry) => `${entry.label} (@${entry.id})`).join(", ");
  const access =
    state.settings.access === "readonly"
      ? "You can read the workspace; writes are disabled in this room."
      : "You can read, create and run anything inside the workspace.";
  return [
    `You are ${agent.label} (@${agent.id}), in an Agoryx room — one shared conversation between ${state.human} (human, @${state.human.toLowerCase()}) and ${peers || "no other agents yet"}.`,
    "Nobody here has an assigned role. Act as yourself, with everything you can do: read and write code, run things, research, draw, write, argue.",
    "",
    `Room: "${state.name}"`,
    `Workspace: ${state.workspace}`,
    `  A shared git directory — everyone works here. ${access}`,
    "  Others may edit files at the same time: check `git status` / `git diff` before overwriting, and say which files you touched.",
    `  Say what you are doing while you do it: \`${agentCli} say "taking internal/x.ts — leaving the CLI to you"\` posts to the room at once, as often as is useful (it is not a turn; it wakes only an agent you @mention that is not working now — that one starts at once, so \`say "@<agent> can you run the daemon tests?"\` gets an answer while you keep going; see it with \`read new\`). \`${agentCli} read new\` shows what the others said since your turn began — look before you take a file someone may be on.`,
    `  Every turn's exact change is kept. Your delta lists what others changed with +/− counts and the turn id; \`${agentCli} diff t7\` prints that turn's patch (add a path to narrow it, or no id to list recent ones). What was done is in the diff, not only in what was said about it.`,
    "",
    "How the room works:",
    "- Each turn you get only what is new since your last turn. Your final message is posted to the room; your tool calls show up to others as a short activity trace.",
    `  A long message from another agent comes as its start, its end, and every paragraph that addresses you or objects; \`${agentCli} read m12\` prints any message whole (\`${agentCli} read\` lists recent ones). An excerpt is not the author's position: read the whole before you agree with it or answer it.`,
    "- When the human writes, agents start in parallel from the same point: form your own view, not a guess at the consensus. The others' work reaches you only through what they say while working and their replies.",
    "- After that the agents take turns, one at a time: when you speak, you have seen everything said before you. It is one conversation — answer the latest state, not an old message.",
    `- Nothing substantive to add? Reply exactly ${PASS_TOKEN} and nothing else.${norms ? " Silence is fine; agreeing for politeness is noise." : ""}`,
    `  A turn that would only thank, acknowledge, sum up what is already said, or tidy the table is a pass: make the table moves, then reply ${PASS_TOKEN}.`,
    ...(norms ? ["- Disagree when you disagree, and say what would change your mind. An unresolved disagreement, stated clearly, is a valid outcome."] : []),
    `- Address someone with @name. ${state.human} is a participant, not a gatekeeper: you don't need permission to do the work being discussed.`,
    state.settings.budget === null
      ? "- There is no turn limit: the room goes on until everyone passes (or the human stops it). So pass as soon as you have nothing substantive to add — a finished job, a clear state, an agreement already stated are all reasons to pass."
      : "- Each run has a turn budget; the prompt says how many turns remain. Converge or leave a clear state before it runs out — once it is clear, pass: the room goes quiet when everyone passes, and unused turns are fine.",
    "- Reply in the language the human writes in.",
    "",
    ...(profile ? [profile, ""] : []),
    ...(state.settings.doc
      ? [
          `The room's canonical file: ${state.settings.doc} (in the workspace)`,
          "  The one text this room is making. Anyone edits it, with their own tools, when the conversation changes what it should say — there is no owner and no turn order for it.",
          "  Keep it the current version, not a log: the conversation and git hold the history. When others change it, your next turn shows you the diff.",
          "",
        ]
      : []),
    "The room has two surfaces, and they are not two chats:",
    "- The conversation is the talk: reasoning, questions to each other, what you did and found. It scrolls away.",
    "- The table is the room's working state — what the room currently holds: open questions, the real alternatives with the",
    "  arguments and evidence attached to each, what is settled, what someone still has to do, what was decided. It does not",
    "  scroll away: every turn ends with its current state, and the human sees it as a board beside the conversation.",
    "  You change it with a tool, during your turn, the way you would edit a file. Each move appears as a card under your",
    "  message, so don't repeat the card in prose — refer to it by id (P2, Q1) and spend your words on the reasoning.",
    "  Use it when there are real alternatives, when a claim needs its evidence next to it, or when something must outlive",
    "  the scroll (a finding, a settled point, a step someone owns). Don't mirror small talk into it.",
    `  ${agentCli} table ask "question"`,
    `  ${agentCli} table propose "short title" --body "what and why (markdown)" [--file path/in/workspace] [--q Q1]`,
    "    (a long body with a diagram: write it to a file and pass --body-file notes.md, or pipe it with --body -)",
    `  ${agentCli} table object P1 "reason"   |   support P1 "reason"   |   evidence P1 "finding" --source <url|path>`,
    `  ${agentCli} table settle "what is now established" [--q Q1]   |   fact "a checked fact"   |   next "concrete next step"   |   done X1`,
    "    (settle --q Q1 when the conclusion answers an open question: it closes Q1 with that answer)",
    `  ${agentCli} table concede "what I no longer hold, and why" [--on P1]   (an argument changed your mind: record it, don't just agree in prose)`,
    `  ${agentCli} table decide P1 --note "why"   (when the room has actually converged, or the human asked you to decide)`,
    `  ${agentCli} table show`,
    "  One op per command, not chained with && or ; — each runs without an approval prompt that way.",
    ...(cli.path
      ? [
          `  If \`${agentCli}\` is missing or says "Unknown command 'table'" (another install earlier on PATH), use "${cli.path}" table … instead`,
          `  Outside a room turn — when someone talks to you directly in this session — the table still works: run "${cli.path}" table … --as ${agent.id} --room ${state.id} from the workspace.`,
        ]
      : []),
    "",
    "Show, don't only tell. Everyone reads the room rendered, so your messages (and table --body) can carry more than text:",
    "- ```mermaid fences render as diagrams (flowchart, sequence, class, state, gantt, pie, …).",
    "- ```html fences render live in a sandbox: a whole self-contained page — inline CSS/JS, CDN scripts are fine — for",
    "  charts, interactive prototypes, visual comparisons. ```svg fences render as pictures.",
    "- Code fences with a language are highlighted. Tables in markdown render as tables.",
    "- ![caption](path/in/workspace) embeds a workspace file: images show inline, .html/.svg/.pdf render live, video and",
    "  audio play, .csv/.tsv show as tables, anything else opens as a file. Make the artifact with your own tools (a script",
    "  that plots a PNG, an HTML page, a CSV of results) and embed it. A file elsewhere (/tmp, a generated image) embeds by",
    "  its absolute path and shows from there for as long as it exists; the other agents get only the path, so a file they",
    "  should open too belongs in the workspace. Files your turn creates show up under your message too, but an embed puts",
    "  the picture where your words point to it.",
    "- A proposal with --file gets the same live preview on the table — put the mockup or chart on the option it argues for.",
    "Use this when a picture carries the point better than a paragraph; plain text is still the default.",
  ].join("\n");
};

interface DeltaOptions {
  state: RoomState;
  events: RoomEvent[];
  agent: RoomAgent;
  /** Turns left in the current run after this one; null when the run has no limit. */
  turnsLeft: number | null;
  /**
   * The agent's session is new (rejoin): replay its own messages too, including
   * what was said in its previous native session, since this session has none of it.
   */
  replayOwn?: boolean;
  /** What changed in the canonical file since this agent last looked (built by the engine). */
  doc?: string | null;
  /** The human's profile, when it is new to this agent's session (profileUpdate); null otherwise. */
  profile?: string | null;
}

/**
 * A bound on a delta that replays much (a rejoin, an agent back after a long absence), so it cannot eat the
 * context window. Not a tail slice. First the oldest unprotected blocks go. Then, oldest first, an agent message
 * that addresses the reader, objects or moved the table shrinks to a stub: who, that it did so, its table moves
 * in full, and `agoryx read` for the text — the signal outlives the budget, the prose does not. In a two-agent
 * room nearly every message addresses the other, so keeping them whole would leave no bound at all. The human's
 * words, decisions, Agoryx notices and table moves made outside a message stay whole, however old: those alone
 * can still exceed the bound, so it is soft.
 */
export const MAX_DELTA_CHARS = 60_000;

/** The table's display summary clips at 140 chars; stance changes must not lose their qualification. */
const deltaTableOp = (op: TableOp, state: RoomState): string => describeTableOp(op, state.table, { wholeDissent: true });

const fitDelta = (input: string[], kept: Set<number>, stubs: Map<number, string>): string => {
  const blocks = [...input];
  let size = blocks.reduce((sum, block) => sum + block.length + 2, 0);
  const dropped = new Set<number>();
  for (let index = 0; index < blocks.length && size > MAX_DELTA_CHARS; index += 1) {
    if (kept.has(index) || stubs.has(index)) continue;
    dropped.add(index);
    size -= blocks[index]!.length + 2;
  }
  for (let index = 0; index < blocks.length && size > MAX_DELTA_CHARS; index += 1) {
    const stub = stubs.get(index);
    if (stub === undefined || stub.length >= blocks[index]!.length) continue;
    size -= blocks[index]!.length - stub.length;
    blocks[index] = stub;
  }
  if (dropped.size === 0) return blocks.join("\n\n");
  const out: string[] = [];
  let run = 0;
  const flush = () => {
    if (run) out.push(`[… ${run} earlier ${run === 1 ? "entry" : "entries"} omitted to keep this short — \`agoryx read\` lists the messages]`);
    run = 0;
  };
  blocks.forEach((block, index) => {
    if (dropped.has(index)) run += 1;
    else {
      flush();
      out.push(block);
    }
  });
  flush();
  return out.join("\n\n");
};

/** Everything others did since this agent's last turn, rendered as a thin transcript. */
export const buildDelta = ({ state, events, agent, turnsLeft, replayOwn = false, doc = null, profile = null }: DeltaOptions): string => {
  const blocks: string[] = [];
  /** Blocks the length bound never drops. */
  const kept = new Set<number>();
  /** Blocks the length bound may shrink to a stub, never drop. */
  const stubs = new Map<number, string>();
  const opsByTurn = new Map<string, TableOp[]>();
  const filesByTurn = new Map<string, TurnFiles>();
  const passes: string[] = [];

  for (const event of events) {
    if (event.type === "table.op" && event.op.by !== agent.id && event.op.turnId) {
      const list = opsByTurn.get(event.op.turnId) ?? [];
      list.push(event.op);
      opsByTurn.set(event.op.turnId, list);
    }
    if (event.type === "turn.ended" && event.agent !== agent.id && event.files?.length) {
      filesByTurn.set(event.turnId, { agent: event.agent, files: event.files, ...(event.changes ? { changes: event.changes } : {}) });
    }
  }

  // Consecutive table moves made outside any room turn share one block.
  let looseBlock = -1;
  for (const event of events) {
    if (event.type === "table.op" && !event.op.turnId) {
      // By the human directly, or by an agent from its own session. A decision has its own message.
      if (event.op.by === agent.id || event.op.op === "decide") continue;
      const outside = state.agents.some((entry) => entry.id === event.op.by) ? " (in its own session, outside the room)" : "";
      const line = `── ${displayName(state, event.op.by)}${outside} on the table: ${deltaTableOp(event.op, state)}`;
      if (looseBlock >= 0 && looseBlock === blocks.length - 1) blocks[looseBlock] += `\n${line}`;
      else {
        blocks.push(line);
        looseBlock = blocks.length - 1;
      }
      kept.add(looseBlock);
      continue;
    }
    if (event.type === "message.posted") {
      const message = event.message;
      const own = message.author === agent.id || message.native?.agent === agent.id;
      // The agent's own session already holds what it said and what was said to it there.
      if (own && !replayOwn) continue;
      if (message.kind === "pass") {
        // Passing after changing files still changed them.
        const files = message.turnId ? filesByTurn.get(message.turnId) : undefined;
        if (files) {
          blocks.push(`── ${displayName(state, message.author)} · ${clock(event.ts)} · passed, after changing files\n${changedLine(message.turnId!, files)}`);
          filesByTurn.delete(message.turnId!);
        } else if (message.author !== agent.id) passes.push(displayName(state, message.author));
        continue;
      }
      const who = message.author === agent.id ? `You (${agent.label})` : displayName(state, message.author);
      const where = message.native ? nativeWhere(state, message.native.agent, message.author, agent) : "";
      const header =
        message.kind === "system"
          ? `── Agoryx · ${clock(event.ts)}`
          : message.kind === "decision"
            ? `── ${who} · decision · ${clock(event.ts)}`
            : message.kind === "update"
              ? `── ${who} · while working · ${clock(event.ts)}`
              : `── ${who}${where} · ${clock(event.ts)}`;
      const lines = [header, messageGist(message, agent, state.human)];
      if (message.kind === "update") {
        // Said mid-turn: the turn's moves and files go with its reply, which comes later.
        blocks.push(lines.join("\n"));
        continue;
      }
      const ops = message.turnId ? opsByTurn.get(message.turnId) : undefined;
      if (ops) {
        for (const op of ops) lines.push(`   ↳ table: ${deltaTableOp(op, state)}`);
        opsByTurn.delete(message.turnId!);
      }
      const files = message.turnId ? filesByTurn.get(message.turnId) : undefined;
      if (files) {
        lines.push(changedLine(message.turnId!, files));
        filesByTurn.delete(message.turnId!);
      }
      if (message.kind !== "agent" || message.author === state.human) kept.add(blocks.length);
      else {
        const why = [
          ...(parseMentions(message.text, [agent.id]).length ? ["addressed you"] : []),
          ...(DISSENT.test(message.text) ? ["took a stance against something"] : []),
        ];
        if (why.length || ops?.length) {
          const said = why.length ? ` · ${why.join(", ")}` : "";
          stubs.set(blocks.length, [`${header}${said} — shortened for length; the message: agoryx read ${message.id}`, ...lines.slice(2)].join("\n"));
        }
      }
      blocks.push(lines.join("\n"));
    } else if (event.type === "commit.created") {
      blocks.push(`── Agoryx · ${clock(event.ts)}\nworkspace checkpoint ${event.sha.slice(0, 8)}: ${event.subject}`);
    }
  }

  // Table ops made in turns that produced no posted message (pass or error).
  const orphanOps = [...opsByTurn.values()].flat();
  if (orphanOps.length > 0) {
    kept.add(blocks.length);
    blocks.push(orphanOps.map((op) => `── ${displayName(state, op.by)} on the table: ${deltaTableOp(op, state)}`).join("\n"));
  }
  // Turns that changed files but left no message (interrupted, or a pass before this delta).
  for (const [turnId, entry] of filesByTurn) {
    blocks.push(`── ${displayName(state, entry.agent)} · changed files without a message\n${changedLine(turnId, entry)}`);
  }
  if (passes.length > 0) blocks.push(`(${[...new Set(passes)].join(", ")} passed)`);

  let body = fitDelta(blocks, kept, stubs);
  // The file's current state, not a moment in the transcript: it goes last.
  if (doc) body = body ? `${body}\n\n${doc}` : doc;
  // Who the human is, before what they and the others said: given once per version, never repeated.
  if (profile) body = body ? `${profile}\n\n${body}` : profile;

  const footer: string[] = [];
  const table = summarizeTable(state.table);
  if (table) footer.push(`The table now (\`agoryx table show\` for bodies and notes):\n${table}`);
  if (turnsLeft !== null) {
    footer.push(
      turnsLeft <= 0
        ? `This is the last agent turn of this run. If the room is not in a clear state yet, leave it clear; if it already is, ${PASS_TOKEN}.`
        : `Turns left in this run after yours: ${turnsLeft}.`,
    );
  }
  footer.push(`Reply to the room, or ${PASS_TOKEN} if you would only acknowledge, thank or repeat.`);

  return [`[agoryx · ${state.name} · new since your last turn]`, "", body || "(nothing new — you were asked to continue)", "", footer.join("\n")].join("\n");
};

/** " → Claude, in Claude's own session" for a human line; " (in its own session)" for the agent's reply. */
const nativeWhere = (state: RoomState, source: string, author: string, reader: RoomAgent): string => {
  const label = source === reader.id ? "you" : displayName(state, source);
  if (author === source) return source === reader.id ? " (in your previous session, outside the room)" : " (in its own session, outside the room)";
  return source === reader.id
    ? " → you, in your previous session (outside the room)"
    : ` → ${label}, directly in ${label}'s own session (outside the room)`;
};

export const buildTurnPrompt = (
  input: BriefingInput & { events: RoomEvent[]; turnsLeft: number | null; fresh: boolean; rejoin: boolean; doc?: string | null },
): string => {
  const delta = buildDelta({
    state: input.state,
    events: input.events,
    agent: input.agent,
    turnsLeft: input.turnsLeft,
    replayOwn: input.rejoin,
    doc: input.doc ?? null,
    // A fresh session has it in the briefing.
    profile: input.fresh ? null : (input.profile ?? null),
  });
  if (!input.fresh) return delta;
  const intro = input.rejoin
    ? "Your previous session for this room could not be resumed, so here is the room context again, followed by the conversation so far."
    : "Here is the conversation so far.";
  return `${buildBriefing(input)}\n\n${intro}\n\n${delta}`;
};

const MENTION = /(^|[^\w@])@([a-z][\w-]{1,31})/gi;

export const parseMentions = (text: string, handles: string[]): string[] => {
  const known = new Set(handles.map((handle) => handle.toLowerCase()));
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const handle = match[2]!.toLowerCase();
    if (known.has(handle) || handle === "all") found.add(handle);
  }
  return [...found];
};
