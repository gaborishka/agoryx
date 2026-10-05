# Desktop browser pane — v1 (one shared browser per room, driven by agents over MCP)

> **Archived design — not current instructions.** This document preserves an earlier proposal or implementation record. Versions, status claims and task lists below describe that period, not the Agoryx 0.1.0 release. Use the [current documentation](../../README.md) and source for implemented behavior.


Status: planned (2026-09-29) and revised the same day after three reviews (security, feasibility, UX); see
"Review decisions" at the end. It is built alongside feature 2 (attention-aware notifications) in the same
tree. Inspired by Playwright MCP (tool names, an accessibility snapshot with element refs) and the in-app
browsers of T3 Code and Cursor (the page next to the chat).

Every CLI and Electron behaviour below was checked against Claude Code 2.1.283, Codex 0.158 and Electron
44.4.5. The probes are in the scratchpad (`wf-design/`: `sp/`, `rv/`, `rv-dialog/`, `rv-codex/`). What is
not yet checked is marked **unverified**.

## Goal

An agent in a room can open a real page and use it: start the dev server, open `localhost`, click
through it, type, read the page, and look at a screenshot. The human watches every step live in the room's
right-hand panel of `Agoryx.app`, and can take the mouse at any time.

- There is one browser per room, shared by the room's agents and the human.
- It works with `claude -p` and `codex exec`, per turn and live, with no setup: the room gives both CLIs
  its own MCP server, `agoryx mcp`.
- Without the desktop app, the tools answer with a clear error and nothing else happens.

## Out of scope for v1

- **A browser without the desktop app.** No headless Chrome or Playwright in the daemon, and no browser in
  the plain web UI (`agoryx open`).
- **More than one page per room.** No tabs. A popup loads in the same pane.
- **What the tools skip:**
  - frame content in the snapshot (frames show as `iframe` nodes), and full-page screenshots;
  - file upload (the file chooser is suppressed, for the human too) and downloads (cancelled);
  - native pickers: a `<select>` is chosen with `browser_type`; date, time, colour and file inputs are set
    with `browser_eval`;
  - drag and drop, hover-only states, printing, and clipboard shortcuts;
  - HTTP auth and client certificates (refused, with a note);
  - mobile emulation and network inspection.
- **Pages on loopback ports 7717–7736**, Agoryx's own port range (see C1).
- **A room whose network is off.** It is refused, for the agents and for the human's address bar (the app asks the daemon before it opens a page); see decision 1.
- **Keeping browser data.** Each room's cookies and storage live in memory and are gone when the app
  quits. Closing the window closes every room's page. There is no pane limit.
- **The human sending a page to the room** ("show this to the agents").
- **Notifications, and whether Ivan is looking.** Those belong to feature 2.

## Key constraints found in the code (and verified)

- **Daemon auth.**
  - `handle()` runs `checkToken` on `/api/*`. It accepts an agent key `agx1.<room>.<agent>.<hmac>` (in
    the `x-agoryx-token` header only), or the human token from the header, the cookie or `?token=`.
  - `/?t=<token>` sets the UI's HttpOnly cookie.
  - A human token sent from an agent's process tree is refused by `refuseHumanTokenFromAgent`, which uses
    `agentBehind` (lsof and ps, fail-closed, cached per socket).
  - `checkHost` allows only `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>`. A non-GET with a
    foreign Origin is refused.
  - `readBody` caps bodies at 1 MB. `HttpError` and `sendJson` are private to `daemon.ts`.
  - `stream()` is the SSE pattern: `retry: 1500`, then a `: ping` every 15 s to `sseClients`.
  - The port falls back through 20 ports from the one asked for: 7717–7736 by default.
- **Agents' environment** (`engine.ts` `agentEnv()`).
  - Every agent process gets `AGORYX_ROOM`, `AGORYX_AGENT` and `AGORYX_CLI` (the shim
    `<agoraHome>/bin/agoryx`, which execs the daemon's `node` on `bin/agoryx-agent.mjs`).
  - A per-turn process also gets `AGORYX_TURN`, `AGORYX_SEEN` and `AGORYX_AGENT_KEY`. A live process
    gets `AGORYX_TURN_FILE` instead; the room rewrites that file each turn and removes it after. ⇒ A
    long-lived MCP server reads the key **on every call**, with the rules of `applyTurnContext`.
  - Every CLI Agoryx spawns is tracked (`runners/process.ts` → `trackAgentProcess`), so `agentBehind`
    finds the agent behind any process under it.
  - `engine.presence()[agent] === "working"` while the agent's turn runs.
  - Every activity a runner reports is stored as a `turn.activity` event in the room's history.
    `describeClaudeTool`'s default case puts the tool's JSON input into `detail`.
- **Claude Code 2.1.283.**
  - `--mcp-config <configs...>` is variadic, so another flag must follow it.
  - `--strict-mcp-config` exists. Agoryx does not use it: it would drop the human's own MCP servers.
  - Tools are named `mcp__<server>__<tool>`. They are deferred (loaded with ToolSearch), and the server's
    `instructions` appear in the system prompt.
  - `permissions.allow: ["mcp__agoryx_browser__*"]` in `--settings` allows them without a prompt in
    default, acceptEdits and auto modes, with the sandbox on or off.
  - The MCP server gets claude's full environment and is not sandboxed. Image content reaches the model.
- **Codex 0.158.**
  - The keys are `-c mcp_servers.<name>.{command, args, env_vars, default_tools_approval_mode,
    startup_timeout_sec, tool_timeout_sec, supports_parallel_tool_calls}`. The last one is in the binary.
    Setting it to false made no observable difference: in the probe both runs called two tools one after
    the other.
  - The MCP server's environment is scrubbed to a default set, so `env_vars` must name the Agoryx
    variables.
  - `default_tools_approval_mode="approve"` is required. Without it, the call went to the auto-reviewer
    for about 106 s, and in live mode our client refuses an approval request (-32601).
  - The MCP server runs outside Codex's sandbox, so it reaches 127.0.0.1 even with the network off.
  - Tool calls appear as items `mcp_tool_call {server, tool, arguments, status}`.
  - `codex app-server -c mcp_servers…` starts the server, and a live turn's tool calls reach it
    (`rv-codex/live.log`). **Unverified:** the result reaching the model in a live turn. It is an E2E step,
    with a fallback.
- **Electron 44.4.5.**
  - The building blocks are `WebContentsView`, `win.contentView.addChildView` and `setBounds` /
    `setVisible`. A native view draws above the page's DOM, so any UI overlay under the pane is hidden.
  - `session.fromPartition(name)` without `persist:` is in memory (`isPersistent()` is false), and the
    same name returns the same object.
  - `webContents.debugger.attach("1.3")` gives DOM, Accessibility, Input and Runtime. `Input.insertText`
    types Cyrillic. It all works with the view hidden and the window unfocused.
  - **CDP `Page.enable` hangs on a fresh view before its first load.** Load `about:blank` first, then
    attach (`sp/run2.log`).
  - CDP `Page.captureScreenshot` hangs when the view is hidden or the window minimized.
    `capturePage(undefined, { stayHidden: true })` works, and returns device pixels.
  - **Zoom is per host.** After `setZoomFactor(0.6)`, navigating to another host resets it to 1, and coming
    back restores it. Under zoom, CDP input coordinates and content quads are CSS pixels, and
    `Page.getLayoutMetrics().cssVisualViewport` gives the CSS viewport (`sp/run3.log`).
  - **The menu roles act on the focused contents.** With the pane focused, the roles reload, zoomIn and
    toggleDevTools reload, zoom and open DevTools for the pane, not the UI (`rv/run2.log`). DevTools
    contents have type `remote` and the pane's session.
  - **Dialogs.** While a page's alert, confirm or beforeunload waits, a native sheet covers the whole
    window until CDP answers, even for a hidden pane (`rv-dialog/`). `prompt()` returns undefined in 1 ms,
    with no CDP event.
  - **beforeunload.** `loadURL` rejects with `ERR_ABORTED` (-3) at once, and `did-fail-load` -3 fires.
    Once CDP accepts the dialog, the navigation completes (`sp/run.log`). CDP `Page.navigate` returns
    normally, and the dialog follows the same way (`rv-dialog/run-bu.log`). `will-prevent-unload` fires,
    but no handler is needed.
  - **File chooser and print.** `Page.setInterceptFileChooserDialog({ enabled: true })` turns a click on
    a file input, and a script's `input.click()`, into `Page.fileChooserOpened`, with no native sheet. A
    `window.print` override from `Page.addScriptToEvaluateOnNewDocument` returns at once (`sp/run2.log`).
  - **A header set in `webRequest.onBeforeSendHeaders`** reaches the server on a cross-origin fetch, an
    img and a navigation, and adds no CORS preflight (`sp/run.log`).
  - `will-navigate` does not fire for `loadURL` or for CDP navigations.
  - Focus inside the pane makes the UI's `document.hasFocus()` false. `win.isFocused()` stays true.
  - `web-contents-created` fires while the contents are being built, with `contents.session` already set.
    Main's `guard()` would cancel every navigation in the pane, so main must recognise pane contents by
    their session.
- **The token leak this design must close.**
  - Agents can read any daemon's `daemon.json` and `daemon.token` (`actor.ts`: attribution, not a
    sandbox). A pane sent to `http://127.0.0.1:<a daemon's port>/?t=<token>` would get the UI's cookie, and
    `browser_eval` could then call that daemon's API as the human.
  - `refuseHumanTokenFromAgent` cannot see this: the request comes from Electron's network process, not
    from an agent's process group. Cookies are not scoped by port.
  - Any daemon counts, not only the app's own: another `AGORYX_HOME`, `agoryx up --port N`, the fallback
    range, and Ivan's real daemon while an E2E app runs next to it.
  - ⇒ **Two locks.** Every request from a pane carries `x-agoryx-pane: 1`, and every daemon refuses such a
    request before anything else (A2). The pane also cancels loopback requests to 7717–7736 and to every
    daemon port the app has seen (C1), which covers daemons older than this change.
- **The desktop core's imports.** `tests/desktop/imports.test.ts` walks every `internal/desktop/*.ts`.
  Their runtime imports may reach only `node:*` and dependency-free modules, never `daemon.ts`,
  `store.ts`, `engine.ts` or `service.ts`. Type-only imports are erased and allowed.
- **`desktop/tsconfig.json` has `rootDir: "src"`,** so `desktop/src` cannot import types from `internal/`
  (TS6059). `main.ts` declares local copies of the core's types, and the pane does the same.
- **Feature 2 is built in this tree at the same time.** New files are preferred over edits. Each existing
  file gets a small, named hook, listed in the file plan.

## How it fits together

```
agent CLI (claude -p | codex exec | live claude | codex app-server)
  └─ MCP over stdio: `$AGORYX_CLI mcp` → bin/agoryx-mcp.mjs (zero dependencies), server "agoryx_browser"
        │ POST /api/browser   x-agoryx-token: <agent key>   {op, args}
        ▼
daemon ── checks: the agent's turn runs, the room's network is on, the request comes from that agent's processes
        │ BrowserRelay (internal/agora/browser.ts, in memory): forwards at once, 60 s deadline, 503 without a host
        │ GET /api/browser/host (SSE, human token) → event: command {id, room, agent, label, op, args, deadline}
        │                                          → event: cancel {id}    (withdrawn: the turn ended, or the call was cancelled)
        │                                          → event: close {room}   (the room's network went off)
        ▼
Agoryx.app main ── BrowserLink (internal/desktop/browserlink.ts) → BrowserPanes (desktop/src/browserpane.ts)
        │ one WebContentsView per room, in its own in-memory session, driven over webContents.debugger (CDP);
        │ one command at a time per room
        │ POST /api/browser/answer/<id>  {ok, result | error}   (human token, body ≤ 8 MB)
        ▼
daemon → the agent's POST returns → MCP tool result (text, and a PNG for screenshots) → the model

room UI (daemon page in the window) ⇄ main: window.agoryxBrowser (preload): place / states / go / outside
```

## Part A — the daemon side

### A1. `internal/agora/browser.ts` (new): `BrowserRelay`

It imports only `node:*`, and `ActorOrigin` as a type. It has no store and no HTTP routing, so it can be
tested without a daemon. **It only relays:** the checks are the daemon's (A2), and the order is the pane's
(C1).

```ts
export type BrowserOp = "navigate" | "snapshot" | "click" | "type" | "press" | "screenshot" | "eval";
export interface BrowserCommand { id: string; room: string; roomName: string; agent: string; label: string;
  op: BrowserOp; args: Record<string, unknown>; deadline: number }            // deadline: epoch ms
export interface BrowserResult { url: string; title: string; viewport: { width: number; height: number };
  text?: string; image?: { data: string; mimeType: "image/png" }; notes?: string[] }
export interface BrowserHost { send(command: BrowserCommand): void; cancel(id: string): void;
  closeRoom(room: string): void; close(reason: "replaced" | "stopping"): void }
export class BrowserFailure extends Error { constructor(readonly status: number, message: string) }
export class BrowserRelay {
  constructor(options?: { timeoutMs?: number /* 60_000 */; maxPerRoom?: number /* 20 */; log?: (line: string) => void });
  attach(host: BrowserHost): () => void;     // detach: idempotent, and a no-op unless this host is still the current one
  command(origin: ActorOrigin, body: unknown, signal?: AbortSignal): Promise<BrowserResult>;  // signal: the agent's request closed
  answer(id: string, body: unknown): void;   // throws BrowserFailure(404) for an unknown or expired id
  endTurn(room: string, agent: string): void; // the agent's turn ended: its commands in flight are withdrawn
  closeRoom(room: string): void;             // the room's network went off
  hasHost(): boolean;
  close(): void;
}
export const sseHost: (res: ServerResponse) => BrowserHost;
```

- **`command()`**
  - Validates: `op` is one of the seven, `args` is a plain object, a string argument is at most 10 000
    characters and `expression` at most 100 000. Anything else → 400.
  - No host → **503 at once**. A command is never kept for a host that might come later.
  - More than `maxPerRoom` of the room's commands in flight → 429.
  - Otherwise it is sent to the host at once, with `deadline = now + timeoutMs`. At the deadline → 504, and
    the id is forgotten, so a late answer gets 404.
- **`answer()`** accepts only an id in flight on the **current** host (128-bit random hex).
  - `{ ok: true, result }` is checked, then resolved: `url` and `title` are strings, `viewport` has
    numbers, `image.data` is base64, `notes` is a string array, and `text` is at most 200 000 characters.
  - `{ ok: false, error }` → `BrowserFailure(422, error)`.
- **`attach()`**
  - A newer host replaces the old one. The old stream gets `event: replaced` and ends, and its commands in
    flight fail with 503.
  - Each host's detach acts only while that host is current, because the old stream's `close` fires after
    the new host is attached. Detaching the current host fails every command in flight with 503.
- **`closeRoom(room)`** fails the room's commands in flight with 403 (the network-off text) and sends
  `event: close` with `{ room }`.
- **Withdrawn commands** (added after review). `endTurn(room, agent)` runs at `turn.ended`: the agent's
  commands in flight fail with 409 ("Your turn ended while this command was in the room's browser. It may or
  may not have happened in the page."). A command whose `signal` aborts (the daemon aborts it when the
  agent's request closes before the answer) fails with 499 and frees its place in the room's 20. Either way
  the relay logs it and calls the current host's `cancel(id)`, which the SSE host writes as `event: cancel`
  with `{ id }`; a late answer gets 404.
- **`close()`** ends the host stream and fails everything with 503 ("the daemon is stopping").
- **`sseHost(res)`** writes the same headers as `stream()`, then `retry: 1500`, then `event: hello` with
  `{"version":1}`. It sends `event: command`, `event: cancel` and `event: close` as JSON data, and pings every 15 s on its
  own timer, so `sseClients` stays untouched.
- **The log** gets one line per command: `browser: <agent>@<roomName> <op> ok|<status> (<ms> ms)`. It
  never holds arguments, URLs or results.

**Agent-facing error texts** are in English, like the agent CLI:

| Status | Text |
|--------|------|
| 503, no host | `The room's browser needs the Agoryx desktop app, and it is not running (or not connected to this daemon). Nothing was opened.` |
| 409, no turn | `The room's browser works only while your turn runs.` |
| 403, network off | `This room's network is off, so its browser is off too. The human can turn the network on in the room settings.` |
| 403, wrong process | `Browser commands must come from your own turn: your CLI, or a process it started.` |
| 429 | `Too many browser commands are in flight in this room (20). Wait for the current ones.` |
| 504 | `The room's browser did not finish this command within 60 s. Commands in a room run one at a time, so a slow page or other agents' commands can cause this. It may or may not have happened in the page.` |
| 503, host gone | `The Agoryx app disconnected while running this command. It may or may not have happened in the page.` |

### A2. `internal/agora/daemon.ts`: hooks, about 50 lines

- `import { BrowserFailure, BrowserRelay, sseHost } from "./browser.js";`, `agentBehind` from
  `./agentprocs.js`, and the field `private browser = new BrowserRelay({ log: (line) => this.log(line) });`.
- **The first line of `handle()`**, before `checkHost`: a request carrying `x-agoryx-pane` → 403 `the
  room's browser cannot open Agoryx itself`. This covers `/api/*`, `/raw/`, `/?t=` and the static UI.
- `readBody(req, limit = MAX_BODY)`: a limit parameter. The default keeps every existing call unchanged.
- In `api()`, right after the `down` route and before the `rooms` 404:
  `if (parts[0] === "browser") return this.browserApi(req, res, parts.slice(1), method, caller);`.
- A private `browserApi()` with three routes. It maps `BrowserFailure` to `HttpError`.

| Route | Who | Does |
|-------|-----|------|
| `POST /api/browser` | agent key only. The human token → 403 `browser commands come from agents, under their own key; the human uses the pane itself` | In order: the key's agent has a running turn (`this.rooms.get(origin.room)?.engine?.presence()[origin.agent] === "working"`), else 409; the room's network is on, else 403; `agentBehind(req.socket)` is exactly the key's `{room, agent}` (null or `{unknown}` → 403). After the body is read, the running turn (409) and the network (403) are checked again, in the tick that calls `browser.command(origin, body, signal)` → 200 `{ ok: true, result }` |
| `GET /api/browser/host` | human token only. An agent key → 403 `only the Agoryx app hosts the room's browser` | `const detach = this.browser.attach(sseHost(res)); req.on("close", detach);` |
| `POST /api/browser/answer/<id>` | human token only | `browser.answer(id, await readBody(req, 8 * 1024 * 1024))` → 200 `{ ok: true }` |

- The room is always the key's room: an agent drives only its own room's browser. Agents can compute any
  key from `daemon.token`, so the key alone proves nothing. The process check ties a command to the
  processes of that agent's turn.
- `onRoomEvent`: a `settings.changed` event with `patch.network === false` →
  `this.browser.closeRoom(handle.id)`.
- `close()`: `this.browser.close()` next to the `sseClients` teardown, **before** `await server.close()`.
  The host stream is not in `sseClients`, so it would otherwise hold `server.close()` open.

### A3. `bin/agoryx-mcp.mjs` (new, zero dependencies): the MCP server

It exports `serve({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {})`, which
resolves when stdin ends.

**The shim hook.** `bin/agoryx-agent.mjs` `main()` gets one block before the full-CLI branch:

```js
if (command === "mcp") { const { serve } = await import("./agoryx-mcp.mjs"); await serve(); return; }
```

`mcp` is not in the agents' USAGE: agents never run it by hand; the room hands it to their CLI.

**The protocol:** JSON-RPC 2.0, one message per line, on stdin and stdout.

- `initialize` answers with:
  - `protocolVersion`: the client's, if it is one of `["2025-11-25", "2025-06-18", "2025-03-26",
    "2024-11-05"]`, otherwise the first of them;
  - `capabilities: { tools: { listChanged: false } }`;
  - `serverInfo: { name: "agoryx_browser", title: "Agoryx room browser", version }`, with the version from
    `../package.json`;
  - `instructions`, the text below.
- `tools/list` answers with the seven tools. `tools/call` runs one. `ping` answers `{}`.
- A notification (no `id`) gets no answer. An unknown method → -32601. Unparseable JSON → -32700 with
  `id: null`. A JSON array (batch) → -32600. An unknown tool name → -32602.
- Wrong arguments are a tool error (`isError: true`), not a JSON-RPC error, as MCP expects.
- Calls are handled concurrently, and each answer carries its request's id.
- stdout carries only protocol messages. stderr stays silent unless `AGORYX_MCP_DEBUG=1`.

**The key, read on each call.**

- If `AGORYX_TURN_FILE` is set, the key comes from that file. It counts only when the file's `turn` and
  `seen` are strings, its `agent` equals `AGORYX_AGENT`, and its `room` equals `AGORYX_ROOM`.
- Otherwise the key is `AGORYX_AGENT_KEY`.
- No key → a tool error: `Not in a turn: the room's browser works only while your turn runs.`

**The daemon.**

- The server finds `<agoraHome>/daemon.json` with the rules of `internal/agora/paths.ts`: `AGORYX_HOME`,
  otherwise `${XDG_STATE_HOME || HOME/.local/state}/agoryx/agora`.
- It uses **only `url`** from that file. It never reads the `token` field.
- No file → a tool error: `No Agoryx daemon is running here (<path> not found).`

**The call.** `fetch(url + "/api/browser", { method: "POST", headers: { "content-type":
"application/json", "x-agoryx-token": key }, body: JSON.stringify({ op, args }), signal:
AbortSignal.timeout(75_000) })`. A non-2xx response → a tool error with the daemon's `error` text. A
timeout → `The Agoryx daemon did not answer within 75 s.`

**The result.** The content is `[{ type: "text", text }]`, plus `{ type: "image", data, mimeType:
"image/png" }` for a screenshot. The text:

```
Page: <title>
URL: <url>
Viewport: 1280×1330 CSS px
Notes:
- Codex used this browser since your last command: navigate http://localhost:5173/settings, type e5 (12 characters)
<blank line>
<op-specific text>
```

**`instructions`** (English, shown to the model):

> The Agoryx room's browser: one real browser page per room, shown live to the human in the Agoryx app
> and shared with the other agents in the room. What you open, they and the human see. In a room's first
> round all agents start at once, so another agent may be using this page at the same time; every result
> lists what others did since your last command. It works only during your turn and only while the Agoryx
> app is open.
> - browser_navigate opens a page (http or https, for example a dev server on localhost).
> - browser_snapshot reads the page as an outline. Elements get refs like e12, which stay valid while the
>   element is on the page.
> - browser_click, browser_type and browser_press act on the page. To choose in a <select>, use
>   browser_type with the option's label.
> - browser_screenshot shows the page as an image. browser_eval runs JavaScript in it.
>
> Call browser tools one at a time and wait for each result. The page is laid out 1280 CSS px wide, and
> coordinates are CSS pixels of the viewport. While your command runs, alert and beforeunload are accepted
> and confirm is dismissed; prompt() returns no value. Clipboard shortcuts, file upload and printing are not
> available.

### A4. The tools

The input schemas are flat JSON objects with the optional properties the table shows. There is no
top-level `oneOf`: OpenAI tool schemas need a plain object, and the server checks the combinations
itself. `browser_snapshot` and `browser_screenshot` carry `annotations: { readOnlyHint: true }`, and every
tool carries `openWorldHint: true`.

| Tool | Input | What the pane does | Result text |
|------|-------|--------------------|-------------|
| `browser_navigate` | `url?: string` or `go?: "back" \| "forward" \| "reload"`, exactly one | `url`: checked by `paneUrl()`, then CDP `Page.navigate`. An `errorText` is a tool error, `Could not load <url>: <errorText>`, except `net::ERR_ABORTED` (a beforeunload guard or a redirect), which waits. `go`: the navigation history. Then waits for `did-stop-loading`, up to 30 s. | `Loaded.`, or a note `still loading after 30 s` |
| `browser_snapshot` | `waitForText?: string`, `timeoutMs?: int ≤ 30000` (default 5000 with `waitForText`) | Polls `document.body.innerText` every 250 ms until the text appears, then reads `Accessibility.getFullAXTree` | An outline with refs, up to 40 000 characters, then `Console (latest errors and warnings):` with up to 20 lines. A missing `waitForText` is a note, not an error. |
| `browser_click` | `ref?: string`, or `x?: number` with `y?: number` | A ref: scroll into view, take the centre of its content quad. Hit-test the point with `DOM.getNodeForLocation`. A `<select>`, or an input of type color, date, datetime-local, month, week, time or file, is not clicked, since its native picker would open over Ivan's screen. Otherwise the mouse is moved, pressed and released. If a navigation starts within 500 ms, waits for its load (up to 30 s). | `Clicked e12 (button "Зберегти").` A note when the point hit another element: `the click landed on <role "name">; something covers e12`. For a select: `e7 is a <select>, so it was not clicked; choose with browser_type and the option's label.` For a picker: `e9 is a date input, so it was not clicked; set its value with browser_eval.` |
| `browser_type` | `ref: string`, `text: string`, `clear?: boolean = true`, `submit?: boolean = false` | On a `<select>`: chooses the option whose label, or else value, equals `text`, through the DOM, and fires `input` and `change`. Otherwise it focuses the node; `clear` selects its content first (`select()`, or a selection over a contenteditable); then `Input.insertText`. `submit` presses Enter. | `Typed 12 characters into e5.` or `Selected "Київ" in e7.` An unknown option is a tool error listing up to 20 labels. |
| `browser_press` | `key: string` | Key strokes from `keyEvents()`, sent to the focused element | `Pressed PageDown.` |
| `browser_screenshot` | `ref?: string` | `capturePage(rect?, { stayHidden: true })`, resized to the CSS viewport. A ref crops to its box (CSS box × zoom), clamped to the viewport, after scrolling it into view. | `Screenshot of the viewport (1280×1330 CSS px).` plus the PNG |
| `browser_eval` | `expression: string` | `Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true })`, raced against 20 s | JSON of the value (up to 20 000 characters), or `undefined`. An exception is a tool error with its description. |

**Why these seven.**

- Playwright MCP's names are familiar to both models.
- Seven general tools instead of Playwright's ~25: Codex puts every schema into every turn, while Claude
  defers them.
- The outline with refs lets an agent act without guessing pixels. Coordinates stay available for
  canvases and for what a screenshot shows.
- `press` covers scrolling (PageDown, End, Space). `snapshot.waitForText` covers the common wait.
  `eval` covers the rest: waiting on a condition, reading `localStorage`, stubbing `window.confirm`,
  setting a date input.

**Refs.** Each pane keeps a `RefTable` from ref to `backendDOMNodeId`.

- Numbers are handed out once and **never reused** within the pane. A ref from any agent's snapshot stays
  valid while the node lives, even after another agent took a newer snapshot.
- A main-frame navigation drops the old mappings, but the counter keeps going. A stale ref fails with
  `ref e12 is not on the page anymore (it changed or navigated). Take a new browser_snapshot.` It never
  hits a different element.

### A5. `internal/agora/browsertools.ts` (new, dependency-free): what the runners share

```ts
export const BROWSER_SERVER = "agoryx_browser";
export const MCP_ENV_VARS = ["AGORYX_ROOM", "AGORYX_AGENT", "AGORYX_TURN", "AGORYX_SEEN", "AGORYX_AGENT_KEY",
  "AGORYX_TURN_FILE", "AGORYX_HOME", "XDG_STATE_HOME"];
/** `{"mcpServers":{"agoryx_browser":{"type":"stdio","command":<AGORYX_CLI>,"args":["mcp"]}}}`, or null without the shim. */
export const claudeMcpConfig: (env: NodeJS.ProcessEnv) => string | null;
/** The `-c mcp_servers.agoryx_browser.*` pairs (TOML values: JSON-quoted strings, arrays), or [] without the shim. */
export const codexMcpArgs: (env: NodeJS.ProcessEnv) => string[];
/** One step without its values: "navigate http://localhost:5173/settings", "click e12", "click at 320,140",
 *  "type e5 (12 characters)", "press Enter", "screenshot", "eval (340 characters)". At most 160 characters. */
export const browserStep: (op: string, args: unknown) => string;
/** The trace entry for a browser tool call: { kind: "browser", label: "browser " + browserStep(…) }, never a detail
 *  or a command; null for any other tool. */
export const describeBrowserTool: (tool: string, args: unknown) => { kind: "browser"; label: string } | null;
```

- `browserStep` shows a URL as origin and path only, without userinfo, query or fragment. `type` and
  `eval` show a character count, never the text.
- `codexMcpArgs` returns these pairs:

  ```
  -c mcp_servers.agoryx_browser.command="<AGORYX_CLI>"   -c mcp_servers.agoryx_browser.args=["mcp"]
  -c mcp_servers.agoryx_browser.env_vars=[<MCP_ENV_VARS>]
  -c mcp_servers.agoryx_browser.default_tools_approval_mode="approve"
  -c mcp_servers.agoryx_browser.startup_timeout_sec=20   -c mcp_servers.agoryx_browser.tool_timeout_sec=90
  -c mcp_servers.agoryx_browser.supports_parallel_tool_calls=false
  ```

- The tools are given whenever the room has the shim (`AGORYX_CLI` is set), the same condition the
  `Bash(<shim> table *)` rules use today. The runner tests have no shim, so their arguments stay exactly as
  they are.

### A6. Runner hooks

**`internal/agora/types.ts`:** `ActivityKind` gets `"browser"`. The UI gets it through `@agora/types`.

**`internal/agora/runners/claude.ts`**

- `buildClaudeSettings`: add `...(shim ? ["mcp__agoryx_browser__*"] : [])` to `permissions.allow`.
- `buildClaudeArgs`: put `...(mcp ? ["--mcp-config", mcp] : [])` right **before** `"--settings"`, so the
  variadic flag ends there. Here `mcp = claudeMcpConfig(request.env)`.
- The live args come from `buildClaudeArgs`, and the live fingerprint includes the args, so a live Claude
  restarts once with the server.
- `describeClaudeTool`: first, when `name.startsWith("mcp__agoryx_browser__")`, return
  `describeBrowserTool(name.slice(21), input)`. This runs before the default case, which would store the
  JSON input, typed text included, in `detail`.

**`internal/agora/runners/codex.ts`**

- `buildCodexArgs`: `common.push(...codexMcpArgs(request.env))`, next to the existing
  `-c sandbox_workspace_write…`. It covers `exec` and `exec resume`.
- `CodexLiveProcess`: spawn `["app-server", ...codexMcpArgs(request.env)]`. The fingerprint already
  includes `request.env`, from which the arguments are derived.
- `describeCodexItem` `mcp_tool_call`: when `server === "agoryx_browser"`, use
  `describeBrowserTool(tool, item.arguments)` with the item's status.
- The live item mapping (`mcpToolCall` → `mcp_tool_call`) also passes `arguments: item.arguments`. They
  are read for the label, never stored.

**Fallback if the live result does not reach the model in E2E:** pass the same server as
`config.mcp_servers.agoryx_browser` in `buildCodexThreadParams` (`thread/start`) instead of `-c` on
`app-server`.

## Part B — the desktop core, `internal/desktop/` (the imports test covers these files)

### B1. `internal/desktop/browserlink.ts`: `BrowserLink`, the host client

```ts
import type { BrowserCommand, BrowserResult } from "../agora/browser.js";   // type-only: erased
export type BrowserCommandWire = BrowserCommand;   // the canonical wire type; desktop/src keeps a local copy (rootDir)
export type BrowserAnswer = { ok: true; result: BrowserResult } | { ok: false; error: string };
export class BrowserLink {
  constructor(options: { url: string; token: string; handle: (command: BrowserCommandWire) => Promise<BrowserAnswer>;
    closeRoom: (room: string) => void; cancel?: (id: string) => void; log?: (line: string) => void });
  start(): void;  stop(): void;  get connected(): boolean;  get running(): boolean;
}
```

- It opens `GET <url>/api/browser/host` over `node:http` with the header `x-agoryx-token: <token>` (never
  in the URL). The stream and the answers share one keep-alive agent, so answers reuse a socket the
  daemon has already checked.
- It parses SSE: `event:` and `data:` lines, dispatched on a blank line; `:` comments are ignored.
- `command` → `handle(command)`, then `POST /api/browser/answer/<id>`. A handler that throws becomes
  `{ ok: false, error: message }`. A failed answer POST (a network error, or a 403 when the daemon's
  process check fails closed) is retried once, then logged.
- `close` → `closeRoom(room)`.
- `cancel` → `cancel(id)`: the pane skips that command if it has not started it (a command already running
  runs to its end, like one past its deadline).
- `replaced` → stop without reconnecting: another app took over.
- On error or end, it reconnects with backoff 0.5, 1, 2, 4, 8, 10 s…, reset by a `hello`. `stop()` ends
  the stream and the timers.
- It hands commands on as they arrive. The pane orders them.

### B2. `internal/desktop/browserpage.ts`: pure helpers, no Electron

- `paneUrl(input, blocked: (port: number) => boolean): { url: string } | { error: UrlError }`, with
  `type UrlError = "empty" | "too-long" | "invalid" | "scheme" | "agoryx"`, and `URL_ERROR_TEXT:
  Record<UrlError, string>` in English for agents. The UI maps each code to Ukrainian.
  - It trims the input and refuses more than 8 000 characters.
  - A bare `host[:port][/path]` gets `http://` for loopback names and `https://` otherwise.
  - It allows `http:`, `https:`, and exactly `about:blank`.
  - It refuses a loopback host whose effective port (80 or 443 by default) is blocked.
- `isLoopbackHost(hostname)`: strip the brackets and one trailing dot, lower-case. Then `localhost` and
  `*.localhost`; with `net.isIP`, IPv4 `127.0.0.0/8` and `0.0.0.0`; IPv6 `::1`, `::`, and the IPv4-mapped
  `::ffff:7f00:0/104`, checked numerically. The URL parser has already turned `127.1`, `0x7f.1` and
  `2130706433` into `127.0.0.1`, and `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`.
- `AGORYX_PORTS` (7717–7736) and `isAgoryxAddress(url, seen: Set<number>)`: a loopback host with an
  effective port in that range or in `seen`.
- `class RefTable`: `ref(backendNodeId)`, `node(ref)`, `forgetDocument()`. The counter is monotonic and
  never reused.
- `formatSnapshot(nodes: AXNode[], refs, { maxChars = 40_000 })` turns the CDP AX nodes into lines like
  `- role "name" [level=2] [checked] [ref=e7]: value`, indented by depth.
  - Ignored nodes are skipped. Unnamed `generic`, `none`, `presentation`, `LineBreak` and
    `InlineTextBox` nodes are dropped, and their children move up.
  - `StaticText` becomes `- text: "…"` unless it repeats its parent's name. A link shows `-> <href>`.
  - Refs go only to nodes with a `backendDOMNodeId` and an interactive role, or a named one.
  - At `maxChars`, the output ends with `… N more nodes (scroll, or narrow down with browser_eval)`.
- `keyEvents(spec): KeyStroke[] | { error }` returns the fields for `Input.dispatchKeyEvent`: `type`,
  `key`, `code`, `windowsVirtualKeyCode`, the `modifiers` bitmask, and `text`. **There is no `commands`
  field**, so nothing reaches the clipboard.
  - It knows Enter, Tab, Escape, Backspace, Delete, the four arrows, Home, End, PageUp, PageDown, Space,
    F1–F12, and single characters, with the modifiers `Shift+`, `Control+`/`Ctrl+`, `Alt+`/`Option+` and
    `Meta+`/`Cmd+`.
  - `Meta+c`, `Meta+v` and `Meta+x` → `{ error: "clipboard shortcuts are not available in the room's
    browser; browser_type types text" }`. Other Meta shortcuts are sent as plain keys, which Chromium on
    macOS may ignore; `browser_type` with `clear` covers select-all.
- `browserStep`, re-exported from `../agora/browsertools.js` (dependency-free), for the notes.
- `clip(text, max)` shortens text and adds a `… (N more characters)` suffix.

## Part C — the pane in Electron, `desktop/src/browserpane.ts` (new) and hooks

### C1. `BrowserPanes`

Main loads it statically. It loads `browserlink.js` and `browserpage.js` from `<root>/dist/internal/desktop/`
with a dynamic `import()` on the first `connect()`, as main loads the core, and declares the wire types
locally. Main's `DesktopCore` interface stays untouched. If `dist/` is missing, it logs a line and never
attaches as host, so agents get the 503.

```ts
export class BrowserPanes {
  constructor(options: { root: string; trustedUi: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
    userGesture: (contents: WebContents) => boolean; log?: (line: string) => void });
  owns(contents: WebContents): boolean;      // contents.getType() !== "remote" && one of the pane sessions
  attachWindow(win: BrowserWindow): void;    // the main window: panes live in it
  connect(info: { url: string; token: string; port: number }): void;
  listen(): void;                            // IPC handlers, and the app's certificate and login handlers
  close(): void;                             // stops the link, closes every pane
}
```

**`connect()`** adds `info.port` to the blocked ports. That set only grows and is never cleared, also
while main has no daemon. It is a no-op when the url and the token are unchanged and the link is running;
it restarts the link only on a real change. (`showDaemon` also runs on re-render, on reopening the window
and on each supervisor event.)

**The sessions.** Each room has its own: `session.fromPartition("agoryx-browser-" + room)`, without
`persist:`, so it is in memory and gone when the app quits. Nothing reaches disk, and rooms share no
cookies, storage or service workers. Each session is set up once, when it is first made:

- `setPermissionRequestHandler` and `setPermissionCheckHandler` → always false. That includes
  notifications, `clipboard-read`, `clipboard-sanitized-write` and `fileSystem`.
  `setDevicePermissionHandler` → false.
- `select-hid-device`, `select-serial-port` and `select-usb-device` → `preventDefault()`, and the callback
  with nothing.
- `will-download` → `preventDefault()`, and a note: `a download was refused (<file name>)`.
- `webRequest.onBeforeSendHeaders` adds `x-agoryx-pane: 1` to every request.
- `webRequest.onBeforeRequest({ urls: ["<all_urls>"] })` cancels:
  - `isAgoryxAddress(url, seenPorts)`, for every resource type (each redirect hop is its own request);
  - `file:`, `chrome:`, `devtools:` and `chrome-extension:` URLs;
  - main-frame or sub-frame navigations to anything but http(s) and `about:blank`.
- `setUserAgent`: the default user agent without the ` Electron/…` and app tokens, so sites treat the
  pane as Chrome.

`listen()` also installs, once, the app's `select-client-certificate` and `login` handlers. For contents
that `owns()`, they call `preventDefault()` and the callback with nothing, and add a note: `<host> asked
for a client certificate; none was sent` or `<host> asked for a sign-in; none was given`.

**A pane**, one per room, is made on the first command or the human's first navigation:

- `new WebContentsView({ webPreferences: { partition: <the room's>, sandbox: true, contextIsolation: true,
  nodeIntegration: false, webviewTag: false, backgroundThrottling: false, spellcheck: false, safeDialogs:
  true } })`, with **no preload**.
- `setAudioMuted(true)`, `setVisualZoomLevelLimits(1, 1)`, and a white background.
- Bounds: the last placed bounds, or 760×800. `addChildView`, `setVisible(false)`, load `about:blank`,
  and **only then** `debugger.attach("1.3")`.
- **The guard.**
  - `will-navigate`, `will-frame-navigate` and `will-redirect` → the `paneUrl` policy. A refusal calls
    `preventDefault()` and adds a note: `a navigation to <url> was blocked: <reason>`.
  - `setWindowOpenHandler`: an allowed URL loads in the same pane. It always returns `{ action: "deny" }`.
  - `will-attach-webview` → `preventDefault()`.
- **CDP.**
  - `Page`, `Runtime`, `Log`, `DOM` and `Accessibility` are enabled.
  - `Page.setInterceptFileChooserDialog({ enabled: true })`, set again after each main-frame navigation
    (the probe checked one document). `Page.fileChooserOpened` → a note: `a file chooser was suppressed;
    file upload is not supported`.
  - `Page.addScriptToEvaluateOnNewDocument` replaces `window.print` with a console warning, which shows in
    the console lines.
  - Console errors and warnings go into a ring buffer of 50: `Runtime.consoleAPICalled` (error or
    warning), `Runtime.exceptionThrown`, and `Log.entryAdded` (error).
  - `Page.frameNavigated` on the main frame → `refs.forgetDocument()`.
  - An unexpected `detach` → re-attach once, otherwise the pane counts as crashed.
- **Dialogs** (`Page.javascriptDialogOpening`).
  - **While an agent's command runs in that pane:** alert and beforeunload are accepted, and confirm is
    dismissed, each with a note. A dismissed one reads: `confirm("…") was dismissed. Agoryx does not answer
    confirm for agents; stub window.confirm with browser_eval first to test that path.` The native sheet
    shows for a moment, until CDP answers.
  - **With no command running:** in a pane on screen, the dialog is the human's. The native sheet stays,
    and nothing is noted. In a hidden pane, it is answered the same way, with a note for the room's next
    result, so a room Ivan is not looking at never blocks the window.
  - `prompt()` returns no value at once, with no event. The instructions say so.
- **Page state.** `did-navigate`, `did-navigate-in-page`, `page-title-updated`, `did-start-loading` and
  `did-stop-loading` update the pane's state and push it to the UI, throttled to 100 ms per room.
- **The human's hand.** `input-event` while no command runs records `humanInputAt`.
- **A crash.** `render-process-gone` marks the pane as crashed.
  - The next agent command replaces it with a fresh pane on `about:blank`, with the note `the page crashed
    (<reason>); this is a fresh, empty page`.
  - The human's «Оновити» makes a fresh pane and loads the last URL. His address bar makes a fresh pane and
    loads what he typed.
  - Nothing reloads by itself.
- **Closing.** When the window closes, every pane closes, and its commands fail with `The Agoryx window is
  closed, and the room's browser lives in it. The human can reopen it from the Dock.` The link's `close`
  (the room's network went off) closes that room's pane.

**The viewport.** The page is laid out 1280 CSS px wide and scaled into the pane with
`setZoomFactor(min(1, bounds.width / 1280))`, so agents get a desktop layout and Ivan sees the whole page.

- Zoom is per host, so the pane sets it again on `did-navigate`, on `zoom-changed`, and before every
  command.
- The `Viewport:` line and the screenshot's size come from `Page.getLayoutMetrics().cssVisualViewport` at
  each command, never from the bounds.
- The capture (device pixels) is resized to that CSS size, so image pixels equal click coordinates.

**Running a command.**

- Commands run through a promise chain per room, in arrival order, one at a time within a room.
- A command whose `deadline` has passed when its turn comes is skipped: the relay has already answered
  504. A running command stops waiting at its deadline. What it did in the page stays.
- The driver `{ agent, label, op, at }` goes to the UI at the start. It is cleared 3 s after the end, so
  the live dot lingers briefly.
- Each op has its own limit inside the relay's 60 s: navigate load 30 s, snapshot wait up to 30 s,
  eval 20 s, and 10 s each for click, type, press and screenshot.

**Notes, collected into each result.** Each note is a fact, never advice. They count what happened since
*this agent's* last command in the room:

- for each other agent: `<label> used this browser since your last command: <step>, <step>`, with the
  value-free steps of `browserStep` (up to 10, then `and N more`);
- `the human used this browser since your last command`, when `humanInputAt` is later;
- dialogs, suppressed file choosers, refused downloads, certificates and sign-ins, blocked navigations,
  and a crash;
- `N new console errors (browser_snapshot lists them)`.

**Placement.** `place(room, rect | null)` comes from the UI.

- With a rect: `bounds = round(rect × win.webContents.getZoomFactor())`. That room's pane becomes visible
  at those bounds, and every other pane is hidden.
- With `null`: hide all. A room with no pane only remembers the bounds.
- `attachWindow` also hides every pane when the UI's main frame starts a new document
  (`did-start-navigation`, main frame, not same-document) and when the UI's renderer is gone. That covers
  the start page, reloads and crashes without any hook in `show()`.

**IPC.** Each handler first checks `trustedUi(event)`.

| Channel | Kind | Payload |
|---------|------|---------|
| `agoryx:browser:place` | `on` | `(room: string, rect: {x, y, width, height} \| null)` |
| `agoryx:browser:states` | `handle` | → `BrowserPaneState[]` |
| `agoryx:browser:go` | `handle` | `(room, target: string \| "back" \| "forward" \| "reload")` → `{ ok: true } \| { error: UrlError }`. The human's own navigation, with the same URL policy. It makes the pane if needed. |
| `agoryx:browser:outside` | `handle` | `(room)`: only after the human's click in the UI within the last 2 s (`userGesture(event.sender)`), and only an http(s) URL, without userinfo, to `shell.openExternal` |
| `agoryx:browser:state` | push to the main window | `BrowserPaneState` |

`BrowserPaneState` is `{ room, url: string | null, title, loading, canGoBack, canGoForward, crashed, driver:
{ agent, label, op, at } | null }`.

### C2. `desktop/src/main.ts`: hooks, about 25 lines

```ts
import { BrowserPanes } from "./browserpane.js";
// next to fromStartPage():
const trustedUi = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  win !== null && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame &&
  isDaemonUrl(event.senderFrame?.url ?? "") && !isPreviewUrl(event.senderFrame?.url ?? "");
const panes = new BrowserPanes({ root: agoryxRoot(), trustedUi, userGesture: (contents) => takeGesture(contents) });
// createWindow(), after `win = next`:            panes.attachWindow(next);
// showDaemon(info), after `daemon = info`:       panes.connect(info);   // idempotent
// listen():                                      panes.listen();
// web-contents-created:  (_e, contents) => { if (!panes.owns(contents)) guard(contents); }
// before-quit:                                   panes.close();
```

**The «Вигляд» menu.** Its roles act on the focused contents, so with the pane focused they would reload
it, zoom it (breaking the agents' coordinates) or open its DevTools. «Оновити», «Оновити повністю»,
«Інструменти розробника», «Справжній розмір», «Збільшити» and «Зменшити» become `click` items with the
roles' accelerators, acting on `win.webContents`: `reload()`, `reloadIgnoringCache()`, `toggleDevTools()`,
and `setZoomLevel()` to 0 or ±0.5.

### C3. `desktop/src/preload.cts`: one more block

This is a separate block, for the daemon's page only. Feature 2 has no preload, no IPC and no renderer global.

```ts
if (location.protocol === "http:" && !location.pathname.startsWith("/raw/")) {
  contextBridge.exposeInMainWorld("agoryxBrowser", {
    place: (room: string, rect: unknown) => ipcRenderer.send("agoryx:browser:place", room, rect),
    states: () => ipcRenderer.invoke("agoryx:browser:states"),
    go: (room: string, target: string) => ipcRenderer.invoke("agoryx:browser:go", room, target),
    outside: (room: string) => ipcRenderer.invoke("agoryx:browser:outside", room),
    onState(callback: (state: unknown) => void): () => void { /* like agoryxDesktop.onState */ },
  });
}
```

Child windows of the daemon page also get the object, and main refuses their calls, because the sender is
not the main window.

## Part D — the room UI (`ui/`)

**Where it lives.** The browser is the right-hand side panel of the Agoryx window (`panel: "browser"`),
next to Документ and Сесія агента. The room and the page are seen together, and the panel's show, hide
and overlay behaviour already exists.

- **Width.** Docked, the browser panel always takes the wide width (`min(760px, 52vw)`) and has no
  Ширше/Вужче button. It never touches the `wide` setting that Документ and Сесія агента use. In the
  overlay layout (below 1181 px) it takes the overlay width, like the others.
- **It never opens by itself.** A pulsing dot on «Браузер» shows that an agent is driving.

**New files**

- `ui/src/lib/desktop.ts`
  - `browserBridge(): AgoryxBrowser | null` reads the typed `window.agoryxBrowser`.
  - A module-level map of `BrowserPaneState` per room, filled from `states()` and `onState`.
  - `useBrowserState(room)`, built on `useSyncExternalStore`.
- `ui/src/components/browser/BrowserPanel.tsx`
  - **The toolbar**, in plain buttons with native `title` tooltips (Radix popovers would open under the
    native view): «Назад», «Вперед», «Оновити», the address field (`aria-label="Адреса"`, placeholder
    «Адреса сторінки», Enter calls `go(room, value)`), and «Відкрити у своєму браузері».
  - **A refusal** from `go()` shows as a line under the address field: «Цю адресу не відкрити: <reason>.»
    The reasons by code: `agoryx` «це адреса самого Agoryx»; `scheme` «можна лише http і https»; `invalid`
    «це не схоже на адресу»; `too-long` «адреса задовга». `empty` shows nothing.
  - **The driver line**, while an agent drives: «Claude натискає…» (the label, the verb, an ellipsis).
    The verbs: navigate «відкриває сторінку», snapshot «читає сторінку», click «натискає», type «вводить
    текст», press «натискає клавішу», screenshot «робить знімок», eval «виконує скрипт».
  - **The crashed line:** «Сторінка аварійно закрилася. Натисніть «Оновити» або дочекайтеся наступної дії
    агента.»
  - **The placeholder** `div` (flex-1, white). While the room has no pane, it shows «Тут з'явиться
    сторінка, яку відкриє агент. Можна відкрити й самому: введіть адресу вгорі.»
  - **Placement.** A layout effect measures `getBoundingClientRect()` on a `ResizeObserver`, on window
    `resize`, and on the aside's `animationend`. It sends `place(room, rect)`, or `null` while a dialog,
    the palette or the narrow navigation is open, and `null` on unmount.
- `ui/src/components/browser/BrowserToggle.tsx`
  - A header button like «Документ»: `GlobeIcon`, «Браузер», `aria-pressed`, and the pulsing dot while an
    agent drives in this room.
  - Its tooltip: «Спільний браузер кімнати: агенти відкривають у ньому сторінки, а ви бачите кожен
    крок».
  - Its click is `togglePanel("browser")`.
  - It renders nothing when `browserBridge()` is null, so the plain web UI never shows it.

**Hooks in existing files**

- `ui/src/lib/store.ts`: `export type PanelTab = "doc" | "session" | "browser";`.
- `ui/src/App.tsx`:
  - `SidePanel`: the title «Браузер» with `GlobeIcon`; the wide width and no Ширше/Вужче button for
    `panel === "browser"` when docked; a branch that renders the lazy `<BrowserPanel />` directly, not
    inside the doc's scroll wrapper; `loadBrowserPanel` next to the other lazy loaders.
  - `<Toaster position={panel === "browser" ? "bottom-left" : "bottom-center"} />`, so toasts stay in the
    room column instead of under the page.
- `ui/src/components/room/RoomHeader.tsx`: `<BrowserToggle />` right before the «Документ» button.
- `ui/src/components/room/Feed.tsx`: the live label maps `browser` to «працює в браузері».
- `ui/src/components/room/Trace.tsx` and `ui/src/components/session/SessionPanel.tsx`: `browser:
  GlobeIcon` in their `ICON` records (both are exhaustive).

**Known limitations**

- A Radix popover or tooltip that reaches over the page is hidden under it.
- With focus in the page, the UI's own keys (⌘K, Esc) go to the page; a click in the room brings them
  back. The «Вигляд» menu (⌘R, ⌘+, ⌘−) always acts on the UI.
- An agent's alert or confirm shows a native sheet for a moment.

## Concurrency, attribution, timeouts

- **Attribution.**
  - Every command carries the agent's key and comes from that agent's turn processes. The daemon resolves
    the key with `agentOrigin` into `{ room, roomName, agent, label }`.
  - The pane shows «<label> <verb>…». The turn's trace shows the step, e.g. `browser click e12` or
    `browser type e5 (12 characters)`, and it is stored in the room history like any tool step, without
    values.
  - Nothing is signed as the human, and nothing happens in the pane without an agent's command or the
    human's hand.
- **Order.**
  - The pane runs one command at a time per room, in arrival order across agents. Each command is atomic:
    a click is move, press and release inside one command.
  - Other agents may act between two commands of yours; the notes say what they did, and refs stay valid.
    In the first round all agents start at once, and the instructions say so.
  - Nothing stronger (a lock, or turns at the pane) in v1. The conflicting E2E run decides whether it is
    needed.
  - Rooms run in parallel.
- **Limits.**

  | Where | Limit | On expiry |
  |-------|-------|-----------|
  | MCP server → daemon | 75 s | tool error |
  | Relay deadline (waiting in the pane's chain included) | 60 s from arrival | 504; the pane skips the command if it has not started |
  | Pane: navigate load | 30 s | a result with the note `still loading after 30 s` |
  | Pane: `waitForText` | up to 30 s (default 5 s) | a note, and the snapshot anyway |
  | Pane: click, type, press, screenshot | 10 s | tool error |
  | Pane: eval | 20 s | tool error |
  | Codex `tool_timeout_sec` / `startup_timeout_sec` | 90 s / 20 s | Codex fails the call / has no server |
  | Commands in flight per room | 20 | 429 |
  | Answer body | 8 MB (commands stay at 1 MB) | 413 |

## Security

1. **The human token reaches neither the pane nor the MCP server.**
   - Every daemon refuses a request carrying `x-agoryx-pane` before its Host, token and `?t=` checks, and
     every pane request carries it. This holds for any daemon of this version, whatever its port or home.
   - The pane also cancels loopback requests to 7717–7736 and to every daemon port the app has seen, for
     every resource type and redirect hop, also while the app has no daemon. What remains open: a daemon
     older than this change, on a port outside that range that the app never saw.
   - The MCP server reads only `url` from `daemon.json` and sends the agent key. Main's link sends the
     token in a header, never in a URL.
   - The daemon's Host check already refuses DNS-rebinding names.
2. **The pane has nothing to give away.**
   - It has no preload, and runs sandboxed with context isolation, no Node, and no webview.
   - Each room has its own in-memory session, which shares nothing with the UI or other rooms.
   - Every permission is denied, clipboard and file system included, and every device picker.
   - Client certificates and HTTP sign-ins are refused, not left to Electron's defaults.
   - The file chooser is suppressed, `window.print` does nothing, downloads are cancelled, and clipboard
     shortcuts are refused.
   - `file:` and non-web schemes are refused, and a popup loads in the same pane.
   - DevTools never open for it: the menu acts on the UI.
3. **IPC.** Only the main window's daemon page may call `agoryx:browser:*`. `/raw/` previews and child
   windows may not. The preload checks the page and main checks the sender again. Opening a page outside
   needs the human's click.
4. **Commands come from the agent's own running turn.**
   - `POST /api/browser` takes an agent key only, and then needs a running turn of that agent (409
     otherwise) and a request from that agent's processes (`agentBehind`, fail-closed). A key computed from
     `daemon.token` for another room or agent, or a process left running after the turn, is refused.
   - Host and answer take the human token only, and the existing agent-process check refuses the human
     token from agents' processes. Answer ids are random and must be in flight on the current host.
5. **Network-off rooms are refused, and turning the network off closes the room's pane.** Agents can turn
   a room's network on with their own key: the room shows it as a settings note. It is a visible setting,
   not an enforced boundary. Read-only rooms are allowed: the browser writes no files, and downloads are
   refused (decision 8).
6. **Browser data stays in memory, per room.** Sign-ins last until the app quits and never cross rooms.
7. **What is kept.** The daemon log line holds only the agent, the room, the op, the outcome and the time.
   The room history holds each step without values, like a Bash command in the trace. Agoryx keeps no
   screenshots, snapshots, page text or typed values. (The agent CLI's own session log holds its tool
   calls, as it does for every tool; that log is the CLI's.)
8. **Page content is untrusted input to the agent,** as with WebFetch. The pane gives it no reach beyond
   the web: no files, no daemon, no UI. It can reach loopback and LAN services such as dev servers (that is
   its purpose), and only in rooms whose network is on.
9. **Sizes are bounded:** commands 1 MB, answers 8 MB, text arguments 10 000 characters, and `expression`
   100 000.
10. **The server's name,** `agoryx_browser`, is unlikely to collide with a server in the human's own
    Claude or Codex config. Which one wins on a collision is not verified. Agoryx does not use
    `--strict-mcp-config`.

## "No extra behavior for agents" (Ivan's rule)

- **Agoryx never acts in the pane by itself.** It does not open the panel, navigate, reload, retry, or take
  snapshots or screenshots on its own. It starts no dev server and does not look for URLs in messages. The
  pane changes only on an agent's command or the human's hand. Closing a room's pane when its network goes
  off is the human's setting taking effect.
- **Nothing is kept or copied.** Each browser step is in the turn's trace and the room history like a Bash
  command, without values. There are no saved screenshots or snapshots, and no feed messages about
  browsing. Page data lives in memory until the app quits.
- **The relay only relays.** It does not rewrite, merge, reorder or retry. The room comes from the key,
  never from Agoryx's guess.
- **Results carry facts, never advice:** what others did, the human's input, dialogs, refused downloads and
  choosers, blocked navigations, console error counts.
- **The dialog policy takes only the non-choices, and only for agents.** An alert has one button.
  `beforeunload` follows a navigation the agent itself asked for. `confirm` is dismissed, so nothing is
  confirmed on an agent's behalf, and the agent is told so. A dialog with no command running is the
  human's, except in a hidden pane, where the same non-choice keeps the window usable and the next result
  says so.
- **The tools do nothing until called.** Without the app they answer with an error, and nothing else
  happens.

## File plan

**New files** (safe to build in parallel with feature 2):

| Path | What |
|------|------|
| `internal/agora/browser.ts` | `BrowserRelay`, `BrowserFailure`, `sseHost`, the wire types |
| `internal/agora/browsertools.ts` | MCP flags for both CLIs, `browserStep`, trace labels |
| `bin/agoryx-mcp.mjs` | the zero-dependency MCP stdio server |
| `internal/desktop/browserlink.ts` | `BrowserLink`, the host SSE client, `BrowserCommandWire` |
| `internal/desktop/browserpage.ts` | URL policy and error codes, loopback and port checks, `RefTable`, `formatSnapshot`, `keyEvents`, `clip` |
| `desktop/src/browserpane.ts` | `BrowserPanes`: sessions, views, CDP ops, dialogs, viewport, placement, IPC |
| `ui/src/lib/desktop.ts` | the typed bridge and pane states |
| `ui/src/components/browser/BrowserPanel.tsx` | the panel: toolbar, refusal line, driver line, placeholder |
| `ui/src/components/browser/BrowserToggle.tsx` | the header button with its dot |
| `tests/agora/browser.test.ts` | the relay, the daemon routes, the whole chain |
| `tests/agora/fixtures/mcp-call.mjs` | a one-call MCP client that a fake agent's turn runs |
| `tests/agora/browser-mcp.test.ts` | the MCP server |
| `tests/agora/browser-runners.test.ts` | CLI flags and value-free trace labels |
| `tests/desktop/browserpage.test.ts` | the pure helpers |
| `tests/desktop/browserlink.test.ts` | the link against a real daemon |

**Hooks in existing files** (each one small, named, in one place):

| Path | Hook |
|------|------|
| `internal/agora/daemon.ts` | imports; `browser` field; the `x-agoryx-pane` refusal first in `handle()`; `readBody` limit parameter; `browser` route before the `rooms` 404; private `browserApi()`; `onRoomEvent` network-off → `closeRoom`; `close()` → `browser.close()` before `server.close()` |
| `internal/agora/types.ts` | `ActivityKind` gets `"browser"` |
| `internal/agora/runners/claude.ts` | `permissions.allow` gets `mcp__agoryx_browser__*`; `--mcp-config` before `--settings`; `describeClaudeTool` prefix check |
| `internal/agora/runners/codex.ts` | `common.push(...codexMcpArgs)`; app-server args; `describeCodexItem` `agoryx_browser` branch; live item `arguments` |
| `bin/agoryx-agent.mjs` | the `mcp` block in `main()` |
| `desktop/src/main.ts` | import, `trustedUi`, `panes`, 5 one-line calls, and the «Вигляд» items acting on the UI (C2) |
| `desktop/src/preload.cts` | the `window.agoryxBrowser` block (C3) |
| `ui/src/lib/store.ts` | `PanelTab` gets `"browser"` |
| `ui/src/App.tsx` | `SidePanel` title, icon, width and body branch; lazy loader; `Toaster` position |
| `ui/src/components/room/RoomHeader.tsx` | `<BrowserToggle />` |
| `ui/src/components/room/Feed.tsx` | «працює в браузері» for `browser` |
| `ui/src/components/room/Trace.tsx` | `browser` icon |
| `ui/src/components/session/SessionPanel.tsx` | `browser` icon |
| `docs/DESKTOP.md`, `docs/AGORA.md`, `CHANGELOG.md` | see Docs |

`internal/desktop/index.ts` is **not** touched: the pane loads its two modules itself. Feature 2 may edit
`index.ts`.

## Coordination with feature 2 (notifications)

- **Shared files:**
  - `desktop/src/main.ts`: `createWindow`, `listen`, `before-quit`, `showDaemon`, and the «Вигляд» menu;
  - `CHANGELOG.md` and `docs/DESKTOP.md`: separate entries and sections.

  Each hook here is a line or a few menu items, so a merge conflict is trivial.
- **Is Ivan looking?** Use `win.isFocused()` plus the room on screen, never the UI's
  `document.hasFocus()`, which is false while he clicks or types in the pane.
- **Browser activity is not a reason to notify.** Pane pages cannot raise system notifications: the
  permission is denied.
- **Connections.** Main holds one SSE connection for the browser host. Feature 2 polls
  `POST /api/attention/view` once a second and has no stream; the two are independent.

## Tests (node:test, run with tsx, like `tests/agora` and `tests/desktop`)

Every test runs on a temporary `AGORYX_HOME` (mkdtemp), with port 0 and `AGORYX_JEV: "off"`. Everything
started is stopped in `after()`. Nothing touches `~/.local/state/agoryx` or a daemon on 7717.

1. **`tests/agora/browser.test.ts`**
   - **The relay, with a fake host:**
     - two commands for one room both reach the host at once; a 21st in flight gives 429;
     - the deadline gives 504, and a late answer gets 404;
     - no host gives 503 at once;
     - a new host replaces the old one (closed as `replaced`, its commands fail), and the old host's
       late detach leaves the new one attached;
     - detaching the current host fails everything with 503;
     - `closeRoom` fails that room's commands with 403 and tells the host;
     - validation gives 400; a bad answer shape is refused; an unknown id gives 404; `close()`.
   - **The daemon routes,** on an in-process `AgoraDaemon` with the `call()` helper of
     `daemon.test.ts`. A room with an agent is made, and its key comes from `agentKey()`.
     - With `x-agoryx-pane: 1`: `/api/health`, `/?t=<token>` (no cookie is set), `/api/rooms` with the
       human token, a `/raw/` path and `/` all give 403.
     - `POST /api/browser`: the human token gives 403, no token 401, a stale key 401. A valid key for an
       idle agent gives 409. While the agent's fake turn sleeps: network off gives the network 403, and
       network on gives the process 403, since the test process is not the agent's.
     - An agent key on `/api/browser/host` and on `answer` gives 403.
     - A 2 MB answer passes, and 9 MB gives 413.
     - A `settings.changed` to network off sends the host `close` for that room.
     - `daemon.close()` with a host attached ends the stream and resolves.
   - **The whole chain,** on a daemon with `advertise: true` (it writes `daemon.json` in the temp home)
     and fake runners. A fake-agent rule `run`s `node tests/agora/fixtures/mcp-call.mjs browser_navigate
     '{"url":"http://127.0.0.1:1/"}'` inside a real (fake) turn, so it passes the turn and process checks.
     A `BrowserLink` fake host answers. The host sees `{ agent, label, op, args }`, and the run's output
     has the page lines and notes.
2. **`tests/agora/browser-mcp.test.ts`** spawns `node bin/agoryx-agent.mjs mcp` against a tiny
   `node:http` fake daemon, whose `daemon.json` is in the temp home.
   - The protocol: `initialize` echoes each supported version and answers the newest for an unknown one;
     `serverInfo.name` is `agoryx_browser` and there are `instructions`; `tools/list` has the seven names,
     each schema a plain object; notifications get no answer; -32601, -32700 and -32600 where due.
   - The key and the token: the request carries the agent key and **never** the `token` from
     `daemon.json`; with `AGORYX_TURN_FILE`, the key is re-read per call (rewrite the file between two
     calls; the headers differ); a mismatched agent or room, or no file, gives the "Not in a turn" error.
   - The results: an image result has image content; a daemon 503 becomes `isError` with its text; no
     `daemon.json` gives the "No Agoryx daemon" error.
   - stdin end → exit 0.
3. **`tests/agora/browser-runners.test.ts`**
   - `buildClaudeArgs` with `env.AGORYX_CLI`: `--mcp-config` is followed by the JSON and then
     `--settings`; the JSON names `agoryx_browser`, with `command` = the shim and `args` = `["mcp"]`.
   - `buildClaudeSettings` allow has `mcp__agoryx_browser__*`. Without the shim, arguments and settings
     are unchanged.
   - `buildCodexArgs`, for `exec` and `exec resume`, and the live spawn args have all seven `-c` pairs.
     None without the shim.
   - **Value-free labels:** `describeClaudeTool("mcp__agoryx_browser__browser_type", { ref: "e5", text:
     "hunter2" })` and the Codex item alike give kind `browser`, the label `browser type e5 (7
     characters)`, and no `detail` or `command`. A navigate to `https://u:p@host/cb?code=abc#t` gives
     `browser navigate https://host/cb`. The activity's JSON never holds `hunter2`, `code=abc`, `u:p` or
     an eval's source.
4. **`tests/desktop/browserpage.test.ts`**
   - `paneUrl`: schemes, bare hosts, `about:blank`, each error code, and every blocked address:
     `127.0.0.1`, `127.0.0.2`, `127.1`, `0x7f.1`, `2130706433`, `localhost`, `localhost.`,
     `app.localhost`, `[::1]`, `[::]`, `[::ffff:127.0.0.1]` and `0.0.0.0`, on 7717, 7736 and a seen port.
     Port 7737 and a dev port such as 5173 are allowed.
   - `RefTable`: monotonic, and never reused after `forgetDocument()`.
   - `formatSnapshot` on a fixture AX tree: hoisting, attributes, links, refs, the cut at `maxChars`.
   - `keyEvents`: `Enter`, `Shift+Tab`, `Ctrl+Shift+ArrowLeft`, a bad key; `Meta+v`, `Meta+c` and `Meta+x`
     give the clipboard error; no stroke ever has a `commands` field.
5. **`tests/desktop/browserlink.test.ts`** against an in-process daemon: `hello`, then a command, then the
   posted answer; an answer POST that first gets 403 is retried once; `close` calls `closeRoom`; reconnect
   after the daemon restarts on a new port; `replaced` stops the link; `stop()` leaves no timers.
6. **`tests/desktop/imports.test.ts`** is unchanged. It walks the new `internal/desktop` files by itself.

## E2E plan (dev Electron app, temporary state only)

Never use Ivan's daemon (pid 17815, 127.0.0.1:7717) or `~/.local/state/agoryx`. Stop everything started.

1. `T=$(mktemp -d <scratchpad>/wf-e2e.XXXX)`. Build with `npm run build` (core and UI) and
   `npm --prefix desktop run build`.
2. Start a fixture page server on a free port: `node <scratchpad>/page-server.mjs`, not in the repo.
   - `/`: a form with a Cyrillic label and a beforeunload guard once edited; a counter button; a link to
     `/settings` and a `window.open` link; alert, confirm, prompt and `console.error` buttons; a
     `<select>`, a date input and a file input; a print button; a download link; a canvas that logs the
     CSS point of each click.
   - `/settings`: a second page with its own form.
3. Launch the app on temporary state: `AGORYX_HOME=$T/home AGORYX_WORKSPACES=$T/ws
   desktop/node_modules/.bin/electron desktop --user-data-dir=$T/ud`.
   - Its daemon takes 7718 or the next free port, because Ivan's holds 7717.
   - A separate user-data dir keeps window state and the single-instance lock apart from Ivan's app.
4. Make a room in `$T/ws/app` with Claude and Codex, and open it: «Браузер» shows in the header.
   **Before any agent drives,** type `http://127.0.0.1:7717/api/health` and
   `http://localhost:7717/api/health` into the panel's address field: both are refused inline. (These URLs
   carry no token.)
5. **The scripted driver.** Ask Claude to run `node <scratchpad>/drive.mjs` and paste its output. The
   driver runs inside Claude's turn, with its key, so it passes the daemon's checks. It speaks MCP to
   `$AGORYX_CLI mcp` and asserts, against the fixture:
   - **Security:** navigating to `127.0.0.1:7717`, `localhost:7717` and the test daemon's port fails;
     `browser_eval` `fetch()` to them fails; `file:///etc/hosts` fails;
     `Notification.requestPermission()` resolves to `"denied"`; `navigator.clipboard.readText()` rejects.
   - **Ops:** type «Іван» and submit; click the counter by ref; a screenshot, then a canvas click at image
     coordinates logs the same CSS point; press PageDown and Enter; `Meta+v` gives the clipboard error;
     eval returns JSON, and an exception is a tool error; `waitForText` for text that appears after 1 s; a
     stale ref after navigating gives the stale-ref error; the `Viewport:` line reads 1280 wide.
   - **The page's own behaviour:** alert accepted and confirm dismissed, with notes; prompt returns no
     value; `console.error` counted in the notes and listed by snapshot; navigating away from the edited
     form loads the new page; a select click is refused with the hint, and `browser_type` chooses an
     option and fires `change`; date and file input clicks are refused; `input.click()` from eval gives
     the chooser note; print returns at once; the download is refused with a note; `window.open` loads in
     the same pane.
   - The room history shows `browser type e… (4 characters)` and never «Іван».
6. **Claude, per turn:** "open http://127.0.0.1:<port>/, type «Іван» in the name field, submit, take a
   screenshot and describe it".
   - The panel stays closed; the dot on «Браузер» pulses. Open it: the driver line reads «Claude вводить
     текст…».
   - The trace shows `browser type e… (4 characters)`, and Claude's description matches the page, so the
     image reached the model.
7. **Codex, `codex exec`:** the same task. Then with a live Codex (`app-server`): the **unverified** step.
   If the result does not reach the model, switch to the `thread/start` `config.mcp_servers` fallback (A6)
   and repeat.
8. **Two agents at once.**
   - "Both of you: click the counter 5 times." The counter reads 10, and at least one result lists the
     other agent's steps.
   - In one parallel round, Claude tests the form on `/` while Codex tests `/settings`. Record whether they
     converge or keep re-navigating each other. This is a finding for decision-making, not a pass/fail.
9. **Hidden, background, switching, zoom.**
   - With the panel closed and the window minimized, the driver's snapshot, click and screenshot still
     work, and the screenshot is not blank.
   - A confirm raised by a timer in a hidden room's page, with no command running, does not block the
     window, and the next result notes it.
   - Switching rooms shows the other room's pane.
   - The UI zoom (⌘+ with focus in the UI) keeps the pane aligned with the placeholder.
   - Click into the pane and press ⌘+ and ⌘R: the UI zooms and reloads, not the pane. The driver's canvas
     click at screenshot coordinates still logs the same CSS point.
10. **Focus (manual).** Type in the composer while the driver runs `browser_type` in a loop: the keystrokes
    stay in the composer, and the pane's field gets only the driver's text.
11. **Crash and window.** `kill -9` the newest renderer process of this app (the pane's; check with
    `ps -o lstart`): the crashed line shows; the next driver command gets a fresh page with the note, and
    «Оновити» reloads the last URL. Close the window (⌘W): the driver gets the window-closed error; reopen
    it from the Dock.
12. **Network off.** Turn the room's network off: its pane closes, and the driver in the next turn gets
    the network-off error.
13. **Without the app:** quit the app (the daemon keeps running) and ask an agent to browse. The tool
    error names the desktop app. Nothing else happens: no process, and nothing in the feed.
14. **Cleanup:** «Зупинити демона й вийти», or `AGORYX_HOME=$T/home node bin/agoryx.js down`. Kill the
    page server, then `rm -rf $T`.

## Docs

- **`docs/DESKTOP.md`**
  - A new section, "The room's browser": what it is, how agents use it, what the human sees and can do,
    and that each room's browser data lives in memory until the app quits.
  - "What the window may do" gets the pane's rules: no preload, permissions, certificates and sign-ins,
    the file chooser, downloads, the `x-agoryx-pane` marker and the port block, the «Вигляд» menu acting
    on the UI, and `window.agoryxBrowser` on the daemon page only.
  - The diagram gets the host link, and the Files table the new files.
  - "What's next": replace "A shared browser pane" with "browser tabs, browser data that survives a
    restart, a browser without the app".
- **`CHANGELOG.md`**, under Unreleased → Added: **The room's browser (macOS app)**. Agents open and use a
  real page in the room's panel over the room's own MCP server, and the human watches live.
- **`docs/AGORA.md`**
  - Under "Using it", a new section "### The room's browser": the tools table, `agoryx mcp` as what the
    room gives both CLIs, the need for the desktop app, the running-turn rule, and the network-off rule.
  - Under "Safety": commands take the agent key only, from the agent's own turn processes; every daemon
    refuses requests from the pane.
  - Code-map rows for `browser.ts`, `browsertools.ts` and `bin/agoryx-mcp.mjs`.
- **Completions and man page: no change.** `mcp` exists only in the agents' shim (`bin/agoryx-agent.mjs`),
  not in the human's `agoryx` (`bin/agoryx.js`).

## Open decisions (with recommended defaults)

1. **A room with the network off.** Refuse (recommended for v1), or allow loopback only. Loopback-only
   would let offline rooms test their own dev server. It needs a per-session `onBeforeRequest` filter on
   every request type (a `paneUrl` check would miss fetches, subresources and WebSockets), plus the
   daemon's check.
2. **The panel opening by itself.** Never in v1 (recommended); the dot on «Браузер» shows an agent is
   driving. Revisit after real use.
3. **Browser data.** Per room, in memory (recommended): nothing on disk, nothing shared between rooms, and
   sign-ins last until the app quits. Keeping sign-ins across restarts would be an explicit opt-in later.
4. **Tools always on (whenever the shim exists), or a room setting «Браузер для агентів».** Always on
   (recommended); the error without the app is clear. The cost: about 1.5k tokens of schemas per Codex
   turn. Claude defers them.
5. **Viewport.** A fixed 1280 CSS px layout, scaled into the pane (recommended): agents get the desktop
   layout, and it does not change when Ivan resizes. The alternative, a viewport that follows the pane,
   always gives the small-screen layout (the wide panel is at most 760 px).
6. **`browser_eval`.** Included (recommended). Agents test apps, the page is theirs to drive, and the pane
   is walled off from the daemon and the files.
7. **JS dialogs.** The policy in C1 (recommended), or an 8th tool, `browser_dialog`.
8. **Read-only rooms.** Allowed (recommended). A local dev server can still change files through its own
   API; that is the app's doing, as with `curl`.
9. **A limit on panes.** None in v1 (recommended): there is one per room Ivan's agents actually browse in,
   and all of them close with the window.

## Review decisions

Each line answers one reviewer issue (security = S, feasibility = F, UX = U). All 39 were checked against
the code or a probe. None is rejected outright; where part of a fix was not taken, the line says why.

1. S blocker, other daemons reachable: accepted. The `x-agoryx-pane` marker refused first in every daemon
   (probe: no preflight, header seen on fetch, img and navigation), plus the 7717–7736 and seen-port block
   that never lapses, and the E2E 7717 check before agents drive.
2. S, clipboard via editor commands: accepted, and cut further. `keyEvents` has no `commands` at all,
   Meta+c/v/x is refused, and clipboard permissions are denied.
3. S, values in stored labels: accepted. Value-free `browserStep` labels, and a test that typed text,
   URL queries, userinfo and eval source never reach the activity.
4. S, client certificates and login: accepted. App-level handlers for pane contents send nothing and add a
   note.
5. S, native choosers and print: accepted and probed. The file chooser is intercepted (direct click and
   `input.click()`), print is stubbed, and `fileSystem` is denied.
6. S, one persistent shared partition: accepted. Per-room in-memory sessions (probe: `isPersistent()`
   false). The single non-persistent partition was not chosen, since it still leaks between rooms.
7. S, forged keys for other rooms: accepted. `agentBehind` must equal the key's room and agent.
8. S, dialogs answered for the human: accepted, together with issue 13.
9. S, `outside` without a gesture: accepted. The UI's recent click, http(s) only, no userinfo.
10. S, network-off holes: accepted. `closeRoom` on `settings.changed`, Security 5 says agents can flip it,
    and decision 1 names a per-session request filter.
11. S, no running-turn check: accepted. 409 unless `presence()` says the agent is working.
12. F, the pane zooms and reloads from the menu: accepted (probe `rv/run2.log`). The «Вигляд» items act on
    the UI, and the pane's zoom is set again before each command.
13. F, dialog policy: accepted. Auto-answer only during an agent's command, the human's dialog left alone,
    and the prompt note dropped (it returns in 1 ms with no event). "Bring the pane's room on screen" was
    not taken: pulling Ivan's view would be Agoryx acting. A hidden pane's dialog is answered with a note
    instead.
14. F, `connect()` restarts on every `showDaemon`: accepted. It is idempotent.
15. F, DevTools for the pane: accepted. The menu opens the UI's, and `owns()` excludes `remote`.
16. F, `loadURL` rejects on beforeunload: accepted. CDP `Page.navigate`, with `ERR_ABORTED` meaning wait.
17. F, detach race: accepted. Detach checks the host's identity and is idempotent.
18. F, `close()` hangs on the host stream: accepted. `browser.close()` runs before `server.close()`.
19. F, `--strict-mcp-config` exists: accepted. The claim is corrected, the flag is not used, the server is
    named `agoryx_browser`, and the unverified precedence claim is dropped.
20. F, dead IPv4-mapped pattern: accepted. `net.isIP` and a numeric `::ffff:7f00:0/104` check, with the
    parser's normal forms in the tests.
21. F, stale commands still run: accepted. The pane skips a command past its deadline and stops waiting on
    one at its deadline.
22. F, Codex parallel calls: accepted. `supports_parallel_tool_calls=false` (its effect was not observable
    in the probe) and "one at a time" in the instructions.
23. F, whole-chain test has no `daemon.json`: accepted. `advertise: true` in a temp home.
24. F, E2E shares userData: accepted. `--user-data-dir=$T/ud`.
25. F, types do not compile across `rootDir`: accepted. `BrowserCommandWire` is defined in B1 by a
    type-only import, and `desktop/src` keeps a local copy.
26. F, answer POSTs pay for lsof: accepted in the simple form: one keep-alive agent and one retry. A
    separate per-link secret was not taken; it adds a credential for little gain.
27. U, small-screen viewport: accepted (probe `sp/run3.log`). 1280 CSS px scaled by zoom, with sizes from
    `Page.getLayoutMetrics`.
28. U, `setWide` from browser code: accepted. Auto-open is cut, `setWide` is never called, and the browser
    panel is always wide when docked.
29. U, persistent shared partition and the clear button: accepted with issue 6. The button, its IPC and
    its confirm text are gone.
30. U, native pickers and beforeunload: accepted. Selects are chosen via `browser_type`, picker clicks are
    refused, and the fixture has a select, a date input and a guard. The `will-prevent-unload` handler was
    not added: the probes show the navigation completes once CDP accepts the dialog.
31. U, ⌘+ zooms the pane: accepted with issue 12, plus an E2E step with focus in the pane.
32. U, agents fighting over the pane: accepted. The notes list the others' steps, the instructions name
    the parallel first round, and there is a conflicting E2E run. Nothing stronger until that run shows
    it is needed.
33. U, no automated test of the pane: accepted. A scripted driver run inside a real turn covers every op,
    dialog, picker and the security checks, and there are manual focus, crash and window steps.
34. U, toasts under the pane: accepted. Refusals show inline, and the Toaster moves to bottom-left while
    the browser is open.
35. U, "nothing kept" is untrue: accepted. The spec now says steps are in the trace and history without
    values, and the window-close and viewport limits are listed. The CLI's own session log is the CLI's.
36. U, «шукає в мережі» for browsing: accepted. A new `browser` kind shows «працює в браузері».
37. U, double serialisation: accepted. The relay forwards at once; only the pane orders.
38. U, speculative pieces: accepted. Cut: the editor commands, `double`, `times`, `"stop"`, the Palette
    item, and the five-pane eviction.
39. U, Ukrainian texts: accepted. The new crash and driver lines, and error codes that the UI maps
    entirely to Ukrainian. The clear-button text is moot, since the button is gone.
