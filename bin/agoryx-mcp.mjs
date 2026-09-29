// The room's browser for agents: an MCP server on stdio that the room hands both CLIs as `$AGORYX_CLI mcp`
// (docs/plans/2026-09-29-desktop-browser-pane.md, A3). Zero dependencies on purpose, like the shim that loads it.
// It relays each tool call to the daemon's POST /api/browser under the agent's own key, and the daemon relays it
// to the Agoryx app's pane. It keeps nothing: no page, no result, no key between calls.
// JSON-RPC 2.0, one message per line. stdout carries protocol messages only; stderr stays silent unless
// AGORYX_MCP_DEBUG=1.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CALL_TIMEOUT_MS = 75_000;

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const INSTRUCTIONS = `The Agoryx room's browser: one real browser page per room, shown live to the human in the Agoryx app and shared with the other agents in the room. What you open, they and the human see. In a room's first round all agents start at once, so another agent may be using this page at the same time; every result lists what others did since your last command. It works only during your turn and only while the Agoryx app is open.
- browser_navigate opens a page (http or https, for example a dev server on localhost).
- browser_snapshot reads the page as an outline. Elements get refs like e12, which stay valid while the element is on the page.
- browser_click, browser_type and browser_press act on the page. To choose in a <select>, use browser_type with the option's label.
- browser_screenshot shows the page as an image. browser_eval runs JavaScript in it.

Call browser tools one at a time and wait for each result. The page is laid out 1280 CSS px wide, and coordinates are CSS pixels of the viewport. While your command runs, alert and beforeunload are accepted and confirm is dismissed; prompt() returns no value. Clipboard shortcuts, file upload and printing are not available.`;

const NOT_IN_TURN = "Not in a turn: the room's browser works only while your turn runs.";

// ---------------------------------------------------------------------------
// The tools: flat object schemas (no top-level oneOf, which OpenAI tool schemas refuse); the combinations are
// checked here, and a wrong argument is a tool error, as MCP expects.
// ---------------------------------------------------------------------------

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

const TOOLS = [
  {
    name: "browser_navigate",
    op: "navigate",
    description:
      "Open a URL in the room's browser (http or https; a bare host:port such as localhost:5173 is read as http), or go back, forward or reload. Give exactly one of url and go. Waits for the page to load, up to 30 s.",
    properties: {
      url: { type: "string", description: "The address to open, e.g. http://localhost:5173/settings." },
      go: { type: "string", enum: ["back", "forward", "reload"], description: "Move in the page's history, or reload it." },
    },
    check: ({ url, go }) => {
      if ((url === undefined) === (go === undefined)) return "Give exactly one of url and go.";
      if (url !== undefined && !isText(url)) return "url must be a non-empty string.";
      if (go !== undefined && go !== "back" && go !== "forward" && go !== "reload") return 'go must be "back", "forward" or "reload".';
      return null;
    },
  },
  {
    name: "browser_snapshot",
    op: "snapshot",
    readOnly: true,
    description:
      "Read the page as an outline of its elements, with refs like e12 for the ones you can act on, followed by the latest console errors and warnings. With waitForText it first waits until that text is on the page (timeoutMs, default 5000, at most 30000).",
    properties: {
      waitForText: { type: "string", description: "Wait until the page shows this text before reading it." },
      timeoutMs: { type: "integer", minimum: 0, maximum: 30000, description: "How long to wait for waitForText, in ms (default 5000)." },
    },
    check: ({ waitForText, timeoutMs }) => {
      if (waitForText !== undefined && typeof waitForText !== "string") return "waitForText must be a string.";
      if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 30000)) {
        return "timeoutMs must be a whole number of milliseconds from 0 to 30000.";
      }
      return null;
    },
  },
  {
    name: "browser_click",
    op: "click",
    description:
      "Click an element by its ref from browser_snapshot, or a point: x and y in CSS pixels of the viewport (a viewport screenshot's pixels). Give ref, or x and y.",
    properties: {
      ref: { type: "string", description: "An element's ref from browser_snapshot, e.g. e12." },
      x: { type: "number", description: "CSS pixels from the viewport's left edge." },
      y: { type: "number", description: "CSS pixels from the viewport's top edge." },
    },
    check: ({ ref, x, y }) => {
      const point = x !== undefined || y !== undefined;
      if (ref !== undefined && point) return "Give ref, or x and y, not both.";
      if (ref !== undefined) return isText(ref) ? null : "ref must be a non-empty string.";
      if (!point) return "Give ref, or x and y.";
      if (!isNumber(x) || !isNumber(y)) return "Give both x and y, as numbers.";
      return null;
    },
  },
  {
    name: "browser_type",
    op: "type",
    description:
      "Type text into an element by its ref. clear (default true) replaces what the element holds; submit (default false) presses Enter after. On a <select>, chooses the option whose label (or else value) is the text.",
    properties: {
      ref: { type: "string", description: "The element's ref from browser_snapshot, e.g. e5." },
      text: { type: "string", description: "The text to type, or the option's label for a <select>." },
      clear: { type: "boolean", description: "Replace the element's content first (default true)." },
      submit: { type: "boolean", description: "Press Enter after typing (default false)." },
    },
    required: ["ref", "text"],
    check: ({ ref, text, clear, submit }) => {
      if (!isText(ref)) return "ref must be a non-empty string.";
      if (typeof text !== "string") return "text must be a string.";
      if (clear !== undefined && typeof clear !== "boolean") return "clear must be true or false.";
      if (submit !== undefined && typeof submit !== "boolean") return "submit must be true or false.";
      return null;
    },
  },
  {
    name: "browser_press",
    op: "press",
    description:
      "Press a key or a key combination in the focused element, e.g. Enter, Tab, Escape, PageDown, End, Space, ArrowDown, Shift+Tab. PageDown, End and Space scroll the page.",
    properties: {
      key: { type: "string", description: "A key name, or modifiers and a key joined with +, e.g. Shift+Tab." },
    },
    required: ["key"],
    check: ({ key }) => (isText(key) ? null : "key must be a non-empty string."),
  },
  {
    name: "browser_screenshot",
    op: "screenshot",
    readOnly: true,
    description:
      "Take a PNG screenshot of the viewport, or of one element by its ref. The viewport screenshot's pixels are CSS pixels, so its coordinates work with browser_click.",
    properties: {
      ref: { type: "string", description: "Crop to this element's box (its ref from browser_snapshot)." },
    },
    check: ({ ref }) => (ref === undefined || isText(ref) ? null : "ref must be a non-empty string."),
  },
  {
    name: "browser_eval",
    op: "eval",
    description:
      "Run a JavaScript expression in the page and get its value as JSON (a promise is awaited, up to 20 s). An exception is an error. Use it to wait on a condition, read localStorage, or set a date input's value.",
    properties: {
      expression: { type: "string", description: "A JavaScript expression, e.g. document.title or (async () => { … })()." },
    },
    required: ["expression"],
    check: ({ expression }) => (isText(expression) ? null : "expression must be a non-empty string."),
  },
];

const toolList = () =>
  TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: tool.properties,
      ...(tool.required ? { required: tool.required } : {}),
      additionalProperties: false,
    },
    annotations: { ...(tool.readOnly ? { readOnlyHint: true } : {}), openWorldHint: true },
  }));

/** The tool's own arguments (a null counts as left out), or the text of a tool error. */
const checkArguments = (tool, given) => {
  if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given))) {
    return `${tool.name} takes its arguments as an object.`;
  }
  const args = {};
  for (const [name, value] of Object.entries(given ?? {})) if (value !== null && value !== undefined) args[name] = value;
  const unknown = Object.keys(args).filter((name) => !(name in tool.properties));
  if (unknown.length) return `${tool.name} does not take ${unknown.map((name) => `"${name}"`).join(", ")}.`;
  return tool.check(args) ?? args;
};

// ---------------------------------------------------------------------------
// The key and the daemon, both read on each call.
// ---------------------------------------------------------------------------

/** The agent's key: from AGORYX_TURN_FILE when the room names one (a live agent), else AGORYX_AGENT_KEY. */
const agentKeyFrom = (env) => {
  if (env.AGORYX_TURN_FILE) {
    let context = null;
    try {
      context = JSON.parse(readFileSync(env.AGORYX_TURN_FILE, "utf8"));
    } catch {
      // no turn in progress
    }
    const valid =
      context &&
      typeof context.turn === "string" &&
      typeof context.seen === "string" &&
      context.agent === env.AGORYX_AGENT &&
      context.room === env.AGORYX_ROOM;
    return valid && typeof context.key === "string" && context.key ? context.key : null;
  }
  return env.AGORYX_AGENT_KEY || null;
};

/** `<agoraHome>/daemon.json`, with the rules of internal/agora/paths.ts. */
const daemonInfoFile = (env) => {
  const override = env.AGORYX_HOME?.trim();
  if (override) return join(resolve(override), "daemon.json");
  const state = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local/state");
  return join(state, "agoryx", "agora", "daemon.json");
};

/** The daemon's address: `url` only. The file's token is the human's, never sent from here. */
const daemonUrl = (env) => {
  const path = daemonInfoFile(env);
  if (!existsSync(path)) return { error: `No Agoryx daemon is running here (${path} not found).` };
  let url;
  try {
    url = JSON.parse(readFileSync(path, "utf8")).url;
  } catch {
    // unreadable: as good as no address
  }
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return { error: `No Agoryx daemon is running here (${path} has no address).` };
  return { url: url.replace(/\/+$/, "") };
};

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

/** The page lines, the notes, then what the op itself gives. */
const resultText = (result) => {
  const width = Math.round(result.viewport.width);
  const height = Math.round(result.viewport.height);
  const lines = [`Page: ${result.title}`, `URL: ${result.url}`, `Viewport: ${width}×${height} CSS px`];
  if (Array.isArray(result.notes) && result.notes.length) lines.push("Notes:", ...result.notes.map((note) => `- ${note}`));
  const head = lines.join("\n");
  return typeof result.text === "string" && result.text ? `${head}\n\n${result.text}` : head;
};

const isResult = (result) =>
  result &&
  typeof result === "object" &&
  typeof result.url === "string" &&
  typeof result.title === "string" &&
  result.viewport &&
  isNumber(result.viewport.width) &&
  isNumber(result.viewport.height);

/** One tool call, relayed to the daemon under the agent's key. */
const callTool = async (tool, given, env, cancel) => {
  const args = checkArguments(tool, given);
  if (typeof args === "string") return toolError(args);
  const key = agentKeyFrom(env);
  if (!key) return toolError(NOT_IN_TURN);
  const daemon = daemonUrl(env);
  if (daemon.error) return toolError(daemon.error);
  let response;
  let body;
  try {
    response = await fetch(`${daemon.url}/api/browser`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agoryx-token": key },
      body: JSON.stringify({ op: tool.op, args }),
      signal: AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), cancel]),
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    if (cancel.aborted) throw error;
    if (error?.name === "TimeoutError") return toolError(`The Agoryx daemon did not answer within ${CALL_TIMEOUT_MS / 1000} s.`);
    return toolError(`Could not reach the Agoryx daemon at ${daemon.url}: ${error?.cause?.code || error?.message || error}.`);
  }
  if (!response.ok) {
    const text = body && typeof body.error === "string" && body.error ? body.error : `The Agoryx daemon answered ${response.status}.`;
    return toolError(text);
  }
  const result = body?.result;
  if (!isResult(result)) return toolError("The Agoryx daemon gave an answer this browser tool does not understand.");
  const content = [{ type: "text", text: resultText(result) }];
  if (result.image && typeof result.image.data === "string") content.push({ type: "image", data: result.image.data, mimeType: "image/png" });
  return { content };
};

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

/** Serves MCP on stdin/stdout until stdin ends. Calls run concurrently; each answer carries its request's id. */
export const serve = ({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) =>
  new Promise((resolveServe) => {
    const debug = env.AGORYX_MCP_DEBUG === "1" ? (line) => process.stderr.write(`agoryx mcp: ${line}\n`) : () => {};
    const running = new Map();
    let closed = false;
    let buffer = "";

    const send = (message) => {
      if (closed || stdout.destroyed || stdout.writableEnded) return;
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };
    const reply = (id, result) => send({ id, result });
    const fail = (id, code, message) => send({ id, error: { code, message } });

    const call = async (id, params) => {
      const tool = TOOLS.find((candidate) => candidate.name === params?.name);
      if (!tool) {
        fail(id, -32602, `Unknown tool: ${typeof params?.name === "string" ? params.name : "(none)"}`);
        return;
      }
      const cancel = new AbortController();
      const key = JSON.stringify(id);
      running.set(key, cancel);
      try {
        const result = await callTool(tool, params.arguments, env, cancel.signal);
        debug(`${tool.name} ${result.isError ? "error" : "ok"}`);
        if (!cancel.signal.aborted) reply(id, result);
      } catch (error) {
        // Cancelled by the client, or stdin closed: the client no longer wants an answer.
        if (!cancel.signal.aborted) reply(id, toolError(`The room's browser tool failed: ${error?.message || error}`));
      } finally {
        running.delete(key);
      }
    };

    const handle = (message) => {
      if (Array.isArray(message)) {
        fail(null, -32600, "Batches are not supported");
        return;
      }
      if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
        fail(null, -32600, "Invalid request");
        return;
      }
      const { id, method, params } = message;
      const isRequest = "id" in message;
      if (typeof method !== "string") {
        // A response to a request of ours (there are none) is dropped; anything else is not a request.
        if (!isRequest || "result" in message || "error" in message) return;
        fail(id ?? null, -32600, "Invalid request");
        return;
      }
      debug(isRequest ? `${method} (${JSON.stringify(id)})` : method);
      if (!isRequest) {
        if (method === "notifications/cancelled") running.get(JSON.stringify(params?.requestId))?.abort();
        return;
      }
      switch (method) {
        case "initialize": {
          const asked = params?.protocolVersion;
          reply(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "agoryx_browser", title: "Agoryx room browser", version },
            instructions: INSTRUCTIONS,
          });
          return;
        }
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: toolList() });
          return;
        case "tools/call":
          void call(id, params);
          return;
        default:
          fail(id, -32601, `Method not found: ${method}`);
      }
    };

    const line = (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        fail(null, -32700, "Parse error");
        return;
      }
      handle(message);
    };

    const end = () => {
      if (closed) return;
      if (buffer) line(buffer);
      buffer = "";
      closed = true;
      for (const cancel of running.values()) cancel.abort();
      debug("stdin ended");
      resolveServe();
    };

    stdout.on?.("error", () => {
      // The client went away; there is no one left to answer.
    });
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        line(text);
        newline = buffer.indexOf("\n");
      }
    });
    stdin.on("end", end);
    stdin.on("close", end);
    stdin.on("error", end);
  });
