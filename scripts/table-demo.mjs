#!/usr/bin/env node
// An isolated, reproducible room for inspecting the production table UI. No model requests or personal rooms.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgoraDaemon } from "../dist/internal/agora/daemon.js";
import { RoomStore } from "../dist/internal/agora/store.js";
import { prepareTableOp } from "../dist/internal/agora/table.js";
import { DEFAULT_SETTINGS } from "../dist/internal/agora/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previewHome = process.env.AGORYX_TABLE_DEMO_HOME || mkdtempSync(join(tmpdir(), "agoryx-table-demo-"));
const roomsRoot = join(previewHome, "rooms");
const workspace = join(previewHome, "workspace");
mkdirSync(workspace, { recursive: true });
const existing = RoomStore.list(roomsRoot).find(room => room.name === "Стіл роботи · тестова кімната");
const store = existing ? RoomStore.open(roomsRoot, existing.id) : RoomStore.create(roomsRoot, {
  name: "Стіл роботи · тестова кімната", mode: "chat", workspace, createdWorkspace: false, human: "Ivan",
  agents: [{ id: "codex", kind: "codex", label: "Codex · тестовий" }, { id: "claude", kind: "claude", label: "Claude · тестовий" }],
  settings: { ...DEFAULT_SETTINGS, network: false },
});
if (!existing) {
  const move = (raw, by = "codex") => {
    const op = prepareTableOp(store.state.table, raw, by, by === "Ivan");
    store.append({ type: "table.op", op: { ...op, ...(op.op === "brief" ? { asOfSeq: store.state.seq } : {}) } });
  };
  store.append({ type: "message.posted", message: { id: "m1", author: "Ivan", kind: "human", text: "Це тестова кімната для перевірки стола. Порівняймо один головний результат із сіткою компонентів. Дані сценарію демонстраційні.", mentions: [], wakes: false } });
  move({ op: "ask", text: "Один головний результат чи сітка компонентів?" });
  move({ op: "propose", title: "Один головний результат", body: "Один фокус під коротким оглядом. Події, джерела й аргументи доступні поруч.", q: "Q1" });
  move({ op: "propose", title: "Сітка компонентів", body: "Кілька рівноправних результатів водночас. Більше видно, але більше точок уваги.", q: "Q1" }, "claude");
  move({ op: "next", text: "Підготувати порівняння подачі", target: "P1" }, "claude");
  move({ op: "review", target: "X1" }, "claude");
  move({ op: "done", target: "X1" });
  move({ op: "next", text: "Перевірити обрану подачу на вузькому екрані", target: "P1" });
  move({ op: "fact", text: "Сценарій демонстраційний; тестові агенти не використовують моделі." });
  move({ op: "component", title: "Порівняння подачі", kind: "comparison", refs: ["Q1"] }, "claude");
  move({ op: "component", title: "План і перевірки", kind: "checks", refs: ["X1", "X2", "F1"] });
  const html = `<!doctype html><html lang="uk"><meta charset="utf-8"><style>
    :root{color-scheme:light dark}body{font:14px/1.5 system-ui;margin:18px;color:light-dark(#171717,#eeeeee);background:light-dark(#ffffff,#111111)}
    .route{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.node{padding:10px 14px;background:light-dark(#f3f3f3,#252525);border-radius:8px}
    button{font:inherit;color:inherit;background:transparent;border:1px solid light-dark(#dddddd,#454545);border-radius:8px;padding:8px 12px;margin-top:16px}
    p{margin-bottom:0}button:focus-visible{outline:2px solid currentColor;outline-offset:3px}
    </style><main><div class="route"><span class="node">Огляд</span><span aria-hidden="true">→</span><span class="node">Твій вибір</span><span aria-hidden="true">→</span><span class="node">Результат</span></div>
    <button type="button" aria-expanded="false" onclick="const p=document.getElementById('detail');p.hidden=!p.hidden;this.setAttribute('aria-expanded',String(!p.hidden));">Показати залежність</button>
    <p id="detail" hidden>Вибір визначає подачу результату. Незалежні перевірки можуть продовжуватися.</p></main></html>`;
  move({ op: "component", title: "Інтерактивна карта роботи", kind: "custom", refs: ["P1", "X2"], body: "```html\n" + html + "\n```" }, "claude");
  move({ op: "brief", now: "Порівняння подачі готове. Потрібно обрати один головний результат або сітку компонентів.", changes: ["План і перевірки прив’язані до кроків", "Інтерактивну схему створено для цієї задачі"], next: "Після вибору — перевірка вузького екрана, Codex", refs: ["W1", "X1", "X2"], awaiting: { q: "Q1", recommendation: "P1" } });
}

const execute = promisify(execFile);
const runner = kind => ({
  kind, resumeCommand: () => "",
  async run(request) {
    // Exercise the real agent-side publication path, but never start a model or invent verified results.
    const current = RoomStore.open(roomsRoot, request.env.AGORYX_ROOM).state;
    const chosen = current.table.options.find(option => option.status === "chosen");
    const args = [join(root, "bin/agoryx-agent.mjs"), "table", "brief", chosen
      ? `Обрано «${chosen.title}». Крок X2 залишається відкритим; це тестовий сценарій.`
      : "Команда отримала твій напрямок. Подачу ще не обрано; це тестовий сценарій.",
      "--next", "Перевірити обрану подачу, Codex", "--ref", "X2"];
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
console.log(`Тестова кімната; моделі й особисті дані не використовуються.\n${url}\nСтан: ${previewHome}`);
let stopping = false;
const close = async () => { if (stopping) return; stopping = true; await daemon.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
