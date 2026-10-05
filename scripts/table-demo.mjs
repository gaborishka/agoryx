#!/usr/bin/env node
// An isolated, reproducible room for inspecting the production table UI. No model requests or personal rooms.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { AgoraDaemon } from "../dist/internal/agora/daemon.js";
import { RoomStore } from "../dist/internal/agora/store.js";
import { prepareTableOp } from "../dist/internal/agora/table.js";
import { DEFAULT_SETTINGS } from "../dist/internal/agora/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previewHome = process.env.AGORYX_TABLE_DEMO_HOME || mkdtempSync(join(tmpdir(), "agoryx-table-demo-"));
const roomsRoot = join(previewHome, "rooms");
const workspace = join(previewHome, "workspace");
mkdirSync(workspace, { recursive: true });
const existing = RoomStore.list(roomsRoot).find(room => room.name === "Work table · demo room");
const store = existing ? RoomStore.open(roomsRoot, existing.id) : RoomStore.create(roomsRoot, {
  name: "Work table · demo room", mode: "chat", workspace, createdWorkspace: false, human: "Ivan",
  agents: [{ id: "codex", kind: "codex", label: "Codex · demo" }, { id: "claude", kind: "claude", label: "Claude · demo" }],
  settings: { ...DEFAULT_SETTINGS, network: false },
});
if (!existing) {
  const move = (raw, by = "codex") => {
    const op = prepareTableOp(store.state.table, raw, by, by === "Ivan");
    store.append({ type: "table.op", op: { ...op, ...(op.op === "brief" ? { asOfSeq: store.state.seq } : {}) } });
  };
  store.append({ type: "message.posted", message: { id: "m1", author: "Ivan", kind: "human", text: "This demo room is for reviewing the work table. Let's compare one main result with a grid of components. All scenario data is synthetic.", mentions: [], wakes: false } });
  move({ op: "ask", text: "One main result or a grid of components?" });
  move({ op: "propose", title: "One main result", body: "One focus below a short overview. Events, sources and arguments are available alongside it.", q: "Q1" });
  move({ op: "propose", title: "A grid of components", body: "Several results of equal weight at once. More is visible, with more places competing for attention.", q: "Q1" }, "claude");
  move({ op: "next", text: "Prepare a comparison of the layouts", target: "P1" }, "claude");
  move({ op: "review", target: "X1" }, "claude");
  move({ op: "done", target: "X1" });
  move({ op: "next", text: "Check the selected layout on a narrow screen", target: "P1" });
  move({ op: "fact", text: "This is a demo scenario; the test agents do not use models." });
  move({ op: "component", title: "Layout comparison", kind: "comparison", refs: ["Q1"] }, "claude");
  move({ op: "component", title: "Plan and checks", kind: "checks", refs: ["X1", "X2", "F1"] });
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>
    :root{color-scheme:light dark}body{font:14px/1.5 system-ui;margin:18px;color:light-dark(#171717,#eeeeee);background:light-dark(#ffffff,#111111)}
    .route{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.node{padding:10px 14px;background:light-dark(#f3f3f3,#252525);border-radius:8px}
    button{font:inherit;color:inherit;background:transparent;border:1px solid light-dark(#dddddd,#454545);border-radius:8px;padding:8px 12px;margin-top:16px}
    p{margin-bottom:0}button:focus-visible{outline:2px solid currentColor;outline-offset:3px}
    </style><main><div class="route"><span class="node">Overview</span><span aria-hidden="true">→</span><span class="node">Your choice</span><span aria-hidden="true">→</span><span class="node">Result</span></div>
    <button type="button" aria-expanded="false" onclick="const p=document.getElementById('detail');p.hidden=!p.hidden;this.setAttribute('aria-expanded',String(!p.hidden));">Show the dependency</button>
    <p id="detail" hidden>Your choice determines how the result is presented. Independent checks can continue.</p></main></html>`;
  move({ op: "component", title: "Interactive work map", kind: "custom", refs: ["P1", "X2"], body: "```html\n" + html + "\n```" }, "claude");
  move({ op: "brief", now: "The layout comparison is ready. Choose one main result or a grid of components.", changes: ["The plan and checks are linked to real steps", "An interactive diagram was created for this task"], next: "After your choice: Codex checks the narrow layout", refs: ["W1", "X1", "X2"], awaiting: { q: "Q1", recommendation: "P1" } });
}

const execute = promisify(execFile);
const runner = kind => ({
  kind, resumeCommand: () => "",
  async run(request) {
    // Exercise the real agent-side publication path, but never start a model or invent verified results.
    const current = RoomStore.open(roomsRoot, request.env.AGORYX_ROOM).state;
    const turn = current.turns.find(turn => turn.id === request.env.AGORYX_TURN);
    const assist = current.messages.findLast(message => message.tableAssist?.agent === request.env.AGORYX_AGENT && turn && message.seq > turn.cursorBefore && message.seq <= turn.cursor)?.tableAssist;
    if (assist) {
      try { await delay(2200, undefined, { signal: request.signal }); }
      catch { return { status: "interrupted", text: "", sessionId: null }; }
      const publish = async args => {
        if (request.signal.aborted) throw new Error("Demo request interrupted");
        await execute(process.execPath, [join(root, "bin/agoryx-agent.mjs"), "table", ...args], { cwd: request.cwd, env: request.env, signal: request.signal });
      };
      const fresh = () => RoomStore.open(roomsRoot, request.env.AGORYX_ROOM).state;
      const refs = [];
      if (assist.kind === "question") {
        const text = "What evidence should confirm that the selected layout is easier to use?";
        let question = current.table.questions.find(question => question.status === "open" && question.text === text);
        if (!question) {
          await publish(["ask", text]);
          question = fresh().table.questions.at(-1);
        }
        refs.push(question.id);
        await publish(["component", "Question to review", "--kind", "artifact", "--ref", question.id, "--body", "The layout choice is recorded, while evidence of easier use remains to be reviewed. This synthetic question review reuses the existing open question when available; it does not invent a usability result."]);
        refs.push(fresh().table.components.at(-1).id);
      } else if (assist.kind === "options") {
        let q = assist.target;
        if (!q?.startsWith("Q")) {
          await publish(["ask", "Which presentation best supports this task?"]);
          q = fresh().table.questions.at(-1).id;
        }
        for (const title of ["Observe time to reach a decision", "Compare understanding of the current work", "Check the chosen presentation at narrow widths"]) {
          await publish(["propose", title, "--body", "A synthetic alternative prepared by the test runner. Its tradeoffs remain for the human to review.", "--q", q]);
          refs.push(fresh().table.options.at(-1).id);
        }
        await publish(["component", "Prepared layout alternatives", "--kind", "comparison", "--ref", q]);
        refs.push(fresh().table.components.at(-1).id);
      } else if (assist.kind === "conclusion") {
        const scope = assist.target ? `Context: ${assist.target}.\n\n` : "";
        await publish(["component", "Findings for review", "--kind", "artifact", "--body", scope + "The table already separates decisions, current work and evidence. The open questions and layout tradeoffs remain unresolved.\n\nThis synthetic summary is prepared by the test runner; it does not establish usability or record a human decision.", ...(assist.target ? ["--ref", assist.target] : [])]);
        refs.push(fresh().table.components.at(-1).id);
      } else {
        const chosen = current.table.options.filter(option => option.status === "chosen");
        const route = assist.target?.startsWith("P") ? assist.target : chosen.length === 1 ? chosen[0].id : undefined;
        for (const text of ["Review the prepared alternatives with the human", "Check the chosen presentation at narrow widths"]) {
          await publish(["next", text, ...(route ? ["--on", route] : [])]);
          refs.push(fresh().table.next.at(-1).id);
        }
        await publish(["component", "Prepared next steps", "--kind", "plan", ...refs.flatMap(ref => ["--ref", ref])]);
        refs.push(fresh().table.components.at(-1).id);
      }
      await publish(["brief", "The requested content is prepared for review. No decision or execution was automatic.", "--next", "Review the prepared content", ...refs.flatMap(ref => ["--ref", ref])]);
      return { status: "ok", text: "::pass::", sessionId: null };
    }
    const chosen = current.table.options.find(option => option.status === "chosen");
    const args = [join(root, "bin/agoryx-agent.mjs"), "table", "brief", chosen
      ? `Selected: ${chosen.title}. Step X2 remains open; this is a demo scenario.`
      : "The team received your direction. No layout has been selected yet; this is a demo scenario.",
      "--next", "Codex checks the selected layout", "--ref", "X2"];
    if (!chosen) args.push("--awaiting", "Q1", "--recommend", "P1");
    await execute(process.execPath, args, { cwd: request.cwd, env: request.env });
    return { status: "ok", text: "::pass::", sessionId: null };
  },
});
const daemon = new AgoraDaemon({ port: Number(process.env.AGORYX_TABLE_DEMO_PORT || 0), advertise: false,
  env: { ...process.env, AGORYX_HOME: previewHome, AGORYX_USER: "Ivan", AGORYX_LIVE: "0" },
  webDir: join(root, "ui/dist"), runners: { codex: runner("codex"), claude: runner("claude") }, opsPollMs: 30,
});
const { port } = await daemon.start();
const url = `http://127.0.0.1:${port}/?t=${daemon.token}#${store.id}?view=table`;
writeFileSync(join(previewHome, "preview.json"), JSON.stringify({ port, roomId: store.id, url, home: previewHome }), { mode: 0o600 });
console.log(`Demo room; no models or personal data are used.\n${url}\nState: ${previewHome}`);
let stopping = false;
const close = async () => { if (stopping) return; stopping = true; await daemon.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
