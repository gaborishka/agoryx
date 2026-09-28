import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import pc from "picocolors";
import { DaemonClient, type DaemonStreamItem } from "../../internal/agora/client.js";
import { AgoraDaemon, findDaemon, readDaemonInfo, type DaemonInfo } from "../../internal/agora/daemon.js";
import { RoomLockedError, type RoomEngine } from "../../internal/agora/engine.js";
import { agoraHome, DEFAULT_PORT, roomsDir } from "../../internal/agora/paths.js";
import { activeRun } from "../../internal/agora/projection.js";
import { createRoom, openEngine, resumeCommands } from "../../internal/agora/service.js";
import { RoomStore } from "../../internal/agora/store.js";
import { parseTableCommand, TABLE_USAGE } from "../../internal/agora/table-cli.js";
import { describeTableOp, renderTableMarkdown } from "../../internal/agora/table.js";
import type { EphemeralEvent, RoomAgent, RoomEvent, RoomSettings, RoomState } from "../../internal/agora/types.js";
import { CliUsageError, parseCliArgsOrThrow, type OptionSpec, type OutputWriter } from "./cli-args.js";

export const AGORA_COMMANDS = new Set([
  "up",
  "down",
  "open",
  "new",
  "rooms",
  "say",
  "tail",
  "table",
  "stop",
  "more",
  "continue",
  "resume",
  "settings",
]);

export const printAgoraUsage = (write: OutputWriter = console.log): void => {
  write(
    [
      "Rooms — Claude and Codex in one conversation, each in its own native session.",
      "",
      "  agoryx up [--port N] [-d]          Start the daemon (web UI + API). -d runs it in the background",
      "  agoryx down                        Stop the background daemon",
      "  agoryx open [room]                 Open the web UI (starts the daemon if needed)",
      '  agoryx new "name" [--dir D] [--budget N] [-m "first message"]',
      "  agoryx rooms                       List rooms",
      '  agoryx say [-r room] "text"        Post to the room and follow the run until it goes quiet',
      "  agoryx tail [-r room] [-f] [-n N] [--trace]   Print the conversation (and follow it)",
      "  agoryx table [-r room] [show|<op> …]         Show the table, or act on it",
      "  agoryx more [-r room]              Ask for another round",
      "  agoryx stop [-r room]              Stop the current run",
      "  agoryx resume [-r room]            Native session commands (claude --resume / codex resume)",
      "  agoryx settings [-r room] [--budget N] [--network on|off] [--autocommit on|off] [--access workspace|readonly]",
      "",
      "Table ops:",
      ...TABLE_USAGE.map((line) => `  ${line}`),
      "",
      "The room defaults to the one whose workspace contains the current directory, else the most recent.",
      "Without a running daemon, say/table/more run the room in this process until it goes quiet.",
      `State lives in ${agoraHome()} (override with AGORYX_HOME).`,
    ].join("\n"),
  );
};

const ROOM_OPT: OptionSpec = { long: "room", short: "r", takesValue: true };
const HELP_OPT: OptionSpec = { long: "help", short: "h", takesValue: false };

const parse = (argv: string[], specs: OptionSpec[]) => parseCliArgsOrThrow(argv, [HELP_OPT, ...specs], printAgoraUsage);

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

const clock = (ts: string): string => {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Prints room events as a readable transcript. */
export class TranscriptPrinter {
  private readonly seenActivities = new Set<string>();
  private readonly announced = new Set<string>();

  constructor(
    private readonly agents: RoomAgent[],
    private readonly human: string,
    private readonly options: { trace: boolean; write?: (text: string) => void } = { trace: true },
  ) {}

  private out(text: string): void {
    (this.options.write ?? ((chunk: string) => process.stdout.write(chunk)))(text);
  }

  private name(author: string): string {
    const agent = this.agents.find((entry) => entry.id === author);
    if (agent) return agent.kind === "claude" ? pc.yellow(pc.bold(agent.label)) : pc.cyan(pc.bold(agent.label));
    if (author === "agoryx") return pc.dim("agoryx");
    return author === this.human ? pc.magenta(pc.bold(author)) : pc.bold(author);
  }

  private plainName(author: string): string {
    return this.agents.find((entry) => entry.id === author)?.label ?? author;
  }

  event(event: RoomEvent): void {
    const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 140) - 12);
    switch (event.type) {
      case "message.posted": {
        const message = event.message;
        if (message.kind === "pass") {
          this.out(pc.dim(`  · ${this.plainName(message.author)} passed${message.text ? ` — ${oneLine(message.text, width)}` : ""}\n`));
        } else if (message.kind === "system") {
          this.out(pc.dim(`  — ${message.text}\n`));
        } else if (message.kind === "decision") {
          this.out(pc.green(`  ◆ ${message.text}\n`));
        } else {
          const where = message.native
            ? pc.dim(message.author === message.native.agent ? " · in its own session" : ` · directly in ${this.plainName(message.native.agent)}'s session`)
            : "";
          this.out(`\n${this.name(message.author)}${where} ${pc.dim(clock(event.ts))}\n${message.text}\n`);
        }
        return;
      }
      case "turn.started":
        if (this.options.trace && !this.announced.has(event.turnId)) {
          this.announced.add(event.turnId);
          this.out(pc.dim(`  … ${this.plainName(event.agent)} is working${event.resume ? "" : " (new session)"}\n`));
        }
        return;
      case "turn.activity": {
        if (!this.options.trace) return;
        const activity = event.activity;
        const key = `${event.turnId}:${activity.id}`;
        const failed = activity.status === "fail";
        if (this.seenActivities.has(key) && !failed) return;
        if (activity.kind === "thinking") return;
        this.seenActivities.add(key);
        const label = activity.detail ? `${activity.label} ${activity.detail}` : activity.label;
        this.out(pc.dim(`  │ ${this.plainName(event.agent)} ${failed ? pc.red("✗ ") : ""}${oneLine(label, width)}\n`));
        return;
      }
      case "turn.ended":
        if (event.files?.length) {
          this.out(pc.dim(`  ↳ ${this.plainName(event.agent)} changed ${event.files.slice(0, 8).join(", ")}${event.files.length > 8 ? ` +${event.files.length - 8}` : ""}\n`));
        }
        if (event.status === "interrupted") this.out(pc.dim(`  · ${this.plainName(event.agent)} was interrupted\n`));
        return;
      case "table.op":
        if (event.op.op === "decide") return; // the decision message says it
        this.out(pc.green(`  ▸ ${this.plainName(event.op.by)} ${describeTableOp(event.op)}\n`));
        return;
      case "commit.created":
        this.out(pc.dim(`  ✓ checkpoint ${event.sha.slice(0, 7)} — ${event.files} file${event.files === 1 ? "" : "s"}\n`));
        return;
      case "run.ended":
        if (event.reason === "quiet") this.out(pc.dim(`  (quiet — ${event.turns} turn${event.turns === 1 ? "" : "s"})\n`));
        return;
      default:
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Room access: through the daemon when it runs, otherwise in this process
// ---------------------------------------------------------------------------

const resolveRoom = (ref: string | undefined): string => RoomStore.resolveId(roomsDir(), ref, process.cwd());

interface Conn {
  roomId: string;
  state: RoomState;
  /** Mutations resolve to the seq of the event they created. */
  say(text: string): Promise<number>;
  table(op: Record<string, unknown>): Promise<{ text: string; seq: number }>;
  more(): Promise<number>;
  stop(): Promise<void>;
  settings(patch: Partial<RoomSettings>): Promise<RoomSettings>;
  /** Print events after `seq` until a run ends (or forever with `forever`). */
  follow(after: number, printer: TranscriptPrinter, options: { forever?: boolean }): Promise<void>;
  close(): Promise<void>;
}

const daemonConn = async (info: DaemonInfo, ref: string | undefined): Promise<Conn> => {
  const client = new DaemonClient(info);
  const roomId = resolveRoom(ref);
  const snapshot = await client.snapshot(roomId);
  return {
    roomId,
    state: snapshot.state,
    async say(text) {
      const { message } = await client.say(roomId, text);
      return message.seq;
    },
    async table(op) {
      const result = await client.table(roomId, op);
      return { text: result.text, seq: result.seq };
    },
    async more() {
      return (await client.continueRun(roomId)).seq;
    },
    async stop() {
      await client.stop(roomId);
    },
    async settings(patch) {
      return (await client.settings(roomId, patch)).settings;
    },
    async follow(after, printer, options) {
      const controller = new AbortController();
      let detached = false;
      const onSigint = () => {
        detached = true;
        controller.abort();
      };
      process.once("SIGINT", onSigint);
      try {
        for await (const item of client.events(roomId, after, controller.signal)) {
          if (item.kind !== "room") continue;
          printer.event(item.event);
          if (!options.forever && item.event.type === "run.ended") {
            const runs = (item.patch.runs as RoomState["runs"] | undefined) ?? [];
            if (!runs.some((run) => run.status === "active")) break;
          }
        }
      } finally {
        process.off("SIGINT", onSigint);
        controller.abort();
      }
      if (detached && !options.forever) {
        process.stdout.write(pc.dim("\n(detached — the run continues in the daemon; `agoryx stop` stops it)\n"));
      }
    },
    async close() {},
  };
};

const localConn = (ref: string | undefined): Conn => {
  const roomId = resolveRoom(ref);
  const store = RoomStore.open(roomsDir(), roomId);
  let engine: RoomEngine | null = null;
  const drive = (): RoomEngine => {
    if (engine) return engine;
    try {
      engine = openEngine(store);
    } catch (error) {
      if (error instanceof RoomLockedError) {
        throw new Error(`${error.message}. Start the daemon (\`agoryx up -d\`) so several terminals can share the room.`);
      }
      throw error;
    }
    return engine;
  };
  return {
    roomId,
    state: store.state,
    async say(text) {
      return drive().postHuman(text).seq;
    },
    async table(op) {
      const live = drive();
      const seq = store.state.seq + 1;
      const applied = live.tableOp(op);
      return { text: `${applied.id ? `${applied.id} · ` : ""}${describeTableOp(applied, store.state.table)}`, seq };
    },
    async more() {
      const live = drive();
      const seq = store.state.seq + 1;
      live.continueRun();
      return seq;
    },
    async stop() {
      await drive().stop("human");
    },
    async settings(patch) {
      drive().updateSettings(patch);
      return store.state.settings;
    },
    async follow(after, printer, options) {
      for (const event of store.since(after)) printer.event(event);
      if (options.forever) {
        // Follow a room another process drives by tailing its event log.
        const unsubscribe = store.subscribe((event) => {
          if ("seq" in event) printer.event(event as RoomEvent);
        });
        await new Promise<void>((resolveFollow) => {
          const timer = setInterval(() => store.refresh(), 400);
          process.once("SIGINT", () => {
            clearInterval(timer);
            resolveFollow();
          });
        });
        unsubscribe();
        return;
      }
      if (!engine) return;
      const live = engine;
      const unsubscribe = store.subscribe((event: RoomEvent | EphemeralEvent) => {
        if ("seq" in event) printer.event(event as RoomEvent);
      });
      let interrupted = false;
      const onSigint = () => {
        if (interrupted) process.exit(130);
        interrupted = true;
        process.stdout.write(pc.dim("\n(stopping the run — Ctrl-C again to force)\n"));
        void live.stop("human");
      };
      process.on("SIGINT", onSigint);
      try {
        await live.waitIdle();
      } finally {
        process.off("SIGINT", onSigint);
        unsubscribe();
      }
    },
    async close() {
      if (engine) await (engine as RoomEngine).close();
    },
  };
};

const connect = async (ref: string | undefined): Promise<Conn> => {
  const info = await findDaemon();
  return info ? daemonConn(info, ref) : localConn(ref);
};

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

const startDaemonDetached = async (port?: number): Promise<DaemonInfo> => {
  const running = await findDaemon();
  if (running) return running;
  const home = agoraHome();
  mkdirSync(home, { recursive: true });
  const logFile = join(home, "daemon.log");
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "up", ...(port ? ["--port", String(port)] : [])], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  closeSync(fd);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const info = await findDaemon();
    if (info) return info;
    if (child.exitCode !== null) break;
  }
  const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n") : "";
  throw new Error(`the daemon did not come up; see ${logFile}\n${tail}`);
};

const openUrl = (url: string): void => {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // printing the URL is enough
  }
};

const runUp = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [
    { long: "port", short: "p", takesValue: true },
    { long: "detach", short: "d", takesValue: false },
    { long: "open", takesValue: false },
  ]);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const port = parsed.options.port ? Number.parseInt(parsed.options.port, 10) : undefined;
  if (parsed.options.detach) {
    const info = await startDaemonDetached(port);
    console.log(`agoryx daemon running at ${pc.bold(info.url)} (pid ${info.pid})`);
    console.log(pc.dim("open the UI with `agoryx open`, stop it with `agoryx down`"));
    if (parsed.options.open) openUrl(`${info.url}/?t=${encodeURIComponent(info.token)}`);
    return 0;
  }
  const existing = await findDaemon();
  if (existing) {
    console.log(`agoryx daemon already running at ${existing.url} (pid ${existing.pid})`);
    return 0;
  }
  const daemon = new AgoraDaemon({
    port: port ?? DEFAULT_PORT,
    log: (message) => console.log(`${pc.dim(new Date().toISOString().slice(11, 19))} ${message}`),
  });
  const info = await daemon.start();
  console.log(`agoryx daemon at ${pc.bold(info.url)}  ·  UI: agoryx open  ·  Ctrl-C to stop`);
  if (parsed.options.open) openUrl(`${info.url}/?t=${encodeURIComponent(info.token)}`);
  let closing = false;
  await new Promise<void>((resolveUp) => {
    const shutdown = (signal: string) => {
      if (closing) process.exit(130);
      closing = true;
      console.log(pc.dim(`\n${signal}: stopping running turns and closing rooms…`));
      daemon.close().finally(resolveUp);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
  return 0;
};

const runDown = async (): Promise<number> => {
  const info = readDaemonInfo();
  if (!info) {
    console.log("no agoryx daemon is running");
    return 0;
  }
  process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    if (!readDaemonInfo()) {
      console.log(`stopped the daemon (pid ${info.pid})`);
      return 0;
    }
  }
  console.error(`the daemon (pid ${info.pid}) did not stop within 15s`);
  return 1;
};

const runOpen = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT]);
  const ref = parsed.options.room ?? parsed.positionals[0];
  const info = await startDaemonDetached();
  let hash = "";
  try {
    hash = `#${encodeURIComponent(resolveRoom(ref))}`;
  } catch {
    // no rooms yet: open the lobby
  }
  const url = `${info.url}/?t=${encodeURIComponent(info.token)}${hash}`;
  openUrl(url);
  console.log(`${info.url}/${hash}`);
  return 0;
};

// ---------------------------------------------------------------------------
// Room commands
// ---------------------------------------------------------------------------

const runNew = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [
    { long: "dir", takesValue: true },
    { long: "budget", takesValue: true },
    { long: "message", short: "m", takesValue: true },
  ]);
  const name = parsed.positionals.join(" ").trim();
  if (!name || parsed.options.help) {
    printAgoraUsage();
    return name ? 0 : 2;
  }
  const budget = parsed.options.budget ? Number.parseInt(parsed.options.budget, 10) : undefined;
  const info = await findDaemon();
  let roomId: string;
  if (info) {
    const { room } = await new DaemonClient(info).createRoom({
      name,
      ...(parsed.options.dir ? { dir: parsed.options.dir } : {}),
      ...(budget ? { budget } : {}),
    });
    roomId = room.id;
  } else {
    roomId = createRoom({ name, ...(parsed.options.dir ? { dir: parsed.options.dir } : {}), ...(budget ? { budget } : {}) }).id;
  }
  const store = RoomStore.open(roomsDir(), roomId);
  console.log(`${pc.bold(store.state.name)} ${pc.dim(`(${roomId})`)}`);
  console.log(`  workspace  ${store.state.workspace}${store.state.createdWorkspace ? pc.dim(" (new git repo)") : ""}`);
  console.log(`  here       ${store.state.agents.map((agent) => agent.label).join(", ")} and ${store.state.human}`);
  console.log(`  budget     ${store.state.settings.budget} agent turns per run`);
  if (parsed.options.message) {
    return say(roomId, parsed.options.message, { trace: true });
  }
  console.log(pc.dim(`\nnext: agoryx say -r ${roomId} "what we are doing"   ·   agoryx open ${roomId}`));
  return 0;
};

const runRooms = async (): Promise<number> => {
  const rooms = RoomStore.list(roomsDir());
  if (rooms.length === 0) {
    console.log('no rooms yet — agoryx new "name"');
    return 0;
  }
  for (const room of rooms) {
    const status = room.running ? pc.green("● working") : pc.dim("○");
    console.log(`${status} ${pc.bold(room.name)} ${pc.dim(room.id)}  ${pc.dim(`${room.messages} msgs · ${room.updatedAt.slice(0, 16).replace("T", " ")}`)}`);
    console.log(`   ${pc.dim(room.workspace)}`);
    if (room.lastMessage) console.log(`   ${pc.dim(`${room.lastMessage.author}: ${oneLine(room.lastMessage.text, 90)}`)}`);
  }
  return 0;
};

const say = async (ref: string | undefined, text: string, options: { trace: boolean; noWait?: boolean }): Promise<number> => {
  const conn = await connect(ref);
  try {
    const after = await conn.say(text);
    if (options.noWait) return 0;
    const printer = new TranscriptPrinter(conn.state.agents, conn.state.human, { trace: options.trace });
    await conn.follow(after, printer, {});
    return 0;
  } finally {
    await conn.close();
  }
};

const runSay = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT, { long: "no-wait", takesValue: false }, { long: "quiet", short: "q", takesValue: false }]);
  let text = parsed.positionals.join(" ").trim();
  if (!text && !process.stdin.isTTY) {
    text = readFileSync(0, "utf8").trim();
  }
  if (!text || parsed.options.help) {
    printAgoraUsage();
    return text ? 0 : 2;
  }
  return say(parsed.options.room, text, { trace: !parsed.options.quiet, noWait: Boolean(parsed.options["no-wait"]) });
};

const runTail = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [
    ROOM_OPT,
    { long: "follow", short: "f", takesValue: false },
    { long: "lines", short: "n", takesValue: true },
    { long: "trace", takesValue: false },
  ]);
  const ref = parsed.options.room ?? parsed.positionals[0];
  const roomId = resolveRoom(ref);
  const store = RoomStore.open(roomsDir(), roomId);
  const printer = new TranscriptPrinter(store.state.agents, store.state.human, { trace: Boolean(parsed.options.trace) });
  const limit = parsed.options.lines ? Number.parseInt(parsed.options.lines, 10) : 30;
  const visible = store.state.messages.filter((message) => message.kind !== "pass");
  const from = visible.length > limit ? visible[visible.length - limit]!.seq - 1 : 0;
  console.log(pc.dim(`${store.state.name} · ${store.state.workspace}`));
  for (const event of store.since(from)) printer.event(event);
  if (!parsed.options.follow) return 0;
  const info = await findDaemon();
  if (info) {
    const conn = await daemonConn(info, roomId);
    await conn.follow(store.state.seq, printer, { forever: true });
  } else {
    const conn = localConn(roomId);
    await conn.follow(store.state.seq, printer, { forever: true });
  }
  return 0;
};

const runTable = async (argv: string[]): Promise<number> => {
  // Inside an agent turn, behave exactly like the agent tool.
  if (process.env.AGORYX_OPS_DIR && process.env.AGORYX_AGENT) {
    const { agentCliScript } = await import("../../internal/agora/workspace.js");
    const child = spawn(process.execPath, [agentCliScript(), "table", ...argv], { stdio: "inherit" });
    return new Promise((resolveChild) => child.on("exit", (code) => resolveChild(code ?? 1)));
  }
  let room: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-r" || arg === "--room") room = argv[++index];
    else if (arg.startsWith("--room=")) room = arg.slice(7);
    else rest.push(arg);
  }
  const [verb, ...args] = rest;
  if (verb === "-h" || verb === "--help" || verb === "help") {
    printAgoraUsage();
    return 0;
  }
  if (!verb || verb === "show") {
    const store = RoomStore.open(roomsDir(), resolveRoom(room));
    process.stdout.write(renderTableMarkdown(store.state.table, store.state.name));
    return 0;
  }
  let op: Record<string, unknown>;
  try {
    op = parseTableCommand(verb, args);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), printAgoraUsage);
  }
  const conn = await connect(room);
  try {
    const result = await conn.table(op);
    console.log(pc.green(result.text));
    // A human move on the table is news for the agents: follow their answers.
    const printer = new TranscriptPrinter(conn.state.agents, conn.state.human, { trace: true });
    await conn.follow(result.seq, printer, {});
    return 0;
  } finally {
    await conn.close();
  }
};

const runMore = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT]);
  const conn = await connect(parsed.options.room ?? parsed.positionals[0]);
  try {
    const after = await conn.more();
    await conn.follow(after, new TranscriptPrinter(conn.state.agents, conn.state.human, { trace: true }), {});
    return 0;
  } finally {
    await conn.close();
  }
};

const runStop = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT]);
  const info = await findDaemon();
  const roomId = resolveRoom(parsed.options.room ?? parsed.positionals[0]);
  if (info) {
    await new DaemonClient(info).stop(roomId);
    console.log("stopped");
    return 0;
  }
  const store = RoomStore.open(roomsDir(), roomId);
  if (!activeRun(store.state)) {
    console.log("nothing is running");
    return 0;
  }
  const conn = localConn(roomId);
  try {
    await conn.stop();
  } finally {
    await conn.close();
  }
  console.log("stopped");
  return 0;
};

const runResume = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT]);
  const store = RoomStore.open(roomsDir(), resolveRoom(parsed.options.room ?? parsed.positionals[0]));
  const commands = resumeCommands(store);
  if (Object.keys(commands).length === 0) {
    console.log("no native sessions yet — the agents open them on their first turn");
    return 0;
  }
  console.log(pc.dim(`Each agent's side of ${store.state.name} is its own native session:`));
  for (const agent of store.state.agents) {
    const command = commands[agent.id];
    if (command) console.log(`  ${agent.label.padEnd(8)} ${command}`);
  }
  return 0;
};

const onOff = (value: string | undefined): boolean | undefined =>
  value === undefined ? undefined : ["on", "true", "yes", "1"].includes(value.toLowerCase());

const runSettings = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [
    ROOM_OPT,
    { long: "budget", takesValue: true },
    { long: "network", takesValue: true },
    { long: "autocommit", takesValue: true },
    { long: "access", takesValue: true },
  ]);
  const patch: Partial<RoomSettings> = {};
  if (parsed.options.budget) patch.budget = Number.parseInt(parsed.options.budget, 10);
  const network = onOff(parsed.options.network);
  if (network !== undefined) patch.network = network;
  const autoCommit = onOff(parsed.options.autocommit);
  if (autoCommit !== undefined) patch.autoCommit = autoCommit;
  if (parsed.options.access === "workspace" || parsed.options.access === "readonly") patch.access = parsed.options.access;
  const ref = parsed.options.room ?? parsed.positionals[0];
  let settings: RoomSettings;
  if (Object.keys(patch).length === 0) {
    settings = RoomStore.open(roomsDir(), resolveRoom(ref)).state.settings;
  } else {
    const conn = await connect(ref);
    try {
      settings = await conn.settings(patch);
    } finally {
      await conn.close();
    }
  }
  console.log(`budget      ${settings.budget} agent turns per run`);
  console.log(`access      ${settings.access === "workspace" ? "agents can edit the workspace (sandboxed)" : "read-only"}`);
  console.log(`network     ${settings.network ? "on" : "off"}`);
  console.log(`autocommit  ${settings.autoCommit ? "on (checkpoint commit after each run)" : "off"}`);
  console.log(`turn limit  ${Math.round(settings.turnTimeoutMs / 60_000)} min`);
  return 0;
};

export const runAgora = async (command: string, argv: string[]): Promise<number> => {
  switch (command) {
    case "up":
      return runUp(argv);
    case "down":
      return runDown();
    case "open":
      return runOpen(argv);
    case "new":
      return runNew(argv);
    case "rooms":
      return runRooms();
    case "say":
      return runSay(argv);
    case "tail":
      return runTail(argv);
    case "table":
      return runTable(argv);
    case "more":
    case "continue":
      return runMore(argv);
    case "stop":
      return runStop(argv);
    case "resume":
      return runResume(argv);
    case "settings":
      return runSettings(argv);
    default:
      throw new CliUsageError(`unknown room command '${command}'`, printAgoraUsage);
  }
};

export type { DaemonStreamItem };
