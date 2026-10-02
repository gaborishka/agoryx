import type { CSSProperties } from "react";
import { type AgentLook, agentLook } from "../../../internal/agora/look";
import { unquoted } from "../../../internal/agora/quote";
import { names as nameList } from "./format";
import type { ActorOrigin, DocRevision, MessageEntry, RoomAgent, RoomState, RoomSummary, TableItem, TableOp, TurnState } from "./types";
import type { OpEntry } from "./types";

export type Tone = "claude" | "codex" | "human" | "sys";

export interface Participant {
  id: string;
  label: string;
  tone: Tone;
  agent: boolean;
  kind?: "claude" | "codex";
  /** Only for an agent that shares its kind with another in the room: its own shade (0–7) of the kind's colour… */
  shade?: number;
  /** …and the character on its avatar ("O" for Opus next to "S" for Sonnet). */
  mark?: string;
}

/** Who a room seats when nobody chose otherwise; the server's own default (GET /api/info `agents`) wins when known. */
export const DEFAULT_AGENTS: RoomAgent[] = [
  { id: "claude", kind: "claude", label: "Claude" },
  { id: "codex", kind: "codex", label: "Codex" },
];

/** What a handle is looked up in: a room, or just a roster (the start screen, before there is a room). */
export type Seating = { agents: RoomAgent[]; human?: string; guests?: Record<string, ActorOrigin>; former?: RoomAgent[] };

/**
 * An agent is whoever the room's roster says it is — never a kind. "claude" or "codex" is an agent
 * only if an agent has that id: in a room of Opus and Sonnet, "@claude" is nobody.
 */
export const participant = (room: Seating | undefined, handle: string): Participant => {
  const agent = room?.agents.find((a) => a.id === handle);
  if (agent) {
    const look = agentLook(room!.agents, agent.id);
    return {
      id: agent.id,
      label: agent.label,
      tone: agent.kind === "codex" ? "codex" : "claude",
      agent: true,
      kind: agent.kind,
      ...(look?.mark ? { shade: look.shade, mark: look.mark } : {}),
    };
  }
  if (handle === "agoryx") return { id: handle, label: "Agoryx", tone: "sys", agent: false };
  // An agent that left the room: its messages keep its name and colour.
  const gone = room?.former?.find((a) => a.id === handle);
  if (gone) return { id: gone.id, label: gone.label, tone: gone.kind === "codex" ? "codex" : "claude", agent: true, kind: gone.kind };
  // An agent of another room that acted here with its own key: named with its room, never taken for one of ours.
  const guest = room?.guests?.[handle];
  if (guest) return { id: handle, label: `${guest.label} (from the room “${guest.roomName}”)`, tone: guest.kind, agent: false, kind: guest.kind };
  // Another room sharing the directory, named in a revision whose author is not known (room "B").
  const other = /^room "(.+)"$/.exec(handle);
  if (other) return { id: handle, label: `room “${other[1]}”`, tone: "sys", agent: false };
  return { id: handle, label: handle === room?.human ? "You" : handle, tone: "human", agent: false };
};

/**
 * The inline style that turns the kind's colour into this agent's shade of it: the element's own
 * --claude/--codex (and -soft) point at the shade, so every tone class on it — text, background,
 * ring, border, /opacity — follows. Nothing for an agent alone of its kind: it keeps the kind's
 * colour exactly. Put it only on the element that carries the tone (custom properties inherit).
 */
export const ink = (who: Pick<Participant, "kind" | "shade" | "mark"> | Pick<AgentLook, "kind" | "shade" | "mark"> | undefined): CSSProperties | undefined => {
  if (!who?.kind || !who.mark || who.shade === undefined) return undefined;
  return { [`--${who.kind}`]: `var(--${who.kind}-${who.shade})`, [`--${who.kind}-soft`]: `var(--${who.kind}-soft-${who.shade})` } as CSSProperties;
};

/** The agent's colour itself, for a property no tone class covers (a card's left band). */
export const inkColor = (who: Pick<Participant, "kind" | "shade" | "mark"> | undefined): string | undefined =>
  who?.kind && who.mark && who.shade !== undefined ? `var(--${who.kind}-${who.shade})` : undefined;

/**
 * The room list's last line after a live message: the same shape the daemon's summary gives
 * (the author's label and, next to another of its kind, its look), so an agent's line is not
 * put on "You" until the next reload.
 */
export const lastLine = (room: RoomState, m: Pick<MessageEntry, "author" | "text" | "sys">): NonNullable<RoomSummary["lastMessage"]> => {
  const agent = room.agents.find((a) => a.id === m.author);
  const look = agent ? agentLook(room.agents, agent.id) : undefined;
  return {
    author: m.author,
    text: unquoted(m.text).slice(0, 200),
    ...(agent ? { label: agent.label } : {}),
    ...(look?.mark ? { look } : {}),
    ...(m.sys ? { sys: m.sys } : {}),
  };
};

/** Whether an agent is given the human's profile — for its tooltip. Null when there is no profile to give. */
export const profileLine = (agent: Pick<RoomAgent, "profile">, profile: { exists: boolean } | undefined): string | null =>
  !profile?.exists
    ? null
    : agent.profile === false
      ? "Your profile is turned off for this agent (\"profile\": false in the roster): not a word of it goes into its prompts. The agent can still read the file itself with its own tools."
      : "Sees your profile (profile.md) — as context about you, not as part of the conversation.";

export const nameOf = (room: RoomState | undefined, handle: string) => {
  const p = participant(room, handle);
  return p.tone === "human" && handle === room?.human ? handle : p.label;
};

export const toneText: Record<Tone, string> = {
  claude: "text-claude",
  codex: "text-codex",
  human: "text-human",
  sys: "text-muted-foreground",
};

export type FeedItem =
  | { key: string; seq: number; type: "msg"; m: MessageEntry }
  | { key: string; seq: number; type: "commit"; c: RoomState["commits"][number] }
  /** Steps their author or the human committed: one line per commit. */
  | { key: string; seq: number; type: "step"; sha: string; by: string; steps: TableItem[] }
  | { key: string; seq: number; type: "revert"; r: RoomState["reverts"][number] }
  | { key: string; seq: number; type: "op"; op: TableOp }
  | { key: string; seq: number; type: "doc"; r: DocRevision };

export type FeedRow =
  | FeedItem
  | { key: string; type: "group"; text: string; title: string; first: boolean; items: Array<Extract<FeedItem, { type: "msg" }>> }
  | { key: string; type: "hello" };

export interface FeedModel {
  turns: Map<string, TurnState>;
  opsByTurn: Map<string, TableOp[]>;
  docByTurn: Map<string, DocRevision[]>;
  rows: FeedRow[];
  live: TurnState[];
  liveDivider: string | null;
}

const replyTurn = (item: FeedItem | undefined, turns: Map<string, TurnState>) => {
  if (item?.type !== "msg" || (item.m.kind !== "agent" && item.m.kind !== "pass") || !item.m.turnId) return null;
  return turns.get(item.m.turnId) ?? null;
};

export const buildFeed = (st: RoomState, ops: OpEntry[]): FeedModel => {
  const turns = new Map(st.turns.map((t) => [t.id, t]));
  const withMessage = new Set(st.messages.filter((m) => m.turnId && m.kind !== "update").map((m) => m.turnId!));
  const opsByTurn = new Map<string, TableOp[]>();
  const items: FeedItem[] = [];
  for (const entry of ops) {
    const o = entry.op;
    const turn = o.turnId ? turns.get(o.turnId) : undefined;
    if (o.turnId && (withMessage.has(o.turnId) || turn?.status === "running")) {
      const list = opsByTurn.get(o.turnId) ?? [];
      list.push(o);
      opsByTurn.set(o.turnId, list);
    } else if (o.op !== "decide") {
      items.push({ key: `o-${entry.seq}`, seq: entry.seq, type: "op", op: o });
    }
  }
  const docByTurn = new Map<string, DocRevision[]>();
  for (const r of st.docRevisions ?? []) {
    if (r.by === "agoryx") continue;
    if (r.turnId && withMessage.has(r.turnId)) {
      const list = docByTurn.get(r.turnId) ?? [];
      list.push(r);
      docByTurn.set(r.turnId, list);
    } else items.push({ key: `d-${r.seq}`, seq: r.seq, type: "doc", r });
  }
  for (const m of st.messages) items.push({ key: `m-${m.id}`, seq: m.seq, type: "msg", m });
  for (const c of st.commits) items.push({ key: `c-${c.sha}`, seq: c.seq, type: "commit", c });
  // A checkpoint names the steps it took on its own line.
  const stepCommits = new Map<string, Extract<FeedItem, { type: "step" }>>();
  for (const n of st.table.next) {
    if (!n.commit || n.commit.by === "agoryx") continue;
    const line = stepCommits.get(n.commit.sha) ?? { key: `s-${n.commit.sha}`, seq: n.commit.seq, type: "step", sha: n.commit.sha, by: n.commit.by, steps: [] };
    line.steps.push(n);
    stepCommits.set(n.commit.sha, line);
  }
  items.push(...stepCommits.values());
  for (const r of st.reverts ?? []) items.push({ key: `v-${r.seq}`, seq: r.seq, type: "revert", r });
  items.sort((a, b) => a.seq - b.seq);

  const name = (h: string) => nameOf(st, h);
  const rows: FeedRow[] = [];
  if (!st.messages.length && !st.turns.length) rows.push({ key: "hello", type: "hello" });
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const first = replyTurn(item, turns);
    if (first && item.type === "msg") {
      // Replies written at the same moment: each saw the others only in what they said while working.
      const group: Array<Extract<FeedItem, { type: "msg" }>> = [item];
      // What someone said while still working does not end the moment: it goes just before the group.
      const said: FeedItem[] = [];
      const agents = new Set([item.m.author]);
      let j = i + 1;
      for (let k = j; ; k += 1) {
        const next = items[k];
        if (next?.type === "msg" && next.m.kind === "update") continue;
        const t = replyTurn(next, turns);
        if (!t || next?.type !== "msg" || t.cursor >= item.m.seq || agents.has(next.m.author)) break;
        agents.add(next.m.author);
        said.push(...items.slice(j, k));
        group.push(next);
        j = k + 1;
      }
      if (group.length > 1 && group.some((g) => g.m.kind === "agent")) {
        const prev = st.messages.filter((m) => m.seq < item.m.seq && m.kind !== "system" && m.kind !== "update").at(-1);
        const names = nameList(group.map((g) => name(g.m.author)));
        rows.push(...said);
        rows.push(
          prev?.kind === "human"
            ? {
                key: `g-${item.m.id}`,
                type: "group",
                items: group,
                first: true,
                text: `${names} started at the same time from your message`,
                title:
                  "The first replies to your message: the agents started from the same point and worked in parallel. Of each other’s work they saw only what appeared in the room along the way (agoryx say, agoryx read new).",
              }
            : {
                key: `g-${item.m.id}`,
                type: "group",
                items: group,
                first: false,
                text: `${names} wrote at the same time`,
                title: "These replies were written in parallel: the agents saw everything before them, but of each other’s work only what appeared in the room along the way.",
              },
        );
        i = j - 1;
        continue;
      }
    }
    rows.push(item);
  }
  const live = st.turns.filter((turn) => turn.status === "running");
  let liveDivider: string | null = null;
  if (live.length > 1) {
    const prev = st.messages.filter((m) => m.kind !== "system" && m.kind !== "update").at(-1);
    if (prev?.kind === "human") liveDivider = `${nameList(live.map((t) => name(t.agent)))} are working at the same time`;
  }
  return { turns, opsByTurn, docByTurn, rows, live, liveDivider };
};

/** Open items on the table: questions still open + options without a question. */
export const tableCount = (st: RoomState) =>
  st.table.questions.filter((q) => q.status === "open").length + st.table.options.filter((o) => !o.q && o.status === "open").length;

export const refExists = (st: RoomState, ref: string) => {
  const t = st.table;
  const k = ref[0];
  if (k === "Q") return t.questions.some((x) => x.id === ref);
  if (k === "P") return t.options.some((x) => x.id === ref);
  if (k === "D") return t.decisions.some((x) => x.id === ref);
  if (k === "N") return t.notes.some((x) => x.id === ref);
  if (k === "F") return t.facts.some((x) => x.id === ref);
  if (k === "S") return t.settled.some((x) => x.id === ref);
  if (k === "X") return t.next.some((x) => x.id === ref);
  if (k === "C") return (t.shifts ?? []).some((x) => x.id === ref);
  return false;
};

/** The table element id a ref scrolls to (notes and decisions point at their option). */
export const refAnchor = (st: RoomState, ref: string) => {
  if (ref.startsWith("Q")) return `q-${ref}`;
  if (ref.startsWith("P")) return `opt-${ref}`;
  if (ref.startsWith("N")) {
    const note = st.table.notes.find((n) => n.id === ref);
    return note ? `opt-${note.target}` : null;
  }
  if (ref.startsWith("D")) {
    const d = st.table.decisions.find((x) => x.id === ref);
    return d ? `opt-${d.option}` : null;
  }
  return `ti-${ref}`;
};
