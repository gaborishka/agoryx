import type { DocRevision, MessageEntry, RoomState, TableOp, TurnState } from "./types";
import type { OpEntry } from "./types";

export type Tone = "claude" | "codex" | "human" | "sys";

export interface Participant {
  id: string;
  label: string;
  tone: Tone;
  agent: boolean;
  kind?: "claude" | "codex";
}

const KNOWN_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

export const participant = (room: RoomState | undefined, handle: string): Participant => {
  const agent = room?.agents.find((a) => a.id === handle);
  if (agent) return { id: agent.id, label: agent.label, tone: agent.kind === "codex" ? "codex" : "claude", agent: true, kind: agent.kind };
  if (handle === "agoryx") return { id: handle, label: "Agoryx", tone: "sys", agent: false };
  if (KNOWN_LABEL[handle]) return { id: handle, label: KNOWN_LABEL[handle]!, tone: handle === "codex" ? "codex" : "claude", agent: true, kind: handle as "claude" | "codex" };
  return { id: handle, label: handle === room?.human ? "Ви" : handle, tone: "human", agent: false };
};

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
  | { key: string; seq: number; type: "op"; op: TableOp }
  | { key: string; seq: number; type: "doc"; r: DocRevision };

export type FeedRow =
  | FeedItem
  | { key: string; type: "group"; text: string; title: string; blind: boolean; items: Array<Extract<FeedItem, { type: "msg" }>> }
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
  const withMessage = new Set(st.messages.filter((m) => m.turnId).map((m) => m.turnId!));
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
  items.sort((a, b) => a.seq - b.seq);

  const name = (h: string) => nameOf(st, h);
  const rows: FeedRow[] = [];
  if (!st.messages.length && !st.turns.length) rows.push({ key: "hello", type: "hello" });
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const first = replyTurn(item, turns);
    if (first && item.type === "msg") {
      // Replies written at the same moment: none of them saw the others.
      const group: Array<Extract<FeedItem, { type: "msg" }>> = [item];
      const agents = new Set([item.m.author]);
      let j = i + 1;
      for (;;) {
        const next = items[j];
        const t = replyTurn(next, turns);
        if (!t || next?.type !== "msg" || t.cursor >= item.m.seq || agents.has(next.m.author)) break;
        agents.add(next.m.author);
        group.push(next);
        j += 1;
      }
      if (group.length > 1 && group.some((g) => g.m.kind === "agent")) {
        const prev = st.messages.filter((m) => m.seq < item.m.seq && m.kind !== "system").at(-1);
        const names = group.map((g) => name(g.m.author)).join(" і ");
        rows.push(
          prev?.kind === "human"
            ? {
                key: `g-${item.m.id}`,
                type: "group",
                items: group,
                blind: true,
                text: `${names} відповіли, не бачачи одне одного`,
                title: "Перша відповідь на ваше повідомлення: агенти писали одночасно й не бачили відповідей одне одного — щоб думки були незалежні.",
              }
            : {
                key: `g-${item.m.id}`,
                type: "group",
                items: group,
                blind: false,
                text: `${names} писали одночасно`,
                title: "Ці відповіді писалися одночасно: кожен бачив попередні репліки, але не цю відповідь іншого.",
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
    const prev = st.messages.filter((m) => m.kind !== "system").at(-1);
    if (prev?.kind === "human") liveDivider = `${live.map((t) => name(t.agent)).join(" і ")} відповідають, не бачачи одне одного`;
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
  if (k === "N") return t.next.some((x) => x.id === ref);
  if (k === "F") return t.facts.some((x) => x.id === ref);
  if (k === "S") return t.settled.some((x) => x.id === ref);
  if (k === "X") return t.notes.some((x) => x.id === ref);
  return false;
};

/** The table element id a ref scrolls to (notes and decisions point at their option). */
export const refAnchor = (st: RoomState, ref: string) => {
  if (ref.startsWith("Q")) return `q-${ref}`;
  if (ref.startsWith("P")) return `opt-${ref}`;
  if (ref.startsWith("X")) {
    const note = st.table.notes.find((n) => n.id === ref);
    return note ? `opt-${note.target}` : null;
  }
  if (ref.startsWith("D")) {
    const d = st.table.decisions.find((x) => x.id === ref);
    return d ? `opt-${d.option}` : null;
  }
  return `ti-${ref}`;
};
