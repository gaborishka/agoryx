import type { CSSProperties } from "react";
import { type AgentLook, agentLook } from "../../../internal/agora/look";
import { unquoted } from "../../../internal/agora/quote";
import { names as nameList, VISUAL_EXT } from "./format";
import type { ActorOrigin, DocRevision, MessageEntry, PrState, RoomAgent, RoomState, RoomSummary, TableItem, TableOp, TurnState } from "./types";
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
  | { key: string; seq: number; type: "doc"; r: DocRevision }
  | { key: string; seq: number; type: "pr"; pr: PrState };

export type FeedRow =
  | FeedItem
  | { key: string; type: "group"; text: string; title: string; first: boolean; items: Array<Extract<FeedItem, { type: "msg" }>> }
  /** Agents writing to each other, folded into one line: who, how many messages, the table items they were about. */
  | { key: string; type: "between"; items: Array<Extract<FeedItem, { type: "msg" }>>; agents: string[]; refs: string[] }
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
  for (const pr of st.prs ?? []) items.push({ key: `pr-${pr.repo}#${pr.number}`, seq: pr.seq, type: "pr", pr });
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
  // The turns whose replies show what they did beside them: table moves, file revisions, changed files.
  const shown = new Set([...opsByTurn.keys(), ...docByTurn.keys(), ...st.turns.filter((t) => t.files?.length || t.changes?.length).map((t) => t.id)]);
  return { turns, opsByTurn, docByTurn, rows: foldBetween(st, rows, shown), live, liveDivider };
};

/** Whether a message shows something to look at: an image, a diagram, a page, a table or a recording. */
const showsMedia = (text: string) =>
  /!\[|```(?:mermaid|html?|svg)\b/i.test(text) || [...text.matchAll(/\.([a-z0-9]{2,8})\b/gi)].some((x) => VISUAL_EXT.has(x[1]!.toLowerCase()));

// The human's name as agents write it in Cyrillic: Ivan is Іван or Иван. A simple transliteration, not a dictionary.
const DIGRAPHS: Record<string, string[]> = { shch: ["щ"], sh: ["ш"], ch: ["ч"], zh: ["ж"], kh: ["х"], ts: ["ц"], ya: ["я"], ia: ["я"], yu: ["ю"], iu: ["ю"], ye: ["є", "е"], yi: ["ї"] };
const LETTERS: Record<string, string[]> = {
  a: ["а"], b: ["б"], c: ["ц", "к", "с"], d: ["д"], e: ["е", "є", "э"], f: ["ф"], g: ["г", "ґ"], h: ["х", "г"], i: ["і", "и", "ї", "й"], j: ["й", "ж"],
  k: ["к"], l: ["л"], m: ["м"], n: ["н"], o: ["о"], p: ["п"], q: ["к"], r: ["р"], s: ["с"], t: ["т"], u: ["у", "ю"], v: ["в"], w: ["в"], x: ["х"],
  y: ["и", "й", "і"], z: ["з"],
};
const spellings = (name: string): string[] => {
  const out = new Set<string>([name]);
  const walk = (at: number, built: string) => {
    if (out.size > 64) return;
    if (at >= name.length) {
      out.add(built);
      return;
    }
    for (const [latin, cyr] of Object.entries(DIGRAPHS)) if (name.startsWith(latin, at)) for (const c of cyr) walk(at + latin.length, built + c);
    for (const c of LETTERS[name[at]!] ?? [name[at]!]) walk(at + 1, built + c);
  };
  if (/^[a-z]{2,20}$/.test(name)) walk(0, "");
  return [...out];
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Text as said: no code, no quoted lines, no emphasis marks. */
const said = (text: string) =>
  text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    // Emphasis marks, not the underscores of a name (ivan_h).
    .replace(/\*|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "");

/**
 * A Ukrainian name in its vocative, the form one calls someone by: Іван → Іване, Олена → Олено, Марія → Маріє, Петро →
 * Петре, Андрій → Андрію, Василь → Василю, Олег → Олеже or Олегу. A rule of thumb, not a dictionary.
 */
const vocatives = (name: string): string[] => {
  const stem = name.slice(0, -1);
  const last = name.at(-1)!;
  if (last === "а") return [`${stem}о`];
  if (last === "я") return [`${stem}є`];
  if (last === "о") return [`${stem}е`];
  if (last === "й" || last === "ь") return [`${stem}ю`];
  const soft: Record<string, string> = { г: "ж", к: "ч", х: "ш" };
  if (soft[last]) return [`${stem}${soft[last]}е`, `${name}у`];
  return /[бвґджзлмнпрстфцчшщ]/.test(last) ? [`${name}е`] : [];
};

/** What speaks to a human, per human: built once (see toHuman). */
const addresses = new Map<string, RegExp>();
const addressOf = (human: string): RegExp => {
  const known = addresses.get(human);
  if (known) return known;
  const bare = spellings(human);
  // Called by name in Cyrillic, when the name is four letters or more ("Саме," is not Sam's, "дане" not Dan's).
  const called = [...human].length >= 4 ? [...new Set(bare.filter((s) => /^\p{Script=Cyrillic}+$/u.test(s)).flatMap(vocatives))] : [];
  const word = `(?<![\\p{L}\\p{N}_@])(?:${[...bare, ...called].map(escape).join("|")})(?![\\p{L}\\p{N}_])`;
  const address = new RegExp(
    [
      // An @mention the message's mentions do not carry: a pass's note.
      `(?<![\\p{L}\\p{N}_])@${escape(human)}(?![\\p{L}\\p{N}_-])`,
      `${word}[\\p{Zs}\\t]*(?:[,:!?]|[—–]|-[\\p{Zs}\\t])`,
      // A full stop, not a file's ("Ivan.md").
      `^[\\p{Zs}\\t]*${word}\\.(?![\\p{L}\\p{N}_])`,
      `,[\\p{Zs}\\t]*${word}[\\p{Zs}\\t]*(?:\\.(?![\\p{L}\\p{N}_])|[…!?]|$)`,
      ...(called.length ? [`(?<![\\p{L}\\p{N}_@])(?:${called.map(escape).join("|")})(?![\\p{L}\\p{N}_])`] : []),
    ].join("|"),
    "imu",
  );
  if (addresses.size >= 8) addresses.clear();
  addresses.set(human, address);
  return address;
};

/**
 * Whether a message speaks to the human, so it is not folded away among the agents' messages: it @mentions them, or
 * calls them by name — the name followed on its line by a comma, a colon, a dash, "!" or "?" ("Ivan, …", "**Ivan**: …",
 * "Ivan — …", "Маєш рацію, Іване, …", "Що скажеш, Іване?"), opening a line with a full stop ("Ivan. Which one?"), or
 * after a comma at the end of a sentence ("Your call on P3, Ivan.", "Дякую, Іване."); a Ukrainian name of four letters or
 * more in its vocative ("Іване", "Олено") wherever it is. The name as it is or in its vocative, no other ending ("з
 * Іваном, …" and "Same," are not; "Al" is not "Also,"). It errs towards the human: a message it takes as theirs stays in
 * sight.
 */
export const toHuman = (st: Pick<RoomState, "human">, m: Pick<MessageEntry, "text" | "mentions">): boolean => {
  const human = st.human.toLowerCase();
  return m.mentions.includes(human) || addressOf(human).test(said(m.text));
};

/**
 * A message one agent wrote to others: an update (agoryx say, mid-turn) or a reply that @mentions only other agents and
 * does not speak to the human. Not one: a message that shows an image or another file to look at, or a reply whose turn
 * changed the table or a file the room shows with it (`shown`: the turns whose replies carry those). The room also keeps
 * in sight a reply to the human's message (see foldBetween), whomever it @mentions.
 */
export const betweenAgents = (st: Pick<RoomState, "agents" | "former" | "human">, m: MessageEntry, shown?: ReadonlySet<string>): boolean => {
  if (m.kind !== "update" && m.kind !== "agent") return false;
  if (m.kind === "agent" && m.turnId && shown?.has(m.turnId)) return false;
  // An agent sent out of the room since still wrote what it wrote.
  const ids = new Set([...st.agents, ...(st.former ?? [])].map((a) => a.id));
  if (!ids.has(m.author)) return false;
  const to = m.mentions.filter((h) => h !== m.author);
  return to.length > 0 && to.every((h) => ids.has(h)) && !toHuman(st, m) && !showsMedia(m.text);
};

const REF = /\b([QPDNXSFC]\d{1,3})\b/g;

/** The human's own word: a message of theirs (under whatever name they had then), or their decision on the table. */
const byHuman = (st: Pick<RoomState, "human">, m: MessageEntry): boolean =>
  m.kind === "human" || (m.kind === "decision" && m.author.toLowerCase() === st.human.toLowerCase());

/**
 * Whether the human's message was to an agent, as the room wakes agents for it (internal/agora/wakes.ts): to it, to all,
 * or to no agent by name (an @mention of someone else is not an agent's); not one said before it was seated (for reading,
 * not answering), nor one said in an agent's own session unless it names this one (that session's agent answered it
 * there).
 */
const toAgent = (st: Pick<RoomState, "joined" | "agents">, h: MessageEntry, agent: string): boolean => {
  if (h.seq <= (st.joined?.[agent] ?? 0)) return false;
  if (h.native) return h.native.agent !== agent && (h.mentions.includes("all") || h.mentions.includes(agent));
  const to = h.mentions.filter((handle) => handle === "all" || st.agents.some((a) => a.id === handle));
  return !to.length || to.includes(agent) || to.includes("all");
};

/**
 * Two or more messages in a row between agents become one folded row; the human opens it when they want the exchange. An
 * agent's pass among them does not end it, unless its turn did something the room shows (a move on the table, a file).
 * While the agents are at work (a run, or a turn), the exchange at the end of the room stays open: the human may be
 * reading it as it comes, and it does not fold and open again between one turn and the next (nor for a file a running
 * turn revised, shown on its own until its reply comes, at the end or among the messages: it goes after the fold). It
 * folds once something else follows, or the run ends.
 */
const foldBetween = (st: RoomState, rows: FeedRow[], shown: ReadonlySet<string>): FeedRow[] => {
  const out: FeedRow[] = [];
  const running = new Set(st.turns.filter((turn) => turn.status === "running").map((turn) => turn.id));
  const live = running.size > 0 || st.runs.some((run) => run.status === "active");
  // A reply to the human's message, whomever else it asks ("Yes, it is safe. @codex can you check?"): the reply right
  // after it, or one whose turn read it when it was to that agent or to all (an agent's `table decide` is not the human's).
  // The human's messages in order, and for a turn whether it read one to its agent (between its cursors).
  const heard = st.messages.filter((m) => byHuman(st, m));
  const firstAfter = (seq: number) => {
    let lo = 0;
    let hi = heard.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (heard[mid]!.seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const readByTurn = new Map<string, boolean>();
  const read = (turn: TurnState) => {
    let known = readByTurn.get(turn.id);
    if (known === undefined) {
      known = false;
      for (let k = firstAfter(turn.cursorBefore); k < heard.length && heard[k]!.seq <= turn.cursor && !known; k += 1) known = toAgent(st, heard[k]!, turn.agent);
      readByTurn.set(turn.id, known);
    }
    return known;
  };
  const turns = new Map(st.turns.map((turn) => [turn.id, turn]));
  const answers = new Set<string>();
  let prev: MessageEntry | undefined;
  for (const m of st.messages) {
    const turn = m.kind === "agent" && m.turnId ? turns.get(m.turnId) : undefined;
    // Right after the human's message in the room, or in its own session, said once it was seated; or in a turn that read
    // it.
    const after = prev && byHuman(st, prev) && (!prev.native || prev.native.agent === m.author) && prev.seq > (st.joined?.[m.author] ?? 0);
    if (m.kind === "agent" && (after || (turn && read(turn)))) answers.add(m.id);
    if (m.kind !== "system" && m.kind !== "update" && m.kind !== "pass") prev = m;
  }
  const between = rows.map((row) => row.type === "msg" && !answers.has(row.m.id) && betweenAgents(st, row.m, shown));
  // A pass with a note for the human ends the exchange; so does one whose turn did something the room shows.
  const pass = rows.map(
    (row) => row.type === "msg" && row.m.kind === "pass" && !(row.m.turnId && shown.has(row.m.turnId)) && !(row.m.text.trim() && toHuman(st, row.m)),
  );
  // A file a running turn revised is shown on its own until its reply comes: it does not end the exchange around it.
  const pending = rows.map((row) => row.type === "doc" && running.has(row.r.turnId ?? ""));
  for (let i = 0; i < rows.length; ) {
    let j = i;
    let end = i;
    if (between[i]) {
      while (j < rows.length && (between[j] || pass[j] || pending[j])) {
        j += 1;
        if (between[j - 1]) end = j;
      }
    }
    // A pass after the last message is not part of it.
    const within = rows.slice(i, end);
    const items = within.filter((row): row is Extract<FeedItem, { type: "msg" }> => row.type === "msg");
    const messages = items.filter((g) => g.m.kind !== "pass");
    if (messages.length < 2 || (live && j >= rows.length)) {
      out.push(...rows.slice(i, Math.max(end, i + 1)));
      i = Math.max(end, i + 1);
      continue;
    }
    const agents = [...new Set(messages.flatMap((g) => [g.m.author, ...g.m.mentions.filter((h) => h !== g.m.author)]))];
    const refs = [...new Set(messages.flatMap((g) => [...unquoted(g.m.text).matchAll(REF)].map((x) => x[1]!.toUpperCase())))].filter((ref) => refExists(st, ref));
    out.push({ key: `b-${items[0]!.m.id}`, type: "between", items, agents, refs });
    // The running turn's files among them, after it.
    out.push(...within.filter((row) => row.type === "doc"));
    i = end;
  }
  return out;
};

/**
 * Whom an agent is waiting for: whom it @mentioned and who has not written since. While it works: the agents or the human
 * its last message in this turn @mentioned — it may be waiting inside its turn, burning the turn's time; nobody when that
 * was a pass. Idle: the human alone, when it @mentioned them in the room (as the briefing asks for an answer or a
 * decision; not in its own session) and they have not written (in another agent's own session, only what names it) or
 * done anything on the table since (`ops`: the table's moves), whatever it said or passed after; another agent wakes it
 * when there is something for it.
 */
export const waitingFor = (st: RoomState, agent: string, ops: readonly OpEntry[] = []): { who: string[]; since: string } | null => {
  const turn = st.turns.findLast((t) => t.agent === agent && t.status === "running");
  const own = (m: MessageEntry) => m.author === agent && (m.kind === "agent" || m.kind === "update" || m.kind === "pass");
  const human = st.human.toLowerCase();
  const last = turn
    ? st.messages.findLast((m) => own(m) && m.turnId === turn.id)
    : st.messages.findLast((m) => own(m) && m.kind !== "pass" && !m.native && m.mentions.includes(human));
  if (!last || last.kind === "pass") return null;
  const fromHuman = (m: MessageEntry) => byHuman(st, m);
  const after = st.messages.filter((m) => m.seq > last.seq && m.kind !== "system");
  if (!turn) {
    // The human answers in the room or on the table: anything they did there (an item added, one marked done, settled,
    // reopened, edited or deleted, a decision), a step they committed.
    const t = st.table;
    const added = [t.questions, t.options, t.notes, t.facts, t.settled, t.next, t.decisions, t.shifts].some((list) => (list ?? []).some((item) => item.by.toLowerCase() === human && item.seq > last.seq));
    const moved = ops.some((entry) => entry.seq > last.seq && entry.op.by.toLowerCase() === human && !entry.op.from);
    const committed = t.next.some((step) => step.commit && step.commit.by.toLowerCase() === human && step.commit.seq > last.seq);
    // Said in another agent's own session, it answers this one only when it names it.
    const answered = after.some((m) => fromHuman(m) && (!m.native || m.native.agent === agent || m.mentions.includes(agent) || m.mentions.includes("all")));
    return last.mentions.includes(human) && !answered && !added && !moved && !committed ? { who: [human], since: last.id } : null;
  }
  const ids = new Set(st.agents.map((a) => a.id));
  const asked = last.mentions.filter((h) => h !== agent && (h === human || ids.has(h)));
  const who = asked.filter((h) => !after.some((m) => (h === human ? fromHuman(m) : m.author === h)));
  return who.length ? { who, since: last.id } : null;
};

/** The limit a turn is measured against: the one it started with, else (a log from before that was kept) the room's. */
export const turnLimit = (st: Pick<RoomState, "settings">, turn: Pick<TurnState, "limitMs"> | undefined): number => turn?.limitMs ?? st.settings.turnTimeoutMs;

type ClockUnit = "s" | "m:ss" | "min" | "h" | "d";

/** A stretch of time on the turn clock, in the units of its limit, rounded down; under a minute in seconds. */
const span = (ms: number, unit: ClockUnit) => {
  const s = Math.floor(ms / 1000);
  if (unit === "s") return `${s}s`;
  if (unit === "m:ss") return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (unit === "min" || m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (unit === "h" || h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
};

/**
 * How far a turn is into its time limit: "12s of 30s", "1:05 of 1:30", "45s of 20 min", "18 of 20 min", "3 h 5 min of 24 h",
 * "over 20 min". Short, for a narrow header: the time alone in the same units ("18 min", "1:05"), "over 20 min" past it.
 */
export const turnClock = (elapsedMs: number, limitMs: number, short = false) => {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const unit: ClockUnit =
    limitMs < 60_000
      ? "s"
      : limitMs < 10 * 60_000 || (limitMs < 2 * 3_600_000 && limitMs % 60_000 !== 0)
        ? "m:ss"
        : limitMs < 2 * 3_600_000
          ? "min"
          : limitMs < 2 * 86_400_000
            ? "h"
            : "d";
  const limit = span(limitMs, unit);
  if (elapsed >= limitMs) return `over ${limit}`;
  // Rounded down, the clock shows less than the limit until the limit is reached: never "1:30 of 1:30" at 1:30.4 of 1:30.9.
  const step = unit === "d" ? 3_600_000 : unit === "min" || unit === "h" ? 60_000 : 1000;
  const done = span(Math.min(elapsed, Math.max(0, Math.floor(limitMs / step) * step - 1)), unit);
  if (short) return done;
  // "18 of 20 min", not "18 min of 20 min".
  return unit === "min" && done.endsWith(" min") ? `${done.slice(0, -4)} of ${limit}` : `${done} of ${limit}`;
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
