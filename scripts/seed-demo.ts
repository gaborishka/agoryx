#!/usr/bin/env tsx
// Demo rooms for looking at the UI without real agents: AGORYX_HOME=/some/dir tsx scripts/seed-demo.ts
// Writes plain room logs (messages, finished turns) into that home; never touches the default one.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { roomsDir } from "../internal/agora/paths.js";
import { RoomStore } from "../internal/agora/store.js";
import { DEFAULT_SETTINGS, type RoomAgent } from "../internal/agora/types.js";

if (!process.env.AGORYX_HOME) {
  console.error("set AGORYX_HOME to a scratch directory");
  process.exit(2);
}

const root = roomsDir();
mkdirSync(root, { recursive: true });
const ws = (name: string) => {
  const dir = join(process.env.AGORYX_HOME!, "ws", name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const claude: RoomAgent = { id: "claude", kind: "claude", label: "Claude", model: "claude-opus-5-5", effort: "high" };
const codex: RoomAgent = { id: "codex", kind: "codex", label: "Codex", model: "gpt-5.6", effort: "high" };

let n = 0;
const id = () => `m${(++n).toString(36)}`;
const say = (store: RoomStore, author: string, kind: "human" | "agent" | "pass" | "system", text: string, mentions: string[] = []) =>
  store.append({ type: "message.posted", message: { id: id(), author, kind, text, mentions, wakes: kind === "human" } });

const turn = (store: RoomStore, agent: string, runId: string, steps: Array<[string, string, string?]>, text: string) => {
  const turnId = `t${(++n).toString(36)}`;
  store.append({ type: "turn.started", turnId, agent, runId, cursor: store.events.length, resume: true, sessionId: null, promptChars: 4200 });
  steps.forEach(([kind, label, detail], i) =>
    store.append({ type: "turn.activity", turnId, agent, activity: { id: `a${i}`, kind: kind as never, label, ...(detail ? { detail } : {}), status: "ok" } }),
  );
  const messageId = id();
  store.append({ type: "message.posted", message: { id: messageId, author: agent, kind: "agent", text, mentions: [], wakes: false, turnId, runId } });
  store.append({ type: "turn.ended", turnId, agent, status: "ok", sessionId: null, messageId, usage: { inputTokens: 18200, outputTokens: 940 }, durationMs: 48000 + n * 900 });
};

// 1. A design debate with a real disagreement.
{
  const store = RoomStore.create(root, {
    name: "Search cache: LRU or TTL",
    workspace: ws("search-cache"),
    createdWorkspace: true,
    human: "ivan",
    agents: [claude, codex],
    settings: { ...DEFAULT_SETTINGS },
  });
  store.append({ type: "run.started", runId: "r1", trigger: null, budget: null });
  say(store, "ivan", "human", "Search takes 900 ms on a cold query. I want a cache in front of the index. @claude @codex — LRU or TTL, and why? The data refreshes every 10 minutes.", ["claude", "codex"]);
  turn(
    store,
    "claude",
    "r1",
    [
      ["read", "internal/search/index.ts"],
      ["search", "grep \"invalidate\"", "3 files"],
      ["command", "npm run bench -- search", "p50 912ms · p95 1.4s"],
    ],
    "I’d go with a **10-minute TTL**, keyed by the normalized query.\n\n- The data changes on a schedule, so a TTL matches how fresh it really is — we never serve an answer more than one refresh old.\n- LRU alone knows nothing about freshness: a popular query would stay cached forever and show yesterday’s data.\n- From the bench: 71% of queries repeat within 10 minutes, so the hit rate will be high.\n\nRisk: at refresh time every key expires at once, and we get a burst of cold queries. I suggest ±60 s of jitter.",
  );
  turn(
    store,
    "codex",
    "r1",
    [
      ["read", "internal/search/index.ts"],
      ["edit", "internal/search/cache.ts", "+64 −0"],
      ["command", "npm test -- cache", "12 passed"],
    ],
    "I don’t agree it’s either-or. A TTL solves freshness, not memory: we have a long tail of unique queries, and a plain TTL cache collects ~40k keys in 10 minutes.\n\nI wrote `cache.ts`: **an LRU capped at 5,000 keys, plus a 10-minute TTL** on every entry. I took the jitter from @claude. Tests pass.\n\n```ts\nconst cache = new LRU<string, Result[]>({ max: 5_000, ttl: 600_000, ttlJitter: 60_000 });\n```",
  );
  turn(store, "claude", "r1", [["read", "internal/search/cache.ts"]], "Agreed — LRU bounds memory, TTL bounds staleness. I read `cache.ts`: one note — the key has to be normalized *before* the cache (case, whitespace), or “Kyiv” and “kyiv ” become two entries. The rest looks good to me.");
  say(store, "codex", "pass", "Agreed on normalization, I’ll add it next.");
  store.append({ type: "run.ended", runId: "r1", reason: "quiet", turns: 3 });
  say(store, "ivan", "human", "Great. @codex add the normalization and a before/after bench.", ["codex"]);
}

// 2. A small solo room.
{
  const store = RoomStore.create(root, {
    name: "CSV parser refactor",
    workspace: ws("csvstream"),
    createdWorkspace: true,
    human: "ivan",
    agents: [codex],
    settings: { ...DEFAULT_SETTINGS },
  });
  say(store, "ivan", "human", "Empty lines at the end of a file currently become records. Fix it and cover it with a test.");
  turn(store, "codex", "r2", [["edit", "src/parse.ts", "+6 −2"], ["command", "npm test", "1490 passed"]], "Done: an empty line after the last row separator is now ignored, and an empty line in the **middle** of a file is still an error, as before. Added two tests.");
}

// 3. A room of three.
{
  const opus: RoomAgent = { id: "claude", kind: "claude", label: "Claude Opus", model: "claude-opus-5-5" };
  const sonnet: RoomAgent = { id: "sonnet", kind: "claude", label: "Claude Sonnet", model: "claude-sonnet-5-5" };
  const store = RoomStore.create(root, {
    name: "Agoryx landing page copy",
    workspace: ws("landing"),
    createdWorkspace: true,
    human: "ivan",
    agents: [opus, sonnet, codex],
    settings: { ...DEFAULT_SETTINGS },
  });
  say(store, "ivan", "human", "Write a headline for the landing page. One option each, then discuss.");
  turn(store, "claude", "r3", [["thinking", "Thinking"]], "“One room. Several minds. You moderate.”");
  turn(store, "sonnet", "r3", [], "“Stop copying answers between chats.” Everyone knows that pain.");
  turn(store, "codex", "r3", [], "“Claude and Codex in one repository — and they can see each other.”");
}

console.log(`seeded ${root}`);
