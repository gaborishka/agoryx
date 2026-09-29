/**
 * What the runners share for the room's browser: the MCP flags both CLIs get, and the browser's trace labels
 * (docs/plans/2026-09-29-desktop-browser-pane.md, A5). Dependency-free: the desktop core re-exports browserStep.
 *
 * The room hands both CLIs its own MCP server, `$AGORYX_CLI mcp` (bin/agoryx-mcp.mjs), whenever it has the shim.
 * A step's label never holds a value: no typed text, no script, no query string, no userinfo. The trace and the room
 * history keep the step like a Bash command, and nothing that was typed or read.
 */

export const BROWSER_SERVER = "agoryx_browser";

export const MCP_ENV_VARS = ["AGORYX_ROOM", "AGORYX_AGENT", "AGORYX_TURN", "AGORYX_SEEN", "AGORYX_AGENT_KEY",
  "AGORYX_TURN_FILE", "AGORYX_HOME", "XDG_STATE_HOME"];

const OPS = ["navigate", "snapshot", "click", "type", "press", "screenshot", "eval"];
const MAX_STEP = 160;
/** Key names browser_press knows (internal/desktop/browserpage.ts keyEvents); a lone character is typing. */
const NAMED_KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Space", ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)]);
const MODIFIERS = new Set(["Shift", "Control", "Ctrl", "Alt", "Option", "Meta", "Cmd"]);

/** `{"mcpServers":{"agoryx_browser":{"type":"stdio","command":<AGORYX_CLI>,"args":["mcp"]}}}`, or null without the shim. */
export const claudeMcpConfig = (env: NodeJS.ProcessEnv): string | null => {
  const shim = env.AGORYX_CLI;
  if (!shim) return null;
  return JSON.stringify({ mcpServers: { [BROWSER_SERVER]: { type: "stdio", command: shim, args: ["mcp"] } } });
};

/** The `-c mcp_servers.agoryx_browser.*` pairs (TOML values: JSON-quoted strings, arrays), or [] without the shim. */
export const codexMcpArgs = (env: NodeJS.ProcessEnv): string[] => {
  const shim = env.AGORYX_CLI;
  if (!shim) return [];
  const key = `mcp_servers.${BROWSER_SERVER}`;
  return [
    `${key}.command=${JSON.stringify(shim)}`,
    `${key}.args=${JSON.stringify(["mcp"])}`,
    // Codex hands an MCP server a scrubbed environment: the room's variables must be named to reach it.
    `${key}.env_vars=${JSON.stringify(MCP_ENV_VARS)}`,
    // Without it a call waits on Codex's reviewer, and a live turn's approval request is refused.
    `${key}.default_tools_approval_mode="approve"`,
    `${key}.startup_timeout_sec=20`,
    `${key}.tool_timeout_sec=90`,
    `${key}.supports_parallel_tool_calls=false`,
  ].flatMap((pair) => ["-c", pair]);
};

const clip = (text: string): string => (text.length > MAX_STEP ? `${text.slice(0, MAX_STEP - 1)}…` : text);

const fields = (args: unknown): Record<string, unknown> =>
  args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

const characters = (value: unknown): string => {
  const count = typeof value === "string" ? [...value].length : 0;
  return `${count} ${count === 1 ? "character" : "characters"}`;
};

/** A ref as snapshots hand them out (e12); anything else could be a value. */
const refOf = (value: unknown): string | null => (typeof value === "string" && /^e\d{1,9}$/.test(value) ? value : null);

/** Origin and path only: no userinfo, query or fragment. A non-web URL shows its scheme only. */
const placeOf = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) return "(no URL)";
  const input = value.trim();
  let url: URL;
  try {
    // A bare host[:port][/path] is a web address, as the pane reads it.
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(input) ? input : `http://${input}`);
  } catch {
    return "(not a URL)";
  }
  if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}${url.pathname}`;
  if (url.href === "about:blank") return "about:blank";
  return `a ${url.protocol.slice(0, -1)}: URL`;
};

/** A key stroke's name, or a neutral word for a lone character, which is typing. */
const keyOf = (value: unknown): string => {
  if (typeof value !== "string" || !value) return "a key";
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  const modifiers = parts.filter((part) => MODIFIERS.has(part));
  if (modifiers.length !== parts.length) return "a key";
  if (NAMED_KEYS.has(key)) return value;
  if ([...key].length === 1) return modifiers.some((part) => part !== "Shift") ? value : "a character key";
  return "a key";
};

/** One step without its values: "navigate http://localhost:5173/settings", "click e12", "click at 320,140",
 *  "type e5 (12 characters)", "press Enter", "screenshot", "eval (340 characters)". At most 160 characters. */
export const browserStep = (op: string, args: unknown): string => {
  const given = fields(args);
  switch (op) {
    case "navigate": {
      const go = given.go;
      if (go === "back" || go === "forward" || go === "reload") return `navigate ${go}`;
      return clip(`navigate ${placeOf(given.url)}`);
    }
    case "snapshot":
      return "snapshot";
    case "click": {
      const ref = refOf(given.ref);
      if (ref) return `click ${ref}`;
      const { x, y } = given;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        return `click at ${Math.round(x)},${Math.round(y)}`;
      }
      return "click";
    }
    case "type": {
      const ref = refOf(given.ref);
      return `type ${ref ? `${ref} ` : ""}(${characters(given.text)})`;
    }
    case "press":
      return clip(`press ${keyOf(given.key)}`);
    case "screenshot": {
      const ref = refOf(given.ref);
      return ref ? `screenshot ${ref}` : "screenshot";
    }
    case "eval":
      return `eval (${characters(given.expression)})`;
    default:
      return /^\w{1,40}$/.test(op) ? op : "step";
  }
};

/** The trace entry for a browser tool call: { kind: "browser", label: "browser " + browserStep(…) }, never a detail
 *  or a command; null for any other tool. */
export const describeBrowserTool = (tool: string, args: unknown): { kind: "browser"; label: string } | null => {
  if (!tool.startsWith("browser_")) return null;
  const op = tool.slice("browser_".length);
  if (!OPS.includes(op)) return null;
  let given = args;
  // Codex may hand the arguments over as JSON text.
  if (typeof given === "string") {
    try {
      given = JSON.parse(given);
    } catch {
      given = {};
    }
  }
  return { kind: "browser", label: `browser ${browserStep(op, given)}` };
};
