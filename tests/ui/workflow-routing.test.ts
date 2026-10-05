import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { followAddress, parseRouteHash, syncRoute, useStore } from "../../ui/src/lib/store.js";
import type { RoomSummary, Snapshot } from "../../ui/src/lib/types.js";

const RUN_A = "12345678-1234-4234-8234-123456789abc";
const RUN_B = "87654321-4321-4321-8321-cba987654321";
const initial = useStore.getInitialState();
const names = ["location", "history", "document", "localStorage"] as const;
const original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let address: URL;
let entries: string[], index: number;
let values: Map<string, string>;
let opened: string[];
let unsubscribe: () => void;
const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const back = () => { assert(index > 0); address.href = entries[--index]!; syncRoute(); };
const forward = () => { assert(index < entries.length - 1); address.href = entries[++index]!; syncRoute(); };
const visit = (hash: string) => { address.hash = hash; syncRoute(); };

beforeEach(() => {
  address = new URL("http://127.0.0.1:7717/"); entries = [address.href]; index = 0; values = new Map(); opened = [];
  define("location", address);
  define("document", { title: "Agoryx" });
  define("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  define("history", {
    pushState(_state: unknown, _unused: string, url: string) { address.href = new URL(url, address.href).href; entries.splice(index + 1); entries.push(address.href); index++; },
    replaceState(_state: unknown, _unused: string, url: string) { address.href = new URL(url, address.href).href; entries[index] = address.href; },
  });
  useStore.setState({ ...initial, openRoom: async (roomId) => { opened.push(roomId); } }, true);
  unsubscribe = followAddress();
});

afterEach(() => {
  unsubscribe(); useStore.setState(initial, true);
  for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test("catalog and creation addresses preserve explicit mode and Unicode project folders", () => {
  assert.deepEqual(parseRouteHash("#modes").route, { kind: "modes" });
  assert.deepEqual(parseRouteHash("#new").route, { kind: "new" });
  assert.deepEqual(parseRouteHash("#new?mode=unknown").route, { kind: "new" });
  assert.equal(parseRouteHash("#%malformed").route, null);
  const dir = "/Users/ivan/Мої проєкти/one & two";
  useStore.getState().go({ kind: "new", mode: "council", dir });
  assert.equal(address.hash, `#new?${new URLSearchParams({ mode: "council", dir })}`);
  assert.deepEqual(parseRouteHash(address.hash).route, { kind: "new", mode: "council", dir });
  useStore.getState().go({ kind: "modes" });
  assert.equal(address.hash, "#modes"); assert.equal(useStore.getState().workspaceMode, "chat");
});

test("a generic New action clears the previous protocol, selected run and room panel", () => {
  useStore.getState().openWorkflow("room-a", "debate", RUN_A);
  useStore.getState().setPanel("files"); useStore.getState().openFile("notes.txt");
  useStore.getState().go({ kind: "new" });
  const state = useStore.getState();
  assert.deepEqual(state.route, { kind: "new" }); assert.equal(state.workspaceMode, "chat"); assert.equal(state.workflowRunId, null);
  assert.equal(state.view, "chat"); assert.equal(state.panel, null); assert.equal(state.filePath, null); assert.equal(state.snap, null); assert.equal(address.hash, "#new");
  state.setWorkspaceMode("verification");
  assert.deepEqual(useStore.getState().route, { kind: "new", mode: "verification" }); assert.equal(address.hash, "#new?mode=verification");
  visit("#new"); assert.equal(useStore.getState().workspaceMode, "chat"); assert.deepEqual(useStore.getState().route, { kind: "new" });
});

test("creation mode and directory survive reload and browser Back without inheriting later state", () => {
  useStore.getState().go({ kind: "new", dir: "/project" });
  useStore.getState().go({ kind: "new", mode: "tournament", dir: "/project" });
  assert.equal(useStore.getState().workspaceMode, "tournament");
  back(); assert.deepEqual(useStore.getState().route, { kind: "new", dir: "/project" }); assert.equal(useStore.getState().workspaceMode, "chat");
  forward(); assert.equal(useStore.getState().workspaceMode, "tournament");
  const hash = address.hash;
  unsubscribe(); useStore.setState({ route: { kind: "boot" }, workspaceMode: "debate", workflowRunId: RUN_B, panel: "diff", view: "table" }); unsubscribe = followAddress();
  address.hash = hash; syncRoute();
  assert.deepEqual(useStore.getState().route, { kind: "new", mode: "tournament", dir: "/project" });
  assert.equal(useStore.getState().workspaceMode, "tournament"); assert.equal(useStore.getState().workflowRunId, null); assert.equal(useStore.getState().panel, null);
});

test("opening live, historical and new sessions is atomic and gives each selection a history entry", () => {
  useStore.getState().go({ kind: "room", id: "room-a" });
  const seen: Array<{ room: string | null; mode: string; run: string | null; snap: string | null }> = [];
  useStore.setState({ snap: { state: { id: "room-a" } } as Snapshot });
  const off = useStore.subscribe((state) => seen.push({ room: state.route.kind === "room" ? state.route.id : null, mode: state.workspaceMode, run: state.workflowRunId, snap: state.snap?.state.id ?? null }));
  useStore.getState().openWorkflow("room-b", "council", RUN_A);
  off();
  assert.deepEqual(seen, [{ room: "room-b", mode: "council", run: RUN_A, snap: null }]);
  assert.equal(address.hash, `#room-b?mode=council&run=${RUN_A}`); assert.equal(opened.at(-1), "room-b");
  const count = entries.length;
  useStore.getState().openWorkflow("room-b", "council", RUN_A); assert.equal(entries.length, count);
  useStore.getState().openWorkflow("room-b", "council", RUN_B); assert.equal(entries.length, count + 1);
  useStore.getState().openWorkflow("room-b", "council"); assert.equal(address.hash, "#room-b?mode=council"); assert.equal(useStore.getState().workflowRunId, null);
  useStore.getState().openWorkflow("room-b", "council", "new"); assert.equal(address.hash, "#room-b?mode=council&run=new");
  back(); assert.equal(useStore.getState().workflowRunId, null);
  back(); assert.equal(useStore.getState().workflowRunId, RUN_B);
  back(); assert.equal(useStore.getState().workflowRunId, RUN_A);
});

test("session list navigation clears protocol selection, is shareable, and is remembered per room", () => {
  useStore.getState().openWorkflow("room-a", "verification", RUN_A);
  useStore.getState().setView("sessions");
  assert.equal(address.hash, "#room-a?view=sessions"); assert.equal(useStore.getState().workspaceMode, "chat"); assert.equal(useStore.getState().workflowRunId, null);
  useStore.getState().go({ kind: "room", id: "room-b" });
  useStore.getState().go({ kind: "room", id: "room-a" }); assert.equal(useStore.getState().view, "sessions");
  visit(`#room-a?view=sessions&mode=debate&run=${RUN_A}`);
  assert.equal(useStore.getState().view, "sessions"); assert.equal(useStore.getState().workspaceMode, "chat"); assert.equal(useStore.getState().workflowRunId, null);
  assert.equal(address.hash, "#room-a?view=sessions");
  useStore.getState().setWorkspaceMode("council"); assert.equal(useStore.getState().view, "chat"); assert.equal(address.hash, "#room-a?mode=council");
});

test("room changes and malformed run links cannot reuse another selected session", () => {
  useStore.setState({ rooms: [{ id: "room-b", mode: "chat", workflow: { mode: "debate" } }] as RoomSummary[] });
  useStore.getState().openWorkflow("room-a", "council", RUN_A);
  useStore.getState().go({ kind: "room", id: "room-b" }); assert.equal(useStore.getState().workflowRunId, null); assert.equal(useStore.getState().workspaceMode, "chat");
  visit(`#room-a?mode=council&run=${RUN_A}`); assert.equal(useStore.getState().workflowRunId, RUN_A);
  visit("#room-a?mode=council&run=../../another"); assert.equal(useStore.getState().workflowRunId, null);
  visit(`#room-a?run=${RUN_A}`); assert.equal(useStore.getState().workspaceMode, "chat"); assert.equal(useStore.getState().workflowRunId, null);
  useStore.getState().openWorkflow("room-a", "council", RUN_A);
  useStore.getState().setWorkspaceMode("council"); assert.equal(useStore.getState().workflowRunId, null); assert.equal(address.hash, "#room-a?mode=council");
});

test("Back to a bare chat address does not resurrect a protocol from remembered preferences", () => {
  useStore.getState().go({ kind: "room", id: "room-a" });
  assert.equal(address.hash, "#room-a");
  useStore.getState().openWorkflow("room-a", "council", RUN_A);
  back(); assert.equal(address.hash, "#room-a"); assert.equal(useStore.getState().workspaceMode, "chat"); assert.equal(useStore.getState().workflowRunId, null);
});

test("native panel, settings and project share addresses retain their existing semantics", () => {
  visit(`#room-a?mode=council&run=${RUN_A}&panel=diff&scope=commit&commit=abcdef123&path=folder%2Ffile.ts`);
  assert.equal(useStore.getState().panel, "diff"); assert.deepEqual(useStore.getState().changes, { scope: "commit", sha: "abcdef123", path: "folder/file.ts" });
  useStore.getState().openSession("reviewer");
  assert.equal(new URLSearchParams(address.hash.split("?")[1]).get("agent"), "reviewer");
  assert.equal(new URLSearchParams(address.hash.split("?")[1]).get("run"), RUN_A);
  visit("#settings/limits"); assert.deepEqual(useStore.getState().route, { kind: "settings", section: "limits" }); assert.equal(useStore.getState().workflowRunId, null);
  visit("#project/abcdef123456"); assert.deepEqual(useStore.getState().route, { kind: "project", hash: "abcdef123456" });
  visit("#projects"); assert.deepEqual(useStore.getState().route, { kind: "projects" });
});


test("workspace menu navigation changes the whole context without mutating a room", () => {
  useStore.getState().openWorkflow("room-a", "council", RUN_A);
  useStore.getState().go({kind:"workspace", mode:"tournament"});
  assert.equal(address.hash,"#workspace/tournament");
  assert.deepEqual(parseRouteHash(address.hash).route,{kind:"workspace",mode:"tournament"});
  assert.equal(useStore.getState().workspaceMode,"tournament");
  assert.equal(useStore.getState().workflowRunId,null);
  assert.equal(useStore.getState().snap,null);
  back();
  assert.equal(useStore.getState().workspaceMode,"council");
  assert.equal(useStore.getState().workflowRunId,RUN_A);
  forward();
  assert.equal(useStore.getState().workspaceMode,"tournament");
});


test("returning to a conversation changes the workspace and Back restores the exact protocol run", () => {
  useStore.getState().openWorkflow("room-a", "council", RUN_A);
  useStore.getState().setView("chat");
  assert.equal(address.hash,"#room-a");
  assert.equal(useStore.getState().workspaceMode,"chat");
  back();
  assert.equal(useStore.getState().workspaceMode,"council");
  assert.equal(useStore.getState().workflowRunId,RUN_A);
});


test("Work is a separate destination and native Work room views stay in Work", () => {
  useStore.setState({ rooms: [{id:"work-room",mode:"work"},{id:"chat-room",mode:"chat"},{id:"legacy-room"}] as RoomSummary[] });
  useStore.getState().go({kind:"workspace",mode:"work"});
  assert.equal(address.hash,"#workspace/work");
  assert.deepEqual(parseRouteHash(address.hash).route,{kind:"workspace",mode:"work"});
  useStore.getState().go({kind:"new",mode:"work"});
  assert.equal(address.hash,"#new?mode=work");
  visit("#work-room");
  assert.equal(useStore.getState().workspaceMode,"work");
  useStore.getState().openWorkflow("work-room","council",RUN_A);
  useStore.getState().setView("sessions");
  assert.equal(useStore.getState().workspaceMode,"work");
  assert.equal(address.hash,"#work-room?view=sessions");
  back(); assert.equal(useStore.getState().workspaceMode,"council");
  useStore.getState().setView("chat");
  assert.equal(useStore.getState().workspaceMode,"work");
  assert.equal(address.hash,"#work-room");
  visit("#legacy-room"); assert.equal(useStore.getState().workspaceMode,"work");
  visit("#chat-room?mode=work"); assert.equal(useStore.getState().workspaceMode,"chat", "navigation cannot change a room's execution mode");
});

test("project-scoped New starts Chat and mode changes retain its project address", () => {
  useStore.getState().go({ kind: "new", dir: "/project" });
  assert.equal(useStore.getState().workspaceMode, "chat");
  useStore.getState().setWorkspaceMode("work");
  assert.deepEqual(useStore.getState().route, { kind: "new", dir: "/project", mode: "work" });
  useStore.getState().go({ kind: "new" });
  assert.equal(useStore.getState().workspaceMode, "chat");
});
