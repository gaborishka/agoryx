import assert from "node:assert/strict";
import { test } from "node:test";
import pc from "picocolors";
import { TranscriptPrinter, terminalInk } from "../../cmd/agoryx/agora.js";
import { agentLook, agentLooks, marksFor, SHADES } from "../../internal/agora/look.js";
import { DEFAULT_AGENTS, parseAgents } from "../../internal/agora/roster.js";
import type { RoomAgent, RoomEvent, RoomState } from "../../internal/agora/types.js";
import { roomPreview, roomPreviewParts } from "../../ui/src/lib/format.js";
import { ink, inkColor, lastLine, participant } from "../../ui/src/lib/room.js";
import { createTestRoom } from "./helpers.js";

/** Two Claudes on different models and Codex. */
const TRIO = parseAgents([
  { id: "opus", kind: "claude", model: "opus" },
  { id: "sonnet", kind: "claude", model: "sonnet" },
  { kind: "codex" },
]);

const room = (agents: RoomAgent[]) => ({ agents, human: "Ivan" }) as unknown as RoomState;

// --- the look itself (internal/agora/look.ts) ---------------------------------------------------

test("one agent of each kind looks as the kind always has: shade 0, no mark", () => {
  assert.deepEqual([...agentLooks(DEFAULT_AGENTS)], [
    ["claude", { kind: "claude", shade: 0 }],
    ["codex", { kind: "codex", shade: 0 }],
  ]);
  assert.deepEqual(agentLook(parseAgents([{ id: "gpt5", kind: "codex" }, { id: "opus", kind: "claude" }]), "gpt5"), { kind: "codex", shade: 0 });
});

test("two Claudes and Codex: each Claude gets its own shade and mark, in roster order; Codex is untouched", () => {
  assert.deepEqual(agentLook(TRIO, "opus"), { kind: "claude", shade: 0, mark: "O" });
  assert.deepEqual(agentLook(TRIO, "sonnet"), { kind: "claude", shade: 1, mark: "S" });
  assert.deepEqual(agentLook(TRIO, "codex"), { kind: "codex", shade: 0 });
  assert.equal(agentLook(TRIO, "Ivan"), undefined);
  // The same roster, the same looks: nothing depends on when or where it is computed.
  assert.deepEqual([...agentLooks(TRIO)], [...agentLooks(parseAgents(JSON.parse(JSON.stringify(TRIO))))]);
});

test("eight agents of one kind: eight shades, eight marks; a second kind counts its own shades", () => {
  const eight = parseAgents(
    ["Opus", "Sonnet", "Haiku", "Mythos", "Fable", "Quill", "Wren", "Lark"].map((label) => ({ id: label.toLowerCase(), kind: "claude", label })),
  );
  const looks = eight.map((agent) => agentLook(eight, agent.id)!);
  assert.deepEqual(looks.map((look) => look.shade), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(looks.map((look) => look.mark), ["O", "S", "H", "M", "F", "Q", "W", "L"]);
  const mixed = parseAgents([{ id: "a1", kind: "codex" }, { id: "b1", kind: "claude" }, { id: "a2", kind: "codex" }, { id: "b2", kind: "claude" }]);
  assert.deepEqual(mixed.map((agent) => agentLook(mixed, agent.id)!.shade), [0, 0, 1, 1]);
});

test("marks: what sets the labels apart, else the place in the roster", () => {
  assert.deepEqual(marksFor(["Claude Opus", "Claude Sonnet"]), ["O", "S"]);
  assert.deepEqual(marksFor(["GPT-5 high", "GPT-5 low"]), ["H", "L"]);
  assert.deepEqual(marksFor(["Опус", "сонет"]), ["О", "С"]);
  // Initials that repeat, or a label that is all prefix, fall back to 1, 2, …
  assert.deepEqual(marksFor(["Claude", "Claude 2"]), ["1", "2"]);
  assert.deepEqual(marksFor(["Sonnet", "Sonar"]), ["1", "2"]);
  assert.deepEqual(marksFor(["Claude A", "Claude B", "Claude C"]), ["A", "B", "C"]);
  // The CLI's own agent next to one named for its model: C and O, not 1 and 2.
  assert.deepEqual(marksFor(["Claude", "Claude Opus"]), ["C", "O"]);
  assert.deepEqual(marksFor(["Claude", "Claude Opus", "Claude Sonnet"]), ["C", "O", "S"]);
  assert.deepEqual(marksFor(["Claude", "Claude Code"]), ["1", "2"]);
});

// --- the page (ui/src/lib) --------------------------------------------------------------------------

test("an agent is who the roster says, never a kind: @claude is nobody in a room of Opus and Sonnet", () => {
  // Before: a KNOWN_LABEL fallback made any "claude"/"codex" handle an agent labelled Claude/Codex, with that kind's face.
  const trio = room(TRIO);
  assert.deepEqual(participant(trio, "claude"), { id: "claude", label: "claude", tone: "human", agent: false });
  const gpt = room(parseAgents([{ id: "gpt5", kind: "codex", label: "GPT-5" }, { kind: "claude" }]));
  assert.equal(participant(gpt, "codex").agent, false);
  assert.equal(participant(gpt, "gpt5").label, "GPT-5");
  assert.equal(participant(gpt, "claude").label, "Claude");
});

test("the page tells two Claudes apart by shade and mark, and leaves a one-of-each room exactly as it was", () => {
  const pair = room(DEFAULT_AGENTS);
  for (const id of ["claude", "codex"]) {
    const p = participant(pair, id);
    assert.equal(p.mark, undefined);
    assert.equal(p.shade, undefined);
    assert.equal(ink(p), undefined, "no inline colour: the kind's own classes decide, as before");
    assert.equal(inkColor(p), undefined);
  }
  const trio = room(TRIO);
  const opus = participant(trio, "opus");
  const sonnet = participant(trio, "sonnet");
  assert.equal(opus.tone, "claude");
  assert.equal(sonnet.tone, "claude", "the tone still says which CLI it is");
  assert.deepEqual([opus.mark, sonnet.mark], ["O", "S"]);
  assert.deepEqual(ink(opus), { "--claude": "var(--claude-0)", "--claude-soft": "var(--claude-soft-0)" });
  assert.deepEqual(ink(sonnet), { "--claude": "var(--claude-1)", "--claude-soft": "var(--claude-soft-1)" });
  assert.equal(inkColor(sonnet), "var(--claude-1)");
  assert.equal(ink(participant(trio, "codex")), undefined);
  assert.equal(ink(participant(trio, "Ivan")), undefined);
});

test("the start screen looks agents up in the roster it is about to seat, with the same looks the room will have", () => {
  const seated = participant({ agents: TRIO }, "sonnet");
  assert.deepEqual(seated, participant(room(TRIO), "sonnet"));
  assert.equal(participant(undefined, "claude").agent, false, "no roster, no agents");
});

test("a live message keeps its author in the room list: label and (next to another of its kind) look", () => {
  // Before: the live update dropped the label, so the list said "You: …" for an agent's reply until a reload.
  const trio = room(TRIO);
  const line = lastLine(trio, { author: "sonnet", text: "**Agreed**, ship it" });
  assert.deepEqual(line, { author: "sonnet", text: "**Agreed**, ship it", label: "Sonnet", look: { kind: "claude", shade: 1, mark: "S" } });
  assert.equal(roomPreview(line), "Sonnet: Agreed, ship it");
  assert.deepEqual(roomPreviewParts(lastLine(trio, { author: "Ivan", text: "hi" })), { who: "You", text: "hi" });
  assert.deepEqual(lastLine(room(DEFAULT_AGENTS), { author: "claude", text: "x".repeat(300) }), { author: "claude", text: "x".repeat(200), label: "Claude" });
  assert.deepEqual(ink(line.look), { "--claude": "var(--claude-1)", "--claude-soft": "var(--claude-soft-1)" });
});

test("the daemon's room list carries the same look as the live update", async () => {
  const r = createTestRoom({ agents: TRIO });
  try {
    r.store.append({ type: "message.posted", message: { id: "m1", author: "opus", kind: "agent", text: "hello", mentions: [], wakes: false } });
    assert.deepEqual(r.store.summary().lastMessage, lastLine(r.store.state, { author: "opus", text: "hello" }));
    assert.deepEqual(r.store.summary().lastMessage?.look, { kind: "claude", shade: 0, mark: "O" });
    r.store.append({ type: "message.posted", message: { id: "m2", author: "codex", kind: "agent", text: "hi", mentions: [], wakes: false } });
    assert.equal(r.store.summary().lastMessage?.look, undefined, "Codex is alone of its kind here");
  } finally {
    await r.cleanup();
  }
});

// --- agoryx tail --------------------------------------------------------------------------------------

const printed = (agents: RoomAgent[], author: string) => {
  let out = "";
  const printer = new TranscriptPrinter(agents, "Ivan", { trace: false, write: (text) => (out += text), colors: pc.createColors(true) });
  const event = { type: "message.posted", seq: 1, ts: new Date().toISOString(), message: { id: "m1", seq: 1, ts: "", author, kind: "agent", text: "hi", mentions: [], wakes: false } };
  printer.event(event as unknown as RoomEvent);
  return out.split("\n")[1]!;
};

test("agoryx tail paints two Claudes differently, keeps Claude warm and Codex cool, and a pair as before", () => {
  const c = pc.createColors(true);
  // One of each kind: yellow Claude, cyan Codex, exactly as before.
  assert.ok(printed(DEFAULT_AGENTS, "claude").startsWith(c.yellow(c.bold("Claude"))));
  assert.ok(printed(DEFAULT_AGENTS, "codex").startsWith(c.cyan(c.bold("Codex"))));
  const opus = printed(TRIO, "opus");
  const sonnet = printed(TRIO, "sonnet");
  assert.ok(opus.startsWith(c.yellow(c.bold("Opus"))));
  assert.ok(sonnet.startsWith(c.redBright(c.bold("Sonnet"))), JSON.stringify(sonnet));
  assert.ok(printed(TRIO, "codex").startsWith(c.cyan(c.bold("Codex"))));
  // Eight of a kind: eight different inks.
  const inks = Array.from({ length: 8 }, (_, shade) => terminalInk({ kind: "codex", shade }, c)("x"));
  assert.equal(new Set(inks).size, 8);
});

test("every shade an agent can be given is defined for the light and the dark theme", async () => {
  // ink() points --claude/--codex at var(--<kind>-N): a shade missing from a theme would silently fall back to nothing.
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../ui/src/index.css", import.meta.url), "utf8");
  const block = (selector: string) => {
    const start = css.search(new RegExp(`^${selector.replace(/[.:]/g, "\\$&")} \\{`, "m"));
    assert.ok(start >= 0, `${selector} block`);
    return css.slice(start, css.indexOf("\n}", start));
  };
  for (const theme of [":root", ".dark"]) {
    const text = block(theme);
    for (const kind of ["claude", "codex"]) {
      for (let shade = 0; shade < SHADES; shade += 1) {
        for (const name of [`--${kind}-${shade}`, `--${kind}-soft-${shade}`]) assert.match(text, new RegExp(`${name}:`), `${name} in ${theme}`);
      }
    }
  }
});
