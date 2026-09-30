import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { actorIn, AGENT_KEY_ENV, loadOrCreateToken, originName, originOf, readAgentKey } from "../../internal/agora/actor.js";
import { DaemonClient, DaemonRequestError, type DaemonStreamItem } from "../../internal/agora/client.js";
import { AgoraDaemon, findDaemon, readDaemonInfo, type DaemonInfo } from "../../internal/agora/daemon.js";
import { deviceLabel, DeviceRegistry, type DeviceInfo } from "../../internal/agora/devices.js";
import { isExposed, readExposure, writeExposure, type Exposure } from "../../internal/agora/exposure.js";
import { qrTerminal } from "../../internal/agora/qr.js";
import { RoomLockedError, roomTurnPatch, type RoomEngine } from "../../internal/agora/engine.js";
import { jevEnvFrom, JEV_ENV } from "../../internal/agora/jev.js";
import { agoraHome, daemonInfoPath, DEFAULT_PORT, roomsDir } from "../../internal/agora/paths.js";
import { type AgentLook, agentLook } from "../../internal/agora/look.js";
import { activeRun } from "../../internal/agora/projection.js";
import { describeProfile, profilePath, readProfile } from "../../internal/agora/profile.js";
import { readRoster, RosterError, rosterPath } from "../../internal/agora/roster.js";
import { createRoom, openEngine, resumeCommands, roomNameFrom } from "../../internal/agora/service.js";
import { readDoc, renderDiff } from "../../internal/agora/doc.js";
import { describeRevert, planRevert, RevertError, undoableRevert, type RevertRequest } from "../../internal/agora/revert.js";
import { changeStats, patchSection, workspaceTracking } from "../../internal/agora/workspace.js";
import { RoomStore } from "../../internal/agora/store.js";
import { headlineWindow, limitPace } from "../../internal/agora/limits.js";
import { readLimits } from "../../internal/agora/limits-store.js";
import { roomUsage, TURN_OUTCOMES, type UsageTotals } from "../../internal/agora/usage.js";
import { applyTurnContext, TURN_FILE_ENV } from "../../internal/agora/turn-context.js";
import { parseTableCommand, TABLE_USAGE } from "../../internal/agora/table-cli.js";
import { desktopEnv, TURN_ENV_VARS } from "../../internal/desktop/shellenv.js";
import { launchdService, SERVICE_PINNED_VARS } from "../../internal/desktop/launchd.js";
import { describeTableOp, renderTableMarkdown } from "../../internal/agora/table.js";
import type { Actor, ActorOrigin, AgentKind, AgentPresence, EphemeralEvent, LimitSnapshot, LimitWindow, RoomAgent, RoomEvent, RoomSettings, RoomState } from "../../internal/agora/types.js";
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
  "doc",
  "diff",
  "revert",
  "profile",
  "usage",
  "pair",
  "devices",
]);

export const printAgoraUsage = (write: OutputWriter = console.log): void => {
  write(
    [
      "Rooms — Claude and Codex (or any agents you list) in one conversation, each in its own native session.",
      "",
      "  agoryx up [--port N] [-d] [--lan] [--tailscale] [--allow-host NAME] [--local] [--login-env]",
      "                                     Start the daemon (web UI + API). -d runs it in the background.",
      "                                     --lan also listens on this computer's Wi-Fi/Ethernet address, for a phone on the same Wi-Fi;",
      "                                     --tailscale accepts this machine's *.ts.net name, for `tailscale serve` (HTTPS, notifications);",
      "                                     --local: this computer only (the default). The choice applies to a running daemon and is remembered",
      "                                     --login-env: take PATH and keys from your login shell, as the launchd service does",
      "  agoryx pair                        Pair a phone: a QR code and a one-time code (5 minutes) to open Agoryx on it",
      "  agoryx devices [revoke ID]         Paired devices, and revoking one",
      "  agoryx down                        Stop the background daemon",
      "  agoryx open [room]                 Open the web UI (starts the daemon if needed)",
      '  agoryx new ["name"] [--dir D [--worktree [--base BRANCH]]] [--budget N|none] [--doc PATH|none] [--agents FILE|JSON] [-m "first message"]   (no name: the message names it)',
      "  agoryx rooms                       List rooms",
      '  agoryx say [-r room] "text"        Post to the room and follow the run until it goes quiet',
      "  agoryx tail [-r room] [-f] [-n N] [--trace]   Print the conversation (and follow it)",
      "  agoryx table [-r room] [show|<op> …]         Show the table, or act on it",
      "  agoryx more [-r room]              Ask for another round",
      "  agoryx stop [-r room]              Stop the current run",
      "  agoryx resume [-r room]            Native session commands (claude --resume / codex resume)",
      "  agoryx doc [-r room] [--log | --diff REV]   The room's canonical file: its text, its revisions, one revision's diff",
      "  agoryx diff [-r room] [TURN [PATH]]         What each turn changed: recent turns, or one turn's exact patch",
      "  agoryx revert [-r room] [SHA | --undo [N]] [--yes]   Return the folder to a checkpoint (no SHA: list them), or undo a return",
      "  agoryx usage [room] [--json]      Your agents' subscription limits, as their CLIs last reported them, and what the room's wakes cost",
      "  agoryx profile [-r room]           Your profile (who you are, for the agents): where it is, and who in the room sees it",
      "  agoryx settings [-r room] [--budget N|none] [--network on|off] [--autocommit on|off] [--access workspace|readonly] [--doc PATH|none]",
      "",
      "Table ops:",
      ...TABLE_USAGE.map((line) => `  ${line}`),
      "",
      "The room defaults to the one whose workspace contains the current directory, else the most recent.",
      "Without a running daemon, say/table/more run the room in this process until it goes quiet.",
      'Agents: a JSON list like [{"id":"opus","kind":"claude","model":"opus"},{"kind":"codex"}] (kind: claude|codex; id, label, model optional;',
      `  "profile": false keeps your profile, ${profilePath()}, out of that agent's prompts — not out of reach of its own tools).`,
      `New rooms seat the agents in ${rosterPath()} when it exists, else Claude and Codex; --agents seats others in one room.`,
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

/** A timestamp as a local date and time, like the room's clock shows it. */
const localStamp = (ts: string): string => `${new Date(ts).toLocaleDateString("sv-SE")} ${clock(ts)}`;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

type Colors = Omit<typeof pc, "createColors">;
type Hue = "yellow" | "yellowBright" | "red" | "redBright" | "cyan" | "cyanBright" | "blue" | "blueBright";

/**
 * Terminal inks per kind: warm for Claude, cool for Codex (magenta is the human, green the table).
 * The first is the kind's own colour; the others go to more agents of that kind, in roster order,
 * and past four they are underlined too — eight agents of one kind, eight looks.
 */
const TERMINAL_INKS: Record<AgentKind, Hue[]> = {
  claude: ["yellow", "redBright", "yellowBright", "red"],
  codex: ["cyan", "blueBright", "cyanBright", "blue"],
};

/** How `agoryx tail` paints an agent's name: its kind's colour, or its own shade of it next to another of its kind (see look.ts). */
export const terminalInk = (look: AgentLook, colors: Colors = pc): ((text: string) => string) => {
  const hues = TERMINAL_INKS[look.kind];
  const hue = colors[hues[look.shade % hues.length]!];
  return look.shade >= hues.length ? (text) => colors.underline(hue(text)) : hue;
};

/** Prints room events as a readable transcript. */
export class TranscriptPrinter {
  private readonly seenActivities = new Set<string>();
  /** Agents of other rooms that acted here, learned from the events that name them. */
  private readonly guests = new Map<string, ActorOrigin>();
  private readonly announced = new Set<string>();
  private readonly directNow = new Set<string>();

  constructor(
    private readonly agents: RoomAgent[],
    private readonly human: string,
    private readonly options: { trace: boolean; write?: (text: string) => void; colors?: Colors } = { trace: true },
  ) {}

  private get colors(): Colors {
    return this.options.colors ?? pc;
  }

  private out(text: string): void {
    (this.options.write ?? ((chunk: string) => process.stdout.write(chunk)))(text);
  }

  private name(author: string): string {
    const c = this.colors;
    const agent = this.agents.find((entry) => entry.id === author);
    const look = agent ? agentLook(this.agents, agent.id) : undefined;
    if (agent && look) return terminalInk(look, c)(c.bold(agent.label));
    if (author === "agoryx") return c.dim("agoryx");
    const guest = this.guests.get(author);
    if (guest) return c.bold(originName(guest));
    return author === this.human ? c.magenta(c.bold(author)) : c.bold(author);
  }

  private plainName(author: string): string {
    const guest = this.guests.get(author);
    return this.agents.find((entry) => entry.id === author)?.label ?? (guest ? originName(guest) : author);
  }

  /** Someone started talking to an agent in its own app: say so once, since its room turn now waits. */
  presence(agents: Record<string, AgentPresence>): void {
    for (const [id, now] of Object.entries(agents)) {
      if (now !== "native") {
        this.directNow.delete(id);
        continue;
      }
      if (this.directNow.has(id)) continue;
      this.directNow.add(id);
      this.out(pc.dim(`  · ${this.plainName(id)} is in a direct exchange in its own session — its turn here waits for it\n`));
    }
  }

  event(event: RoomEvent): void {
    const from = event.type === "message.posted" ? event.message.from : event.type === "table.op" ? event.op.from : "from" in event ? event.from : undefined;
    if (from) this.guests.set(`${from.agent}@${from.room}`, from);
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
        } else if (message.kind === "update") {
          this.out(`  ${this.name(message.author)} ${pc.dim("· while working:")} ${message.text}\n`);
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
        if (event.changes?.length) {
          const listed = event.changes.slice(0, 8).map((change) => `${change.path} ${changeStats(change)}`).join(", ");
          const more = event.changes.length > 8 ? ` +${event.changes.length - 8} more` : "";
          this.out(pc.dim(`  ↳ ${this.plainName(event.agent)} changed ${listed}${more} — agoryx diff ${event.turnId}\n`));
        } else if (event.files?.length) {
          this.out(pc.dim(`  ↳ ${this.plainName(event.agent)} changed ${event.files.slice(0, 8).join(", ")}${event.files.length > 8 ? ` +${event.files.length - 8}` : ""}\n`));
        }
        if (event.status === "interrupted") this.out(pc.dim(`  · ${this.plainName(event.agent)} was interrupted\n`));
        return;
      case "table.op": {
        if (event.op.op === "decide") return; // the decision message says it
        const outside = !event.op.turnId && this.agents.some((agent) => agent.id === event.op.by) ? pc.dim(" (in its own session)") : "";
        this.out(pc.green(`  ▸ ${this.plainName(event.op.by)} ${describeTableOp(event.op)}`) + `${outside}\n`);
        return;
      }
      case "doc.revised": {
        if (event.by === "agoryx") return;
        const outside = event.native ? pc.dim(" (in its own session)") : "";
        const what = event.text === null ? `deleted ${event.path}` : `edited ${event.path} ${pc.green(`+${event.added}`)} ${pc.red(`−${event.removed}`)}`;
        const by = event.among ? event.among.map((id) => this.plainName(id)).join(" or ") : this.plainName(event.by);
        const whose = event.among ? pc.dim(" (parallel turns — the room cannot tell whose)") : "";
        this.out(`  ${pc.magenta("✎")} ${by} ${what}${outside}${whose}\n`);
        return;
      }
      case "commit.created":
        this.out(pc.dim(`  ✓ checkpoint ${event.sha.slice(0, 7)} — ${event.files} file${event.files === 1 ? "" : "s"}\n`));
        return;
      case "workspace.reverted":
        this.out(`  ${pc.magenta("↺")} ${describeRevert(event, (handle) => this.plainName(handle))}${event.undoOf === undefined && !event.fromRoom ? pc.dim(` — agoryx revert --undo ${event.seq}`) : ""}\n`);
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

// Under a live agent the turn is not in the environment: take the current one from its file (or none, between turns).
applyTurnContext();

/** No room named: inside an agent's room turn, that room; else the one this directory is in (or the latest). */
const resolveRoom = (ref: string | undefined): string => {
  const turnRoom = process.env.AGORYX_TURN ? process.env.AGORYX_ROOM : undefined;
  if (!ref && turnRoom && existsSync(join(roomsDir(), turnRoom))) return turnRoom;
  return RoomStore.resolveId(roomsDir(), ref, process.cwd());
};

/** In an agent's room turn: the run it would follow cannot end while this command holds the turn open. */
// A live agent's shell has no turn of its own in its environment, only the file that names the current one:
// with the file named but the turn over, this is still "an agent's" command, and it must not be sent as the human's.
const inAgentTurn = (): boolean => Boolean(process.env.AGORYX_AGENT && (process.env.AGORYX_TURN || process.env[TURN_FILE_ENV]));

/**
 * The daemon, as whoever is running this: in an agent's turn, with the agent's own key (so what it does
 * is recorded as that agent's, not the human's); otherwise with the human's token.
 */
const daemonClient = (info: DaemonInfo): DaemonClient => {
  const key = process.env[AGENT_KEY_ENV]?.trim();
  // A turn without a key of its own would act with the human's token: what it did would be recorded as theirs.
  if (!key && inAgentTurn()) {
    throw new Error(
      `this is ${process.env.AGORYX_AGENT}'s turn, but it has no ${AGENT_KEY_ENV}: the daemon would record this as the human's doing, so it was not sent`,
    );
  }
  return new DaemonClient({ url: info.url, token: key || info.token });
};

/**
 * Without a daemon, the agent this process runs for, if any: named by its key (checked against the
 * token it was signed with), or — for a turn from before keys — by its turn's environment.
 */
const localAgent = (): ActorOrigin | null => {
  const key = process.env[AGENT_KEY_ENV]?.trim();
  let named: { room: string; agent: string } | null = null;
  if (key) {
    named = readAgentKey(loadOrCreateToken(), key);
    if (!named) throw new Error(`${AGENT_KEY_ENV} was not issued for ${agoraHome()} (a stale key, or another Agoryx home)`);
  } else if (inAgentTurn() && process.env.AGORYX_ROOM) {
    named = { room: process.env.AGORYX_ROOM, agent: process.env.AGORYX_AGENT! };
  }
  if (!named) return null;
  try {
    return originOf(RoomStore.open(roomsDir(), named.room).state, named.agent);
  } catch {
    return null;
  }
};

/**
 * `.env` files the daemon's Jev key may sit in: this install's, and, when it runs from a git worktree, the main
 * checkout's.
 */
const dotenvFiles = (): string[] => {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
  const files = [join(root, ".env")];
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"))?.[1]?.trim();
    const main = gitdir && /[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.test(gitdir) ? resolve(gitdir, "../../..") : undefined;
    if (main) files.push(join(main, ".env"));
  } catch {
    // Not a worktree (or not git at all): the install's own .env only.
  }
  return files;
};

/**
 * `agoryx up --login-env` (what the launchd service runs): the login shell's environment over this
 * process's, as the app does, so the daemon and its agents get the PATH and keys of a terminal while the
 * plist holds none of them. The home and workspace root stay the service's (SERVICE_PINNED_VARS).
 */
const takeLoginShellEnv = async (): Promise<"login-shell" | "fallback"> => {
  const { env, source } = await desktopEnv(process.env);
  for (const key of SERVICE_PINNED_VARS) {
    const own = process.env[key];
    if (own?.trim()) env[key] = own;
    else delete env[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  for (const key of SERVICE_PINNED_VARS) if (env[key] === undefined) delete process.env[key];
  return source;
};

/** Environment for a daemon started from here: never an agent turn's (its room, its key). */
const daemonEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const file of dotenvFiles()) {
    if (existsSync(file)) jevEnvFrom(readFileSync(file, "utf8"), env);
  }
  const agent = localAgentOrNull();
  for (const key of TURN_ENV_VARS) delete env[key];
  if (agent) env.AGORYX_UP_BY = originName(agent);
  return env;
};

const localAgentOrNull = (): ActorOrigin | null => {
  try {
    return localAgent();
  } catch {
    return null;
  }
};

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
  const client = daemonClient(info);
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
          if (item.kind === "presence") printer.presence(item.agents);
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
  // An agent's command is its own here too, as through the daemon.
  const agent = localAgent();
  const actor: Actor | undefined = agent ? actorIn(store.state, agent) : undefined;
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
      return drive().post(text, actor).seq;
    },
    async table(op) {
      const live = drive();
      const seq = store.state.seq + 1;
      const applied = live.tableOp(op, actor);
      return { text: `${applied.id ? `${applied.id} · ` : ""}${describeTableOp(applied, store.state.table)}`, seq };
    },
    async more() {
      const live = drive();
      const seq = store.state.seq + 1;
      live.continueRun(actor);
      return seq;
    },
    async stop() {
      await drive().stop("human", actor);
    },
    async settings(patch) {
      drive().updateSettings(patch, actor);
      return store.state.settings;
    },
    async follow(after, printer, options) {
      for (const event of store.since(after)) printer.event(event);
      if (options.forever) {
        // Follow a room another process drives by tailing its event log.
        const unsubscribe = store.subscribe((event) => {
          if ("seq" in event) printer.event(event as RoomEvent);
          else if (event.type === "presence") printer.presence(event.agents);
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
        else if (event.type === "presence") printer.presence(event.agents);
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
  // With the launchd service installed for this home, launchd starts it (and owns it): never a second one next to it.
  const service = launchdService(process.env);
  if (service && (await service.loaded().catch(() => false))) {
    await service.kickstart();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      const info = await findDaemon();
      if (info) return info;
    }
    const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n") : "";
    throw new Error(`launchd (${service.label}) did not bring the daemon up; see ${logFile} and \`agoryx service status\`\n${tail}`);
  }
  const fd = openSync(logFile, "a");
  // How it is reachable besides this computer comes from exposure.json, as for any other start.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "up", ...(port ? ["--port", String(port)] : [])], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: daemonEnv(),
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

/** This machine's name on its tailnet (`<machine>.<tailnet>.ts.net`), from the Tailscale CLI. */
const tailscaleName = (): string => {
  const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const name = String((JSON.parse(out) as { Self?: { DNSName?: unknown } }).Self?.DNSName ?? "").replace(/\.$/, "");
      if (name) return name;
    } catch {
      // the next candidate
    }
  }
  throw new CliUsageError("--tailscale: no running Tailscale found (`tailscale status` failed); install and log in to Tailscale, or name the host with --allow-host");
};

/** Where phones reach the daemon, as the terminal says it. */
const printExposure = (exposure: { lan: boolean; hosts: string[]; addresses: string[] }, port: number, askedLan: boolean): void => {
  const urls = [...exposure.hosts.map((host) => `https://${host}`), ...exposure.addresses.map((address) => `http://${address}:${port}`)];
  if (askedLan && exposure.addresses.length === 0) console.log(pc.yellow("--lan: no Wi-Fi or Ethernet address on this computer; it listens on this computer only"));
  if (urls.length === 0) {
    console.log(pc.dim("reachable on this computer only"));
    return;
  }
  for (const url of urls) console.log(`phones: ${pc.bold(url)}`);
  console.log(pc.dim("pair one with `agoryx pair`; `agoryx up --local` closes it to this computer again"));
};

/** Applies the human's choice to a running daemon, without a restart. */
const applyExposure = async (info: DaemonInfo, exposure: Exposure): Promise<number> => {
  let result;
  try {
    result = await daemonClient(info).setExposure(exposure);
  } catch (error) {
    if (error instanceof DaemonRequestError && error.status === 404) {
      console.error("this daemon is too old to change how it is reachable; restart it: `agoryx down`, then `agoryx up -d`");
      return 1;
    }
    throw error;
  }
  printExposure(result, info.port, exposure.lan);
  return 0;
};

const runUp = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [
    { long: "port", short: "p", takesValue: true },
    { long: "detach", short: "d", takesValue: false },
    { long: "open", takesValue: false },
    { long: "lan", takesValue: false },
    { long: "tailscale", takesValue: false },
    { long: "allow-host", takesValue: true },
    { long: "local", takesValue: false },
    { long: "login-env", takesValue: false },
  ]);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const port = parsed.options.port ? Number.parseInt(parsed.options.port, 10) : undefined;
  // Exposure is opt-in. Flags given now are the human's choice: applied to a running daemon and saved for
  // every later start (the app's, a restart after a crash); no flags: the saved choice (none by default).
  const opens = Boolean(parsed.options.lan || parsed.options.tailscale || parsed.options["allow-host"]);
  if (opens && parsed.options.local) throw new CliUsageError("--local closes the daemon to other devices; it does not go with --lan, --tailscale or --allow-host");
  if ((opens || parsed.options.local) && inAgentTurn()) {
    console.error("how the daemon is reachable from other devices is the human's to choose, not an agent's");
    return 1;
  }
  const chosen: Exposure | null =
    opens || parsed.options.local
      ? {
          lan: Boolean(parsed.options.lan),
          hosts: [
            ...(parsed.options["allow-host"] ?? "").split(",").map((host) => host.trim()).filter(Boolean),
            ...(parsed.options.tailscale ? [tailscaleName()] : []),
          ],
        }
      : null;
  const existing = await findDaemon();
  if (existing) {
    console.log(`agoryx daemon ${parsed.options.detach ? "running" : "already running"} at ${pc.bold(existing.url)} (pid ${existing.pid})`);
    let code = 0;
    // The daemon saves the choice once it applied it.
    if (chosen) code = await applyExposure(existing, chosen);
    if (parsed.options.open) openUrl(`${existing.url}/?t=${encodeURIComponent(existing.token)}`);
    return code;
  }
  if (chosen) writeExposure(chosen);
  if (parsed.options.detach) {
    const info = await startDaemonDetached(port);
    console.log(`agoryx daemon running at ${pc.bold(info.url)} (pid ${info.pid})`);
    try {
      printExposure(await daemonClient(info).exposure(), info.port, Boolean(chosen?.lan));
    } catch {
      // an older daemon: it says nothing about phones
    }
    console.log(pc.dim("open the UI with `agoryx open`, stop it with `agoryx down`"));
    if (parsed.options.open) openUrl(`${info.url}/?t=${encodeURIComponent(info.token)}`);
    return 0;
  }
  const exposure = chosen ?? readExposure();
  const stamp = (message: string) => console.log(`${pc.dim(new Date().toISOString().slice(11, 19))} ${message}`);
  if (parsed.options["login-env"]) {
    const source = await takeLoginShellEnv();
    stamp(source === "login-shell" ? `environment from the login shell (${process.env.SHELL ?? "/bin/zsh"})` : "login shell unavailable: PATH from the service and the usual install folders");
    // The probe took seconds: another start may have won meanwhile.
    const late = await findDaemon();
    if (late) {
      console.log(`agoryx daemon already running at ${late.url} (pid ${late.pid})`);
      return 0;
    }
  }
  let closing = false;
  let finish: () => void = () => {};
  const shutdown = (reason: string, by?: ActorOrigin | { human: true }) => {
    if (closing) process.exit(130);
    closing = true;
    console.log(pc.dim(`\n${reason}: stopping running turns and closing rooms…`));
    void daemon.close(by).finally(() => finish());
  };
  const env = daemonEnv();
  const startedBy = process.env.AGORYX_UP_BY ?? (localAgentOrNull() ? originName(localAgentOrNull()!) : undefined);
  delete env.AGORYX_UP_BY;
  const daemon = new AgoraDaemon({
    env,
    port: port ?? DEFAULT_PORT,
    log: stamp,
    ...(exposure.lan ? { lan: true } : {}),
    ...(exposure.hosts.length > 0 ? { hosts: exposure.hosts } : {}),
    // `agoryx down`: whoever asked (an agent with its key, or the human) is recorded in the rooms it stops.
    onDown: (by) => shutdown(`agoryx down by ${by ? originName(by) : "the human"}`, by ?? { human: true }),
  });
  const info = await daemon.start();
  if (startedBy) stamp(`started by ${startedBy}`);
  if (!chosen && isExposed(exposure)) stamp("reachable from other devices as saved (`agoryx up --local` closes it to this computer)");
  const jevKey = JEV_ENV.slice(0, 2).find((name) => env[name]);
  const jevOff = String(env.AGORYX_JEV ?? "").trim().toLowerCase() === "off";
  stamp(jevOff ? "Jev off (AGORYX_JEV=off)" : jevKey ? `Jev on (${jevKey})` : "Jev off: no key");
  console.log(`agoryx daemon at ${pc.bold(info.url)}  ·  UI: agoryx open  ·  Ctrl-C to stop`);
  if (parsed.options.tailscale) console.log(pc.dim(`for the phone over HTTPS, run once: tailscale serve --bg ${info.port}   (then: agoryx pair)`));
  if (parsed.options.open) openUrl(`${info.url}/?t=${encodeURIComponent(info.token)}`);
  await new Promise<void>((resolveUp) => {
    finish = resolveUp;
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
  // daemon.json can outlive a crashed daemon and its pid be reused: signal only a process that
  // proves it is the daemon by answering /api/health with that pid. A command-line match is not
  // proof (any `vim …/agoryx/…` would pass), so an unverified pid is never signalled.
  if (!(await findDaemon())) {
    rmSync(daemonInfoPath(), { force: true });
    console.log(
      `no agoryx daemon answers at ${info.url}; removed the record for pid ${info.pid}. ` +
        `If that pid is a hung agoryx daemon, stop it yourself (kill ${info.pid}).`,
    );
    return 0;
  }
  // Asked through the API, the daemon records who stopped it (an agent's key names the agent);
  // a daemon too old to have /api/down is signalled as before.
  try {
    await daemonClient(info).down();
  } catch (error) {
    if (!(error instanceof DaemonRequestError) || error.status !== 404) throw error;
    process.kill(info.pid, "SIGTERM");
  }
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
    { long: "worktree", takesValue: false },
    { long: "base", takesValue: true },
    { long: "budget", takesValue: true },
    { long: "doc", takesValue: true },
    { long: "agents", takesValue: true },
    { long: "message", short: "m", takesValue: true },
  ]);
  // No name: the first message names the room (rename it later in the web UI).
  const name = parsed.positionals.join(" ").trim() || (parsed.options.message?.trim() ? roomNameFrom(parsed.options.message) : "");
  if (!name || parsed.options.help) {
    printAgoraUsage();
    return name ? 0 : 2;
  }
  const budget = budgetOption(parsed.options.budget);
  const doc = docOption(parsed.options.doc);
  let agents: RoomAgent[] | undefined;
  try {
    agents = parsed.options.agents !== undefined ? readRoster(parsed.options.agents) : undefined;
  } catch (error) {
    if (error instanceof RosterError) throw new CliUsageError(`--agents: ${error.message}`);
    throw error;
  }
  const input = {
    name,
    ...(agents ? { agents } : {}),
    ...(parsed.options.dir ? { dir: resolve(parsed.options.dir) } : {}),
    ...(parsed.options.worktree ? { worktree: true } : {}),
    ...(parsed.options.base ? { base: parsed.options.base } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(doc !== undefined ? { doc } : {}),
  };
  const info = await findDaemon();
  let roomId: string;
  if (info) {
    const { room } = await daemonClient(info).createRoom(input);
    roomId = room.id;
  } else {
    // Opened from an agent's turn: the room says which agent, from which room.
    const agent = localAgent();
    roomId = createRoom({ ...input, ...(agent ? { createdBy: agent } : {}) }).id;
  }
  const store = RoomStore.open(roomsDir(), roomId);
  console.log(`${pc.bold(store.state.name)} ${pc.dim(`(${roomId})`)}`);
  console.log(`  workspace  ${store.state.workspace}${store.state.createdWorkspace ? pc.dim(" (new git repo)") : ""}`);
  if (store.state.worktree) console.log(`  worktree   ${store.state.worktree.branch} ${pc.dim(`from ${store.state.worktree.base}, in ${store.state.worktree.repo}`)}`);
  console.log(`  here       ${store.state.agents.map((agent) => agent.label).join(", ")} and ${store.state.human}`);
  console.log(`  budget     ${budgetLine(store.state.settings.budget)}`);
  if (store.state.settings.doc) console.log(`  doc        ${store.state.settings.doc} ${pc.dim("(the room's canonical file)")}`);
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
  // Without waiting, only a daemon can carry the run on: a room engine in this process would stop
  // with it. So --no-wait starts the daemon when none is running.
  let conn: Conn;
  if (options.noWait) {
    const running = await findDaemon();
    const info = running ?? (await startDaemonDetached());
    if (!running) console.error(pc.dim(`started the agoryx daemon at ${info.url} to carry the run`));
    conn = await daemonConn(info, ref);
  } else {
    conn = await connect(ref);
  }
  try {
    const after = await conn.say(text);
    if (options.noWait || inAgentTurn()) return 0;
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
  const limit = parsed.options.lines === undefined ? 30 : Number(parsed.options.lines);
  if (!Number.isInteger(limit) || limit < 0) {
    console.error(`agoryx tail: -n takes a number of messages, 0 or more (got ${parsed.options.lines})`);
    return 2;
  }
  const visible = store.state.messages.filter((message) => message.kind !== "pass");
  // -n 0 prints no history (with -f: only what comes next).
  const from = limit === 0 ? store.state.seq : visible.length > limit ? visible[visible.length - limit]!.seq - 1 : 0;
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

/** The room workspace containing `dir`, if any (it has .agoryx/rooms, or .agoryx/ops from before rooms had their own directories). */
const roomWorkspaceOf = (dir: string): string | null => {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".agoryx", "rooms")) || existsSync(join(current, ".agoryx", "ops"))) return current;
    if (dirname(current) === current) return null;
  }
};

const runAgentTool = async (argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const { agentCliScript } = await import("../../internal/agora/workspace.js");
  const child = spawn(process.execPath, [agentCliScript(), "table", ...argv], { stdio: "inherit", env });
  return new Promise((resolveChild) => child.on("exit", (code) => resolveChild(code ?? 1)));
};

const runTable = async (argv: string[]): Promise<number> => {
  // Inside an agent turn, behave exactly like the agent tool.
  if (process.env.AGORYX_OPS_DIR && process.env.AGORYX_AGENT) return runAgentTool(argv);
  let room: string | undefined;
  let signedAs: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-r" || arg === "--room") room = argv[++index];
    else if (arg.startsWith("--room=")) room = arg.slice(7);
    else if (arg === "--as") signedAs = argv[++index];
    else if (arg.startsWith("--as=")) signedAs = arg.slice(5);
    else rest.push(arg);
  }
  // An agent in its own session (outside a room turn): sign the op as that agent,
  // not as the human. --as <human> keeps it a human move.
  const agentShell = Boolean(process.env.CLAUDECODE || process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED);
  const verbIsWrite = rest[0] !== undefined && !["show", "help", "-h", "--help"].includes(rest[0]);
  if (verbIsWrite && (signedAs || (agentShell && roomWorkspaceOf(process.cwd())))) {
    const store = RoomStore.open(roomsDir(), resolveRoom(room));
    if (!signedAs || signedAs.toLowerCase() !== store.state.human.toLowerCase()) {
      const { workspacePaths } = await import("../../internal/agora/workspace.js");
      const paths = workspacePaths(store.state.workspace, store.state.id);
      return runAgentTool([...rest, ...(signedAs ? ["--as", signedAs] : [])], {
        ...process.env,
        AGORYX_ROOM: store.state.id,
        AGORYX_OPS_DIR: paths.opsDir,
        AGORYX_TABLE: paths.tableFile,
      });
    }
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
    if (inAgentTurn()) return 0;
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
    if (inAgentTurn()) {
      console.log("asked for another round — the others answer after this turn");
      return 0;
    }
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
    await daemonClient(info).stop(roomId);
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
    { long: "doc", takesValue: true },
  ]);
  const patch: Partial<RoomSettings> = {};
  const doc = docOption(parsed.options.doc);
  if (doc !== undefined) patch.doc = doc;
  const budget = budgetOption(parsed.options.budget);
  if (budget !== undefined) patch.budget = budget;
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
  console.log(`budget      ${budgetLine(settings.budget)}`);
  console.log(`access      ${settings.access === "workspace" ? "agents can edit the workspace" : "read-only"}`);
  console.log(`network     ${settings.network ? "on" : "off"}`);
  console.log(`autocommit  ${settings.autoCommit ? "on (checkpoint commit after each run)" : "off"}`);
  console.log(`turn limit  ${Math.round(settings.turnTimeoutMs / 60_000)} min`);
  console.log(`doc         ${settings.doc ?? pc.dim("none")}`);
  return 0;
};

/** `--budget 12` → 12, `--budget none` → no limit (null), absent → undefined. */
const budgetOption = (value: string | undefined): number | null | undefined => {
  if (value === undefined) return undefined;
  if (["none", "off", "unlimited"].includes(value.toLowerCase())) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new CliUsageError(`--budget: a whole number from 1 to 100, or none (got ${value})`);
  return n;
};

const budgetLine = (budget: number | null): string =>
  budget === null ? "no limit — a run ends when everyone passes" : `${budget} agent turns per run`;

/** `--doc none` (or an empty value) turns the canonical file off. */
const docOption = (value: string | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.toLowerCase() === "none" ? null : trimmed;
};

const runDoc = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT, { long: "log", takesValue: false }, { long: "diff", takesValue: true }]);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const store = RoomStore.open(roomsDir(), resolveRoom(parsed.options.room ?? parsed.positionals[0]));
  const { state } = store;
  const path = state.settings.doc;
  if (!path) {
    console.log(`this room has no canonical file — agoryx settings --doc README.md`);
    return 1;
  }
  const revisions = state.docRevisions.filter((revision) => revision.path === path);
  const textAt = (seq: number): string | null | undefined => {
    const event = store.events.find((entry) => entry.seq === seq);
    return event?.type === "doc.revised" ? event.text : undefined;
  };
  const label = (id: string) => state.agents.find((agent) => agent.id === id)?.label ?? id;
  const who = (by: string, among?: string[]) =>
    by === "agoryx" ? "(the version the room started from)" : among ? `${among.map(label).join(" or ")} (parallel turns)` : label(by);

  if (parsed.options.log) {
    if (revisions.length === 0) console.log(pc.dim(`${path}: no revisions yet`));
    for (const revision of revisions) {
      const stats = revision.by === "agoryx" ? "" : revision.deleted ? pc.red("deleted") : `${pc.green(`+${revision.added}`)} ${pc.red(`−${revision.removed}`)}`;
      const where = revision.native ? pc.dim(" (in its own session)") : revision.turnId ? pc.dim(" (room turn)") : "";
      console.log(`${pc.dim(`#${String(revision.seq).padEnd(5)}`)} ${localStamp(revision.ts)}  ${who(revision.by, revision.among)}${where}  ${stats}`);
    }
    return 0;
  }

  if (parsed.options.diff) {
    const seq = Number.parseInt(parsed.options.diff.replace(/^#/, ""), 10);
    const index = revisions.findIndex((revision) => revision.seq === seq);
    if (index < 0) {
      console.error(`no revision #${parsed.options.diff} of ${path} — agoryx doc --log lists them`);
      return 1;
    }
    const revision = revisions[index]!;
    const previous = revisions[index - 1];
    const after = textAt(revision.seq);
    const before = previous && !previous.deleted ? textAt(previous.seq) : "";
    console.log(pc.dim(`#${revision.seq} · ${who(revision.by, revision.among)} · ${localStamp(revision.ts)}`));
    if (after === undefined || before === undefined) {
      console.log(pc.dim("too large to keep the text of this revision"));
      return 0;
    }
    const diff = renderDiff(before ?? "", after ?? "", 10_000);
    for (const line of (diff ?? "(no change)").split("\n")) {
      console.log(line.startsWith("+ ") ? pc.green(line) : line.startsWith("- ") ? pc.red(line) : pc.dim(line));
    }
    return 0;
  }

  const now = readDoc(state.workspace, path);
  if (process.stdout.isTTY) {
    const last = revisions.at(-1);
    console.log(pc.dim(`── ${join(state.workspace, path)}${last ? ` · ${revisions.length} revision${revisions.length === 1 ? "" : "s"}, last by ${who(last.by, last.among)}` : ""}`));
  }
  if (!now) {
    console.log(pc.dim(`${path} does not exist yet`));
    return 0;
  }
  process.stdout.write(now.text.endsWith("\n") ? now.text : `${now.text}\n`);
  if (now.truncated) console.error(pc.dim(`… only the first ${now.text.length} characters of ${now.size} bytes shown; read ${join(state.workspace, path)} for the rest`));
  return 0;
};

const colorPatchLine = (line: string): string =>
  line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")
    ? pc.bold(line)
    : line.startsWith("@@")
      ? pc.cyan(line)
      : line.startsWith("+")
        ? pc.green(line)
        : line.startsWith("-")
          ? pc.red(line)
          : line;

const runDiff = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT]);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const store = RoomStore.open(roomsDir(), resolveRoom(parsed.options.room));
  const { state } = store;
  const who = (id: string) => state.agents.find((agent) => agent.id === id)?.label ?? id;
  const when = (turn: { endedAt?: string; startedAt: string }) => {
    const ts = turn.endedAt ?? turn.startedAt;
    return localStamp(ts);
  };
  const [ref, path] = parsed.positionals;

  if (!ref) {
    const changed = state.turns.filter((turn) => turn.changes?.length).reverse();
    if (changed.length === 0) console.log(pc.dim("no turn has changed files yet"));
    for (const turn of changed.slice(0, 20)) {
      const files = turn.changes!.map((change) => `${change.path} ${changeStats(change)}`).join(", ");
      console.log(`${pc.bold(turn.id.padEnd(5))} ${who(turn.agent).padEnd(7)} ${pc.dim(when(turn))}  ${files}`);
    }
    return 0;
  }

  const id = `t${ref.replace(/^t/, "")}`;
  const turn = state.turns.find((entry) => entry.id === id);
  if (!turn) {
    console.error(`no turn ${ref} in ${state.name} — agoryx diff lists the turns that changed files`);
    return 1;
  }
  const result = roomTurnPatch(store, id);
  if (!result) {
    console.log(pc.dim(`${id} (${who(turn.agent)}) changed no files${turn.files?.length ? ` git could diff — it touched ${turn.files.join(", ")}` : ""}`));
    return 0;
  }
  const text = path ? patchSection(result.patch, path) : result.patch;
  if (text === null) {
    console.error(`${id} did not change ${path}`);
    return 1;
  }
  console.log(pc.dim(`${id} · ${who(turn.agent)} · ${when(turn)}`));
  const colored = process.stdout.isTTY ? text.split("\n").map(colorPatchLine).join("\n") : text;
  process.stdout.write(colored.endsWith("\n") ? colored : `${colored}\n`);
  return 0;
};

/** "y" on the terminal; never asked without one (--yes instead). */
const confirmOnTerminal = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
};

const runRevert = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT, { long: "undo", takesValue: false }, { long: "yes", short: "y", takesValue: false }]);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const roomId = resolveRoom(parsed.options.room);
  const store = RoomStore.open(roomsDir(), roomId);
  const { state } = store;
  const [ref] = parsed.positionals;
  const stamp = (seq: number) => {
    const event = store.events.find((entry) => entry.seq === seq);
    return event ? localStamp(event.ts) : "";
  };

  if (!ref && !parsed.options.undo) {
    if (!state.commits.length) {
      // A checkpoint is a git commit: a folder without its own repository never gets one.
      if (workspaceTracking(state.workspace) !== "git") console.log(pc.dim(`no checkpoints in ${state.name}: a checkpoint is a git commit, and ${state.workspace} is not a git repository (git init there, then agoryx settings --autocommit on)`));
      else console.log(pc.dim(`no checkpoints in ${state.name}: they are made after each run while \`agoryx settings --autocommit on\`${state.settings.autoCommit ? " (it is on; none yet)" : ""}`));
    }
    for (const commit of [...state.commits].reverse().slice(0, 20)) {
      console.log(`${pc.bold(commit.sha.slice(0, 7))} ${pc.dim(stamp(commit.seq))}  ${oneLine(commit.subject, 70)} ${pc.dim(`· ${commit.files} file${commit.files === 1 ? "" : "s"}`)}`);
    }
    const undoable = undoableRevert(state);
    for (const revert of state.reverts.slice(-10)) {
      const note = revert.undone !== undefined ? pc.dim(" (undone)") : revert === undoable ? pc.dim(` — agoryx revert --undo ${revert.seq}`) : "";
      console.log(`${pc.magenta("↺")} ${pc.dim(stamp(revert.seq))} ${describeRevert(revert)}${note}`);
    }
    if (state.commits.length) console.log(pc.dim("return the folder to one: agoryx revert SHA (it shows the files and asks first)"));
    return 0;
  }

  let request: RevertRequest;
  if (parsed.options.undo) {
    // Only the room's latest return, and never an undo (that would redo the return).
    const seq = ref ? Number.parseInt(ref, 10) : undoableRevert(state)?.seq;
    if (seq === undefined || !Number.isInteger(seq)) {
      console.error("no return to undo: only the latest return of this room can be undone, and it is an undo or already undone — agoryx revert lists them");
      return 1;
    }
    request = { undoOf: seq };
  } else request = { sha: ref! };

  const info = await findDaemon();
  const local = info ? null : localConnEngine(store);
  try {
    const plan = info ? await daemonClient(info).revertPlan(roomId, request) : { ...planRevert(state, request), busy: local!.revertBusy() };
    if (plan.busy) {
      console.error(`cannot return the folder now: ${plan.busy} (agoryx stop)`);
      return 1;
    }
    if (!plan.changes.length) {
      console.log("the folder already matches it; nothing to change");
      return 0;
    }
    const how = (status: string) => (status === "A" ? pc.green("back   ") : status === "D" ? pc.red("removed") : pc.yellow("changed"));
    console.log(plan.undoOf !== undefined ? `Undo return #${plan.undoOf}: these files go back to how they were before it` : `Return ${state.name}'s folder to ${plan.to.slice(0, 7)} (${oneLine(plan.subject, 60)}):`);
    for (const change of plan.changes.slice(0, 50)) console.log(`  ${how(change.status)} ${change.path} ${pc.dim(changeStats(change))}`);
    if (plan.changes.length > 50) console.log(pc.dim(`  … and ${plan.changes.length - 50} more`));
    if (plan.since?.length) {
      console.log(pc.yellow(`Since that return these changed too, and go back as well: ${plan.since.slice(0, 20).join(", ")}${plan.since.length > 20 ? ` (+${plan.since.length - 20} more)` : ""}`));
    }
    console.log(pc.dim("The folder as it is now is kept first, so this can be undone. Messages and the table stay."));
    if (!parsed.options.yes && !(await confirmOnTerminal("Go ahead? [y/N] "))) {
      console.log(process.stdin.isTTY ? "nothing changed" : "nothing changed (add --yes to do it without a terminal)");
      return process.stdin.isTTY ? 0 : 1;
    }
    const revert = info ? (await daemonClient(info).revert(roomId, request, plan.tree)).revert : local!.revertWorkspace({ ...request, tree: plan.tree }, localActor(store.state));
    console.log(`${describeRevert(revert)}${revert.left?.length ? pc.red(` — could not write back: ${revert.left.join(", ")}`) : ""}`);
    if (revert.undoOf === undefined) console.log(pc.dim(`undo: agoryx revert --undo ${revert.seq}`));
    return 0;
  } catch (error) {
    if (error instanceof RevertError || error instanceof DaemonRequestError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await local?.close();
  }
};

/** The room's engine in this process (no daemon runs); refused while another process drives the room. */
const localConnEngine = (store: RoomStore): RoomEngine => {
  try {
    return openEngine(store);
  } catch (error) {
    if (error instanceof RoomLockedError) throw new Error(`${error.message}. Start the daemon (\`agoryx up -d\`) or stop that process first.`);
    throw error;
  }
};

/** Who acts from this terminal: the human, or the agent whose key or turn this is. */
const localActor = (state: RoomState): Actor | undefined => {
  const agent = localAgent();
  return agent ? actorIn(state, agent) : undefined;
};

const runProfile = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT]);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const ref = parsed.options.room ?? parsed.positionals[0];
  let room: RoomState | null = null;
  if (ref || RoomStore.list(roomsDir()).length > 0) room = RoomStore.open(roomsDir(), resolveRoom(ref)).state;
  const path = profilePath();
  for (const line of describeProfile(path, readProfile(path), room)) console.log(line);
  return 0;
};

/** "1h 05m", "4m 10s", "12s". */
const span = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const windowName = (window: LimitWindow): string =>
  window.id === "five_hour"
    ? "5-hour"
    : window.id === "seven_day"
      ? "weekly"
      : window.id.startsWith("seven_day_")
        ? `weekly ${window.id.slice(10)}`
        : window.minutes
          ? `${window.minutes % 1440 === 0 ? `${window.minutes / 1440}-day` : window.minutes % 60 === 0 ? `${window.minutes / 60}-hour` : `${window.minutes}-min`}`
          : window.id;

/** One subscription's windows as lines: used, reset, and the pace (used against how much of the window has gone). */
const limitLines = (snapshot: LimitSnapshot, now: number): string[] => {
  const who = `${snapshot.kind}${snapshot.account === "default" ? "" : ` (${snapshot.account})`}${snapshot.plan ? ` · ${snapshot.plan}` : ""}`;
  const head = `  ${pc.bold(who)}  ${pc.dim(`updated ${span(now - Date.parse(snapshot.at))} ago`)}${snapshot.limited ? pc.red("  limit reached") : ""}`;
  if (snapshot.windows.length === 0) return [head, "    no windows reported"];
  return [
    head,
    ...snapshot.windows.map((window) => {
      const pace = limitPace(window, now);
      const resets = window.resetsAt ? `resets ${localStamp(window.resetsAt)}` : "reset time unknown";
      const hint =
        pace.state === "ahead"
          ? pc.yellow(`ahead of pace — runs out about ${localStamp(pace.runsOutAt!)}, before the reset`)
          : pace.state === "on-pace"
            ? pc.green("on pace")
            : pace.state === "out"
              ? pc.red("used up")
              : pace.state === "reset"
                ? pc.dim("has reset since")
                : pace.state === "early"
                  ? pc.dim("too early to say")
                  : "";
      return `    ${windowName(window).padEnd(10)} ${`${Math.round(window.usedPercent)}%`.padStart(4)}  ${resets}  ${hint}`;
    }),
  ];
};

/** Claude Code's estimate at API prices, not a charge: on a subscription nothing is billed per turn. */
const money = (totals: UsageTotals): string => (totals.costTurns > 0 ? `≈$${totals.costUsd.toFixed(totals.costUsd < 1 ? 3 : 2)}` : "—");

const runUsage = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, [ROOM_OPT, { long: "json", takesValue: false }]);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const limits = readLimits();
  const ref = parsed.options.room ?? parsed.positionals[0];
  let usage = null;
  if (ref || RoomStore.list(roomsDir()).length > 0) {
    const store = RoomStore.open(roomsDir(), resolveRoom(ref));
    usage = roomUsage(store.state, store.since(0));
  }
  if (parsed.options.json) {
    console.log(JSON.stringify({ limits, usage }, null, 2));
    return 0;
  }
  const now = Date.now();
  console.log(pc.dim("Limits, as the agents' CLIs last reported them:"));
  if (limits.length === 0) console.log("  unknown — none reported yet (they come with an agent's next turn)");
  for (const snapshot of limits) for (const line of limitLines(snapshot, now)) console.log(line);
  const headline = limits.flatMap((snapshot) => headlineWindow(snapshot.windows, now) ?? []);
  if (headline.length === 0 && limits.length > 0) console.log(pc.dim("  (every window reported has reset since)"));
  if (!usage) return 0;

  console.log("");
  console.log(pc.dim(`What the wakes in ${usage.name} cost${usage.from ? ` (${localStamp(usage.from)} – ${localStamp(usage.to!)})` : ""}:`));
  if (usage.total.turns === 0 && usage.agents.every((agent) => agent.wakes === 0)) {
    console.log("  no turns yet");
    return 0;
  }
  const header = ["", "wakes", ...TURN_OUTCOMES, "time", "on passes", "cost", "on passes", "tokens in/out"];
  const rows = usage.agents.map((agent) => [
    agent.label,
    String(agent.wakes) + (agent.running ? ` (${agent.running} running)` : ""),
    ...TURN_OUTCOMES.map((outcome) => String(agent.outcomes[outcome].turns)),
    span(agent.total.ms),
    span(agent.outcomes.passed.ms),
    money(agent.total),
    money(agent.outcomes.passed),
    `${agent.total.inputTokens}/${agent.total.outputTokens}`,
  ]);
  rows.push([
    "all",
    String(usage.agents.reduce((sum, agent) => sum + agent.wakes, 0)),
    ...TURN_OUTCOMES.map((outcome) => String(usage.outcomes[outcome].turns)),
    span(usage.total.ms),
    span(usage.outcomes.passed.ms),
    money(usage.total),
    money(usage.outcomes.passed),
    `${usage.total.inputTokens}/${usage.total.outputTokens}`,
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index]!.length)));
  const line = (cells: string[]) => `  ${cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!))).join("  ")}`;
  console.log(pc.dim(line(header)));
  rows.forEach((row, index) => console.log(index === rows.length - 1 ? pc.bold(line(row)) : line(row)));
  for (const agent of usage.agents) {
    const woken = Object.entries(agent.wokenBy).sort((a, b) => b[1] - a[1]);
    const errors = Object.entries(agent.errors);
    if (woken.length === 0 && errors.length === 0) continue;
    const parts = [
      ...(woken.length ? [`woken by ${woken.map(([by, count]) => `${by} ${count}`).join(", ")}`] : []),
      ...(errors.length ? [`failed: ${errors.map(([kind, count]) => `${kind} ${count}`).join(", ")}`] : []),
    ];
    console.log(pc.dim(`  ${agent.label}: ${parts.join("; ")}`));
  }
  if (usage.total.costTurns > 0) console.log(pc.dim("  ≈$ is Claude Code's estimate at API prices, not a charge: a subscription is not billed per turn."));
  if (usage.agents.some((agent) => agent.kind === "codex")) console.log(pc.dim("  Codex gives no such estimate, only tokens."));
  return 0;
};

// ---------------------------------------------------------------------------
// Phones: pairing and devices
// ---------------------------------------------------------------------------

const runPair = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, []);
  if (parsed.options.help) {
    printAgoraUsage();
    return 0;
  }
  const info = await findDaemon();
  if (!info) {
    console.error("no agoryx daemon is running — start it with `agoryx up --lan` (or --tailscale), then pair");
    return 1;
  }
  let paired;
  try {
    paired = await daemonClient(info).pair();
  } catch (error) {
    if (error instanceof DaemonRequestError && error.status === 409) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const [first, ...rest] = paired.links;
  if (!first) return 1;
  console.log(qrTerminal(first.url, { color: Boolean(process.stdout.isTTY) }));
  console.log("");
  console.log(`Scan it with the phone's camera, or open ${pc.bold(first.base)} on the phone and type the code ${pc.bold(paired.code)}.`);
  for (const link of rest) console.log(pc.dim(`also: ${link.url}`));
  const until = new Date(paired.expiresAt);
  console.log(pc.dim(`The code works once, until ${clock(until.toISOString())}. See paired devices with \`agoryx devices\`.`));
  if (first.kind === "lan") console.log(pc.dim("Plain http on the LAN: notifications need HTTPS (Tailscale serve, `agoryx up --tailscale`)."));
  return 0;
};

const runDevices = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv, []);
  const [sub, id] = parsed.positionals;
  if (parsed.options.help || (sub !== undefined && sub !== "revoke") || (sub === "revoke" && !id)) {
    printAgoraUsage();
    return parsed.options.help ? 0 : 2;
  }
  const info = await findDaemon();
  // Without a daemon the file is read and changed here; with one, it is the daemon's to change.
  const registry = info ? null : new DeviceRegistry();
  if (sub === "revoke") {
    let revoked: DeviceInfo | null = null;
    if (info) {
      try {
        revoked = (await daemonClient(info).revokeDevice(id!)).revoked;
      } catch (error) {
        if (!(error instanceof DaemonRequestError) || error.status !== 404) throw error;
      }
    } else revoked = registry!.revoke(id!);
    if (!revoked) {
      console.error(`no paired device ${id} — \`agoryx devices\` lists them`);
      return 1;
    }
    console.log(`revoked ${deviceLabel(revoked)}: its token no longer opens Agoryx`);
    return 0;
  }
  const devices = info ? (await daemonClient(info).devices()).devices : registry!.list();
  if (devices.length === 0) {
    console.log("no paired devices — `agoryx pair` pairs a phone");
    return 0;
  }
  for (const device of devices) {
    console.log(
      `${pc.bold(device.name || "unknown browser")} ${pc.dim(device.id)}  ${pc.dim(`paired ${localStamp(device.createdAt)} · last seen ${localStamp(device.lastSeen)}${device.push ? " · notifications on" : ""}`)}`,
    );
  }
  console.log(pc.dim("revoke one with `agoryx devices revoke ID`"));
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
    case "doc":
      return runDoc(argv);
    case "diff":
      return runDiff(argv);
    case "revert":
      return runRevert(argv);
    case "profile":
      return runProfile(argv);
    case "usage":
      return runUsage(argv);
    case "pair":
      return runPair(argv);
    case "devices":
      return runDevices(argv);
    default:
      throw new CliUsageError(`unknown room command '${command}'`, printAgoraUsage);
  }
};

export type { DaemonStreamItem };
