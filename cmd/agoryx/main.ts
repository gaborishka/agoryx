import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";
import { createAdapterRegistry } from "../../internal/adapters/registry.js";
import {
  collectRoomExportData,
  collectTargetExportData,
  parseExportCommandArgs,
  renderSessionExport,
} from "./session-export.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import { loadConfig, toRuntimeConfig } from "../../internal/config/index.js";
import { ChatEngine } from "../../internal/engine/chat.js";
import type { AdapterEvent } from "../../internal/adapters/adapter.js";
import type { OrchestrationMode } from "../../internal/events/types.js";
import { SessionService } from "../../internal/session/service.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

const MODES: OrchestrationMode[] = ["manual", "round-robin", "auto"];

async function main(): Promise<void> {
  const [, , command = "help", ...rest] = process.argv;
  switch (command) {
    case "help":
      printUsage();
      return;
    case "chat":
      await runChat(rest);
      return;
    case "sessions":
      runSessions(rest);
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

const runChat = async (argv: string[]): Promise<void> => {
  const parsed = parseArgs(argv);
  const args = parsed.options;
  const cliAgents = args.agents
    ? args.agents
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    : undefined;

  const loadedConfig = loadConfig(args.config);
  const runtimeConfig = toRuntimeConfig(loadedConfig, {
    roomName: args["room-name"] ?? "Agoryx Room",
    resumeRoomId: args.resume,
    agents: cliAgents,
  });

  const mode = normalizeMode(args.mode ?? runtimeConfig.mode);
  if (!mode) {
    throw new Error(`Invalid mode: ${args.mode ?? runtimeConfig.mode}`);
  }

  const config: ChatRuntimeConfig = {
    ...runtimeConfig,
    mode,
    roomConfig: {
      ...runtimeConfig.roomConfig,
      mode,
    },
    dbPath: args.db ?? runtimeConfig.dbPath,
  };

  config.agents = config.agents
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const adapterMode = args["adapter-mode"];
  if (adapterMode === "cli" || adapterMode === "stub") {
    for (const agent of config.agents) {
      if (config.adapterConfig[agent]) {
        config.adapterConfig[agent] = {
          ...config.adapterConfig[agent],
          mode: adapterMode,
        };
      }
    }
  }

  const store = new SQLiteStore(config.dbPath);
  store.init();
  const session = new SessionService(store);
  const adapters = createAdapterRegistry();

  const engine = new ChatEngine(session, adapters, config, {
    onAdapterEvent: (adapterName, event) => {
      renderAdapterEvent(adapterName, event);
    },
  });

  const initialized = engine.init();
  printBanner(
    initialized.room.id,
    initialized.sessionId,
    initialized.mode,
    config.agents,
    config.adapterConfig,
  );

  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) {
        continue;
      }

      if (line.startsWith("/")) {
        const shouldContinue = await handleCommand(line, engine, config, store);
        if (!shouldContinue) {
          break;
        }
        continue;
      }

      const results = await engine.processUserMessage(line);
      if (results.length === 0) {
        console.log("No dispatch generated. In manual mode, mention an agent (e.g. @codex).");
        continue;
      }

      for (const result of results) {
        if (!result.success) {
          console.error(`[${result.adapter}] error: ${result.error ?? "unknown error"}`);
        }
      }
    }
  } finally {
    rl.close();
    store.close();
  }
};

const runSessions = (argv: string[]): void => {
  const parsed = parseArgs(argv);
  const options = parsed.options;
  const [subcommand, ...positionals] = parsed.positionals;
  const loadedConfig = loadConfig(options.config);
  const dbPath = options.db ?? loadedConfig.session.dbPath;
  const store = new SQLiteStore(dbPath);
  store.init();

  try {
    switch (subcommand) {
      case "list": {
        const parsedLimit = Number(options.limit ?? "20");
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20;
        const sessions = store.listSessionRuns(limit);
        if (sessions.length === 0) {
          console.log("No sessions found.");
          return;
        }

        console.log("session_id\troom_id\troom_name\tcreated_at");
        for (const session of sessions) {
          console.log(
            `${session.id}\t${session.roomId}\t${session.roomName}\t${session.createdAt}`,
          );
        }
        return;
      }
      case "export": {
        const targetId = positionals[0];
        if (!targetId) {
          printSessionsUsage();
          process.exitCode = 1;
          return;
        }

        const format = options.format?.toLowerCase();
        if (format && format !== "markdown" && format !== "json") {
          throw new Error(`Unsupported export format: ${format}`);
        }

        const outputText = renderSessionExport(
          collectTargetExportData(store, targetId),
          format === "json" ? "json" : "markdown",
        );

        const outPath = options.out;
        if (outPath) {
          writeFileSync(outPath, outputText, "utf8");
          console.log(`Session export written to ${outPath}`);
          return;
        }

        console.log(outputText);
        return;
      }
      default:
        printSessionsUsage();
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
};

const handleCommand = async (
  line: string,
  engine: ChatEngine,
  config: ChatRuntimeConfig,
  store: SQLiteStore,
): Promise<boolean> => {
  const [command, ...rest] = line.split(" ");
  switch (command) {
    case "/quit":
    case "/exit":
      return false;
    case "/help":
      printChatHelp();
      return true;
    case "/mode": {
      const target = normalizeMode(rest[0]);
      if (!target) {
        console.log("Usage: /mode <manual|round-robin|auto>");
        return true;
      }
      engine.setMode(target);
      console.log(`Mode switched to: ${target}`);
      return true;
    }
    case "/status": {
      const status = await engine.adapterStatus();
      console.log("Adapter status:");
      for (const [adapter, value] of Object.entries(status)) {
        const mode = config.adapterConfig[adapter]?.mode ?? "stub";
        console.log(`- ${adapter}: ${value} (mode=${mode})`);
      }
      return true;
    }
    case "/adapter": {
      const [agent, mode] = rest;
      if (!agent || (mode !== "stub" && mode !== "cli")) {
        console.log("Usage: /adapter <codex|claude> <stub|cli>");
        return true;
      }
      if (!config.adapterConfig[agent]) {
        console.log(`Unknown adapter: ${agent}`);
        return true;
      }
      config.adapterConfig[agent] = {
        ...config.adapterConfig[agent],
        mode,
      };
      console.log(`Adapter ${agent} switched to mode=${mode}`);
      return true;
    }
    case "/pin": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.log("Usage: /pin <label>: <content>");
        return true;
      }

      const [maybeLabel, ...contentParts] = text.split(":");
      const content = contentParts.join(":").trim();
      const label = content ? maybeLabel.trim() : `pin-${Date.now()}`;
      const resolvedContent = content || maybeLabel.trim();
      const id = engine.addPinnedContext(label, resolvedContent);
      console.log(`Pinned context created: ${id}`);
      return true;
    }
    case "/unpin": {
      const [pinId] = rest;
      if (!pinId) {
        console.log("Usage: /unpin <pin_id>");
        return true;
      }
      const removed = engine.removePinnedContext(pinId);
      console.log(removed ? `Removed pinned context ${pinId}` : `Pin ${pinId} not found`);
      return true;
    }
    case "/summary": {
      const summary = engine.checkpointNow();
      if (!summary) {
        console.log("Not enough conversation history to create a checkpoint.");
      } else {
        console.log("Checkpoint created.");
      }
      return true;
    }
    case "/history": {
      const requested = Number(rest[0] ?? "10");
      const limit = Number.isFinite(requested) && requested > 0 ? requested : 10;
      const messages = engine.listMessages(limit);
      for (const message of messages.slice(-limit)) {
        console.log(`[${message.author}] ${message.text}`);
      }
      return true;
    }
    case "/retry": {
      const [rawTarget] = rest;
      const target = rawTarget?.replace("@", "").trim();
      if (!target) {
        console.log("Usage: /retry @codex");
        return true;
      }
      const retry = await engine.retryFailed(target);
      if (!retry) {
        console.log(`No failed request found for ${target}.`);
      } else if (!retry.success) {
        console.error(
          `[${retry.adapter}] retry failed (${retry.failedRequestId} -> ${retry.requestId}): ${
            retry.error ?? "unknown error"
          }`,
        );
      } else {
        console.log(
          `[${retry.adapter}] retry succeeded (${retry.failedRequestId} -> ${retry.requestId})`,
        );
      }
      return true;
    }
    case "/export": {
      const parsed = parseExportCommandArgs(rest);
      if (!parsed) {
        console.log("Usage: /export [markdown|json] [--out <file>]");
        return true;
      }

      const state = engine.getState();
      const exportData = collectRoomExportData(store, state.room.id, state.sessionId);
      const outputText = renderSessionExport(exportData, parsed.format);
      if (parsed.outPath) {
        writeFileSync(parsed.outPath, outputText, "utf8");
        console.log(`Session export written to ${parsed.outPath}`);
      } else {
        console.log(outputText);
      }

      return true;
    }
    default:
      console.log(`Unknown command: ${command}. Use /help.`);
      return true;
  }
};

const renderAdapterEvent = (adapterName: string, event: AdapterEvent): void => {
  switch (event.type) {
    case "message.started":
      output.write(`\n${adapterName}: `);
      return;
    case "message.delta": {
      const text = extractPayloadText(event.payload);
      if (text) {
        output.write(text);
      }
      return;
    }
    case "message.completed":
      output.write("\n");
      return;
    case "message.error": {
      const payload = event.payload as { class?: string; message?: string };
      output.write(
        `\n${adapterName} error (${payload.class ?? "UNKNOWN"}): ${
          payload.message ?? "unknown"
        }\n`,
      );
      return;
    }
    default:
      return;
  }
};

const extractPayloadText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const text = (payload as { text?: string }).text;
  return typeof text === "string" ? text : "";
};

const normalizeMode = (value?: string): OrchestrationMode | null => {
  if (!value) {
    return null;
  }
  if ((MODES as string[]).includes(value)) {
    return value as OrchestrationMode;
  }
  return null;
};

const printUsage = (): void => {
  console.log(`
Usage:
  agoryx chat [--agents codex,claude] [--mode manual|round-robin|auto]
  agoryx sessions list [--limit 20] [--db ./agoryx.db]
  agoryx sessions export <room_or_session_id> [--format markdown|json] [--out file] [--db ./agoryx.db]

Options:
  --agents       Comma-separated list of agents (default: codex,claude)
  --mode         Orchestration mode (default: manual)
  --config       Path to agoryx.json config file (default: ./agoryx.json)
  --db           SQLite path (default: ./agoryx.db)
  --adapter-mode Global adapter mode: stub|cli (default: stub)
  --resume       Resume existing room by id
  --room-name    Room title
`);
};

const printSessionsUsage = (): void => {
  console.log(`
Usage:
  agoryx sessions list [--limit 20] [--db ./agoryx.db]
  agoryx sessions export <room_or_session_id> [--format markdown|json] [--out file] [--db ./agoryx.db]
`);
};

const printChatHelp = (): void => {
  console.log(`
In-chat commands:
  /help
  /mode <manual|round-robin|auto>
  /status
  /adapter <codex|claude> <stub|cli>
  /pin <label>: <content>
  /unpin <pin_id>
  /summary
  /history [count]
  /retry @codex
  /export [markdown|json] [--out <file>]
  /quit
`);
};

const printBanner = (
  roomId: string,
  sessionId: string,
  mode: OrchestrationMode,
  agents: string[],
  adapterConfig: ChatRuntimeConfig["adapterConfig"],
): void => {
  console.log("Agoryx v0.1-dev");
  console.log(`Room: ${roomId}`);
  console.log(`Session: ${sessionId}`);
  console.log(`Mode: ${mode}`);
  console.log(`Agents: ${agents.join(", ")}`);
  for (const agent of agents) {
    console.log(`- ${agent}: mode=${adapterConfig[agent]?.mode ?? "stub"}`);
  }
  console.log("Type /help for commands.\n");
};

interface ParsedArgs {
  options: Record<string, string>;
  positionals: string[];
}

const parseArgs = (args: string[]): ParsedArgs => {
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { options, positionals };
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Fatal error");
  process.exit(1);
});
