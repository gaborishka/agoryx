import { PASS_RESPONSE_TOKEN } from "../events/pass-token.js";
import { describeTableOp, summarizeTable } from "./table.js";
import type { RoomAgent, RoomEvent, RoomState, TableOp } from "./types.js";

const MAX_MESSAGE_CHARS = 12_000;
const MAX_DELTA_CHARS = 60_000;

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
  return handle;
};

const clip = (text: string, max = MAX_MESSAGE_CHARS): string =>
  text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more chars — full text in the room log]` : text;

export interface BriefingInput {
  state: RoomState;
  agent: RoomAgent;
  /** How agents invoke the room tools; `path` is the absolute fallback if PATH is reset. */
  agentCli: { command: string; path?: string };
}

/**
 * First-turn context. Deliberately no role: who is here, where the work lives,
 * how turns and passing work, and how to use the table.
 */
export const buildBriefing = ({ state, agent, agentCli: cli }: BriefingInput): string => {
  const agentCli = cli.command;
  const others = state.agents.filter((entry) => entry.id !== agent.id);
  const peers = others.map((entry) => `${entry.label} (@${entry.id})`).join(", ");
  const access =
    state.settings.access === "readonly"
      ? "You can read the workspace; writes are disabled in this room."
      : "You can read, create and run anything inside the workspace (sandboxed).";
  return [
    `You are ${agent.label}, in an Agoryx room — one shared conversation between ${state.human} (human, @${state.human.toLowerCase()}) and ${peers || "no other agents yet"}.`,
    "Nobody here has an assigned role. Act as yourself, with everything you can do: read and write code, run things, research, draw, write, argue.",
    "",
    `Room: "${state.name}"`,
    `Workspace: ${state.workspace}`,
    `  A shared git directory — everyone works here. ${access}`,
    "  Others may edit files at the same time: check `git status` / `git diff` before overwriting, and say which files you touched.",
    "",
    "How the room works:",
    "- Each turn you get only what is new since your last turn. Your final message is posted to the room; your tool calls show up to others as a short activity trace.",
    "- When the human writes, agents answer in parallel without seeing each other first — give your own independent view, not a guess at the consensus.",
    `- Nothing substantive to add? Reply exactly ${PASS_TOKEN} and nothing else. Silence is fine; agreeing for politeness is noise.`,
    "- Disagree when you disagree, and say what would change your mind. An unresolved disagreement, stated clearly, is a valid outcome.",
    `- Address someone with @name. ${state.human} is a participant, not a gatekeeper: you don't need permission to do the work being discussed.`,
    "- Each run has a turn budget; the prompt says how many turns remain. Converge or leave a clear state before it runs out.",
    "- Reply in the language the human writes in.",
    "",
    "The table — shared structure for decisions with real alternatives (use it when it helps; plain conversation is fine otherwise):",
    `  ${agentCli} table ask "question"`,
    `  ${agentCli} table propose "short title" --body "what and why" [--file path/in/workspace] [--q Q1]`,
    `  ${agentCli} table object P1 "reason"   |   support P1 "reason"   |   evidence P1 "finding" --source <url|path>`,
    `  ${agentCli} table settle "what is now established"   |   next "concrete next step"   |   done X1`,
    `  ${agentCli} table decide P1 --note "why"   (when the room has actually converged, or the human asked you to decide)`,
    `  ${agentCli} table show`,
    "  Proposals with --file get a live preview (html, svg, images, markdown, code).",
    ...(cli.path
      ? [
          `  If \`${agentCli}\` is missing or says "Unknown command 'table'" (another install earlier on PATH), use "$AGORYX_CLI" table … — it always points at ${cli.path}`,
        ]
      : []),
  ].join("\n");
};

interface DeltaOptions {
  state: RoomState;
  events: RoomEvent[];
  agent: RoomAgent;
  /** Turns left in the current run after this one. */
  turnsLeft: number;
}

/** Everything others did since this agent's last turn, rendered as a thin transcript. */
export const buildDelta = ({ state, events, agent, turnsLeft }: DeltaOptions): string => {
  const blocks: string[] = [];
  const opsByTurn = new Map<string, TableOp[]>();
  const looseOps: TableOp[] = [];
  const filesByTurn = new Map<string, string[]>();
  const passes: string[] = [];

  for (const event of events) {
    if (event.type === "table.op" && event.op.by !== agent.id) {
      if (event.op.turnId) {
        const list = opsByTurn.get(event.op.turnId) ?? [];
        list.push(event.op);
        opsByTurn.set(event.op.turnId, list);
      } else {
        looseOps.push(event.op);
      }
    }
    if (event.type === "turn.ended" && event.agent !== agent.id && event.files?.length) {
      filesByTurn.set(event.turnId, event.files);
    }
  }

  for (const event of events) {
    if (event.type === "message.posted") {
      const message = event.message;
      if (message.author === agent.id) continue;
      if (message.kind === "pass") {
        passes.push(displayName(state, message.author));
        continue;
      }
      const header =
        message.kind === "system"
          ? `── Agoryx · ${clock(event.ts)}`
          : message.kind === "decision"
            ? `── ${displayName(state, message.author)} · decision · ${clock(event.ts)}`
            : `── ${displayName(state, message.author)} · ${clock(event.ts)}`;
      const lines = [header, clip(message.text.trim())];
      const ops = message.turnId ? opsByTurn.get(message.turnId) : undefined;
      if (ops) {
        for (const op of ops) lines.push(`   ↳ table: ${describeTableOp(op, state.table)}`);
        opsByTurn.delete(message.turnId!);
      }
      const files = message.turnId ? filesByTurn.get(message.turnId) : undefined;
      if (files) {
        lines.push(`   ↳ changed: ${files.slice(0, 20).join(", ")}${files.length > 20 ? ` (+${files.length - 20} more)` : ""}`);
        filesByTurn.delete(message.turnId!);
      }
      blocks.push(lines.join("\n"));
    } else if (event.type === "commit.created") {
      blocks.push(`── Agoryx · ${clock(event.ts)}\nworkspace checkpoint ${event.sha.slice(0, 8)}: ${event.subject}`);
    }
  }

  // Table ops made in turns that produced no posted message (pass or error), or by the human directly.
  const orphanOps = [...looseOps, ...[...opsByTurn.values()].flat()];
  if (orphanOps.length > 0) {
    blocks.push(orphanOps.map((op) => `── ${displayName(state, op.by)} on the table: ${describeTableOp(op, state.table)}`).join("\n"));
  }
  if (passes.length > 0) blocks.push(`(${[...new Set(passes)].join(", ")} passed)`);

  let body = blocks.join("\n\n");
  if (body.length > MAX_DELTA_CHARS) {
    body = `[… earlier part of the conversation omitted — ${body.length - MAX_DELTA_CHARS} chars]\n${body.slice(-MAX_DELTA_CHARS)}`;
  }

  const footer: string[] = [];
  const table = summarizeTable(state.table);
  if (table) footer.push(`Table — ${table} (\`agoryx table show\` for details)`);
  footer.push(
    turnsLeft <= 0
      ? "This is the last agent turn of this run — leave the room in a clear state."
      : `Turns left in this run after yours: ${turnsLeft}.`,
  );
  footer.push(`Reply to the room, or ${PASS_TOKEN}.`);

  return [`[agoryx · ${state.name} · new since your last turn]`, "", body || "(nothing new — you were asked to continue)", "", footer.join("\n")].join("\n");
};

export const buildTurnPrompt = (
  input: BriefingInput & { events: RoomEvent[]; turnsLeft: number; fresh: boolean; rejoin: boolean },
): string => {
  const delta = buildDelta({ state: input.state, events: input.events, agent: input.agent, turnsLeft: input.turnsLeft });
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
