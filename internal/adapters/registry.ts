import type { Adapter } from "./adapter.js";
import { ClaudeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";

export const createAdapterRegistry = (): Record<string, Adapter> => ({
  codex: new CodexAdapter(),
  claude: new ClaudeAdapter(),
});
