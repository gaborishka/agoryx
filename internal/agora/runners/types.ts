import { createHash } from "node:crypto";
import type { Activity, AgentKind, RoomSettings, TurnError, TurnUsage } from "../types.js";

export interface TurnRequest {
  prompt: string;
  cwd: string;
  /** Native session to resume; null starts a fresh session. */
  sessionId: string | null;
  roomName: string;
  model?: string;
  effort?: string;
  settings: RoomSettings;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface TurnCallbacks {
  /** Native session id became known (fresh session or confirmation on resume). */
  onSession: (sessionId: string) => void;
  /** Live text of the agent's current message. reset=true starts a new message buffer. */
  onText: (text: string, reset?: boolean) => void;
  onActivity: (activity: Activity) => void;
}

export interface TurnResult {
  status: "ok" | "error" | "interrupted";
  text: string;
  sessionId: string | null;
  usage?: TurnUsage;
  error?: TurnError;
  /** Images the agent generated this turn, as absolute paths outside the workspace (Codex image_gen). */
  images?: string[];
  /** Live processes only: the process could not take the turn at all, so it can be run again some other way. */
  liveUnavailable?: boolean;
}

/**
 * A CLI process that stays up between the turns of one agent in a room, so a turn does not pay for its
 * start (Claude: hooks, plugins, MCP — seconds). Everything that cannot change once it runs is in its
 * `fingerprint`; the engine starts a new one when the fingerprint, or the session it serves, differs.
 */
export interface LiveProcess {
  /** Hash of everything fixed at start: binary, model, effort, sandbox settings, cwd, environment. */
  readonly fingerprint: string;
  /** The native session this process serves (null until the CLI has reported it). */
  readonly sessionId: string | null;
  /** False once the process has exited or been closed. */
  readonly alive: boolean;
  /**
   * One turn on this process. It settles with a result of the same shape as `AgentRunner.run`; a result
   * with `liveUnavailable` means the process could not take the turn at all (it did not start, or died
   * before the turn began), so the same turn may safely be run again some other way.
   */
  runTurn(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult>;
  /** Take the process (and anything it started) down. Safe to call twice. */
  close(): void;
}

export interface AgentRunner {
  kind: AgentKind;
  run(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult>;
  /** Hash of what a live process for this request would be fixed to; without `openLive`, none. */
  liveFingerprint?(request: TurnRequest): string;
  /** Start a process that will serve many turns (see LiveProcess). Nothing is sent until `runTurn`. */
  openLive?(request: TurnRequest): LiveProcess;
  /**
   * Shell command a human can use to open this agent's native session. With the agent's model:
   * two agents of one kind can differ only by it, and a resumed session would otherwise talk to the CLI's default.
   */
  resumeCommand(sessionId: string, cwd: string, model?: string, effort?: string): string;
}

export const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export const truncate = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A stable hash of any JSON-able value (object keys sorted), for LiveProcess fingerprints. */
export const fingerprintOf = (value: unknown): string => {
  const canon = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canon)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .filter(([, entry]) => entry !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canon(entry)]),
          )
        : input;
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex").slice(0, 24);
};
