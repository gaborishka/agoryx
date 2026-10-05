#!/usr/bin/env tsx
// What one poll of the room list costs while a room is busy: tsx scripts/bench-room-list.ts [events]
// The page asks every few seconds. A room this process writes is summarized from memory; any other is read from its
// log again only when the log changed. Rooms are made in a temporary directory and removed after.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../internal/agora/store.js";
import { DEFAULT_SETTINGS, type RoomAgent } from "../internal/agora/types.js";

const events = Number(process.argv[2] ?? 5000);
const polls = 20;
const agents: RoomAgent[] = [
  { id: "claude", kind: "claude", label: "Claude" },
  { id: "codex", kind: "codex", label: "Codex" },
];
const home = mkdtempSync(join(tmpdir(), "agoryx-bench-"));
try {
  const root = join(home, "rooms");
  mkdirSync(root);
  const make = (name: string) => RoomStore.create(root, { name, workspace: join(home, name), createdWorkspace: true, human: "Ivan", agents, settings: DEFAULT_SETTINGS });
  const busy = make("busy");
  for (let i = 0; i < 10; i += 1) make(`idle-${i}`);
  const text = "A typical reply — some markdown, `code`, and a list.\n".repeat(8);
  for (let i = 0; i < events; i += 1) {
    busy.append({ type: "message.posted", message: { id: `m${i}`, author: i % 2 ? "claude" : "Ivan", kind: i % 2 ? "agent" : "human", text, mentions: [] } } as never);
  }
  const poll = (live?: (id: string) => RoomStore | undefined) => {
    RoomStore.list(root, live);
    let total = 0;
    for (let i = 0; i < polls; i += 1) {
      busy.append({ type: "message.posted", message: { id: `p${i}-${total}`, author: "Ivan", kind: "human", text: "still here", mentions: [] } } as never);
      const start = performance.now();
      RoomStore.list(root, live);
      total += performance.now() - start;
    }
    return total / polls;
  };
  const replayed = poll();
  const live = poll((id) => (id === busy.id ? busy : undefined));
  console.log(`a room of ${events} events, written between polls:`);
  console.log(`  log read again: ${replayed.toFixed(2)} ms per poll`);
  console.log(`  live store:     ${live.toFixed(2)} ms per poll (${(replayed / live).toFixed(0)}x)`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
