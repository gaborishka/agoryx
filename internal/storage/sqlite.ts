import Database from "better-sqlite3";
import type {
  Checkpoint,
  EventEnvelope,
  Message,
  PinnedContext,
  Room,
  RoomConfig,
  TeamCheck,
  TeamRun,
  TeamRunStage,
  TeamRunStatus,
  TeamStep,
  TeamStrategy,
  TeamFeedback,
} from "../events/types.js";
import { createId, nowIso } from "../session/ids.js";

interface RoomRow {
  id: string;
  name: string;
  participants_json: string;
  mode: string;
  checkpoint_threshold: number;
  max_history_messages: number;
  max_context_tokens: number;
  created_at: string;
}

interface MessageRow {
  id: string;
  room_id: string;
  author: string;
  role: Message["role"];
  text: string;
  format: Message["format"];
  metadata_json: string;
  created_at: string;
}

interface CheckpointCoverageRow {
  from_message_id: string;
  to_message_id: string;
}

interface CheckpointRow {
  id: string;
  room_id: string;
  summary_text: string;
  from_message_id: string;
  to_message_id: string;
  created_at: string;
}

interface PinnedContextRow {
  id: string;
  room_id: string;
  label: string;
  content: string;
  pinned_by: string;
  created_at: string;
}

interface SessionRunRow {
  id: string;
  room_id: string;
  created_at: string;
}

export interface AgentSession {
  id: string;
  roomId: string;
  agentName: string;
  nativeSessionId: string | null;
  transportMode: "resume" | "interactive";
  status: "active" | "expired" | "failed";
  lastSeenSeq: number | null;
  failCount: number;
  createdAt: number;
  lastTurnAt: number | null;
}

export interface CreateTeamRunInput {
  roomId: string;
  strategy: TeamStrategy;
  stage: TeamRunStage;
  goal: string;
  participants: string[];
  maxSteps: number;
  maxNoProgressSteps: number;
  maxDurationMs: number;
  checksEnabled: boolean;
  createdBy: string;
}

export interface CreateTeamStepInput {
  runId: string;
  seq: number;
  stage: TeamRunStage;
  actor: string;
  dispatchId: string;
  requestId: string;
  inputText: string;
  outputText: string;
  result: TeamStep["result"];
  errorClass?: TeamStep["errorClass"];
}

export interface CreateTeamCheckInput {
  runId: string;
  stepId?: string | null;
  command: string;
  status: TeamCheck["status"];
  exitCode?: number | null;
  stdoutText?: string;
  stderrText?: string;
  durationMs?: number;
}

interface AgentSessionRow {
  id: string;
  room_id: string;
  agent_name: string;
  native_session_id: string | null;
  transport_mode: string;
  status: string;
  last_seen_seq: number | null;
  fail_count: number;
  created_at: number;
  last_turn_at: number | null;
}

interface TeamRunRow {
  id: string;
  room_id: string;
  strategy: TeamStrategy;
  status: TeamRunStatus;
  stage: TeamRunStage;
  goal: string;
  participants_json: string;
  step_count: number;
  no_progress_count: number;
  max_steps: number;
  max_no_progress_steps: number;
  max_duration_ms: number;
  checks_enabled: number;
  created_by: string;
  created_at: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  final_summary: string | null;
}

interface TeamStepRow {
  id: string;
  run_id: string;
  seq: number;
  stage: TeamRunStage;
  actor: string;
  dispatch_id: string;
  request_id: string;
  input_text: string;
  output_text: string;
  result: TeamStep["result"];
  error_class: string | null;
  created_at: string;
}

interface TeamFeedbackRow {
  id: string;
  run_id: string;
  message_id: string;
  feedback_text: string;
  status: TeamFeedback["status"];
  created_at: string;
  consumed_at: string | null;
}

interface TeamCheckRow {
  id: string;
  run_id: string;
  step_id: string | null;
  command: string;
  status: TeamCheck["status"];
  exit_code: number | null;
  stdout_text: string;
  stderr_text: string;
  duration_ms: number;
  created_at: string;
}

export interface MemorySnapshot {
  roomId: string;
  currentGoal: string;
  activeBranch: string;
  activeWorktrees: unknown[];
  keyDecisions: string[];
  blockers: string[];
  nextActions: string[];
  taskStatus: Record<string, string>;
  lastLogId: number;
  reducerVersion: number;
  updatedAt: string;
}

export interface UpsertSnapshotInput {
  currentGoal: string;
  activeBranch: string;
  activeWorktrees: unknown[];
  keyDecisions: string[];
  blockers: string[];
  nextActions: string[];
  taskStatus: Record<string, string>;
  lastLogId: number;
  reducerVersion: number;
}

export interface MemoryLogEntry {
  id: number;
  eventId: string;
  roomId: string;
  timestamp: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface AppendMemoryEventInput {
  eventId: string;
  roomId: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface MemoryLogFilter {
  eventType?: string;
  source?: string;
  since?: string;
  limit?: number;
}

export class SQLiteStore {
  private readonly db: Database.Database;

  public constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
  }

  public init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        mode TEXT NOT NULL,
        checkpoint_threshold INTEGER NOT NULL,
        max_history_messages INTEGER NOT NULL,
        max_context_tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_runs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        author TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        format TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room_created
      ON messages(room_id, created_at);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id)
      );

      CREATE TABLE IF NOT EXISTS pinned_context (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        label TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(room_id) REFERENCES rooms(id)
      );

      CREATE TABLE IF NOT EXISTS events_log (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_room_ts
      ON events_log(room_id, timestamp);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        native_session_id TEXT,
        transport_mode TEXT NOT NULL DEFAULT 'resume'
          CHECK(transport_mode IN ('resume', 'interactive')),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'expired', 'failed')),
        last_seen_seq INTEGER,
        fail_count INTEGER NOT NULL DEFAULT 0
          CHECK(fail_count >= 0),
        created_at INTEGER NOT NULL,
        last_turn_at INTEGER,
        FOREIGN KEY(room_id) REFERENCES rooms(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_active
        ON agent_sessions(room_id, agent_name)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS team_runs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        strategy TEXT NOT NULL
          CHECK(strategy IN ('debate', 'pipeline')),
        status TEXT NOT NULL
          CHECK(status IN ('active', 'waiting_user_input', 'done', 'failed', 'stopped')),
        stage TEXT NOT NULL
          CHECK(stage IN ('debate', 'plan', 'implement', 'checks', 'finalize')),
        goal TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        step_count INTEGER NOT NULL DEFAULT 0,
        no_progress_count INTEGER NOT NULL DEFAULT 0,
        max_steps INTEGER NOT NULL,
        max_no_progress_steps INTEGER NOT NULL,
        max_duration_ms INTEGER NOT NULL,
        checks_enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        final_summary TEXT,
        FOREIGN KEY(room_id) REFERENCES rooms(id)
      );

      CREATE TABLE IF NOT EXISTS team_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        stage TEXT NOT NULL
          CHECK(stage IN ('debate', 'plan', 'implement', 'checks', 'finalize')),
        actor TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        input_text TEXT NOT NULL,
        output_text TEXT NOT NULL,
        result TEXT NOT NULL
          CHECK(result IN ('ok', 'error', 'stopped')),
        error_class TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES team_runs(id)
      );

      CREATE TABLE IF NOT EXISTS team_feedback_queue (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        feedback_text TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('pending', 'consumed')),
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY(run_id) REFERENCES team_runs(id)
      );

      CREATE TABLE IF NOT EXISTS team_checks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        command TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('passed', 'failed', 'timeout', 'skipped')),
        exit_code INTEGER,
        stdout_text TEXT NOT NULL,
        stderr_text TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES team_runs(id),
        FOREIGN KEY(step_id) REFERENCES team_steps(id)
      );

      CREATE INDEX IF NOT EXISTS idx_team_runs_room_status_updated
      ON team_runs(room_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_team_steps_run_seq
      ON team_steps(run_id, seq ASC);

      CREATE INDEX IF NOT EXISTS idx_team_feedback_run_status
      ON team_feedback_queue(run_id, status, created_at ASC);

      DROP INDEX IF EXISTS idx_team_runs_single_active;

      CREATE TABLE IF NOT EXISTS memory_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL REFERENCES rooms(id),
        timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        source TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN (
          'dispatch_start', 'dispatch_end', 'team_step', 'error',
          'decision', 'note', 'cancel', 'retry', 'merge_attempt',
          'worktree_create', 'worktree_remove'
        )),
        payload TEXT NOT NULL CHECK(json_valid(payload))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_log_room
      ON memory_log(room_id, id);

      CREATE TABLE IF NOT EXISTS memory_snapshot (
        room_id TEXT PRIMARY KEY REFERENCES rooms(id),
        current_goal TEXT NOT NULL DEFAULT '',
        active_branch TEXT NOT NULL DEFAULT '',
        active_worktrees TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(active_worktrees)),
        key_decisions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(key_decisions)),
        blockers TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(blockers)),
        next_actions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(next_actions)),
        task_status TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(task_status)),
        last_log_id INTEGER NOT NULL DEFAULT 0,
        reducer_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
  }

  public createRoom(
    name: string,
    participants: string[],
    config: RoomConfig,
  ): Room {
    const room: Room = {
      id: createId("room"),
      name,
      participants,
      config,
      createdAt: nowIso(),
    };

    this.db
      .prepare(
        `
        INSERT INTO rooms (
          id, name, participants_json, mode,
          checkpoint_threshold, max_history_messages, max_context_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        room.id,
        room.name,
        JSON.stringify(room.participants),
        room.config.mode,
        room.config.checkpointThreshold,
        room.config.maxHistoryMessages,
        room.config.maxContextTokens,
        room.createdAt,
      );

    return room;
  }

  public createSessionRun(roomId: string): string {
    const sessionId = createId("sess");
    this.db
      .prepare(`INSERT INTO session_runs (id, room_id, created_at) VALUES (?, ?, ?)`)
      .run(sessionId, roomId, nowIso());
    return sessionId;
  }

  public listSessionRuns(
    limit = 20,
  ): Array<{ id: string; roomId: string; roomName: string; createdAt: string }> {
    const rows = this.db
      .prepare(
        `
      SELECT s.id, s.room_id, s.created_at, r.name AS room_name
      FROM session_runs s
      JOIN rooms r ON r.id = s.room_id
      ORDER BY s.created_at DESC
      LIMIT ?
    `,
      )
      .all(limit) as Array<{
      id: string;
      room_id: string;
      room_name: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      roomName: row.room_name,
      createdAt: row.created_at,
    }));
  }

  public resolveRoomId(targetId: string): string | null {
    const existingRoom = this.getRoom(targetId);
    if (existingRoom) {
      return existingRoom.id;
    }

    const row = this.db
      .prepare(`SELECT room_id FROM session_runs WHERE id = ?`)
      .get(targetId) as { room_id: string } | undefined;

    return row?.room_id ?? null;
  }

  public listRoomSummaries(limit = 20): Array<{ id: string; name: string; createdAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, name, created_at FROM rooms ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; name: string; created_at: string }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
    }));
  }

  public getRoom(roomId: string): Room | null {
    const row = this.db
      .prepare(`SELECT * FROM rooms WHERE id = ?`)
      .get(roomId) as RoomRow | undefined;
    if (!row) {
      return null;
    }
    return roomRowToDomain(row);
  }

  public updateRoomMode(roomId: string, mode: RoomConfig["mode"]): void {
    this.db.prepare(`UPDATE rooms SET mode = ? WHERE id = ?`).run(mode, roomId);
  }

  public saveMessage(message: Message): void {
    this.db
      .prepare(
        `
      INSERT INTO messages (
        id, room_id, author, role, text, format, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        message.id,
        message.roomId,
        message.author,
        message.role,
        message.text,
        message.format,
        JSON.stringify(message.metadata),
        message.createdAt,
      );
  }

  public listMessages(roomId: string, limit = 250): Message[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM messages
      WHERE room_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `,
      )
      .all(roomId, limit) as MessageRow[];

    return rows.map(messageRowToDomain);
  }

  public listRecentMessages(roomId: string, limit = 250): Message[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM (
        SELECT *, rowid AS _rid FROM messages
        WHERE room_id = ?
        ORDER BY rowid DESC
        LIMIT ?
      ) sub
      ORDER BY _rid ASC
    `,
      )
      .all(roomId, limit) as (MessageRow & { _rid: number })[];

    return rows.map(messageRowToDomain);
  }

  public listRecentMessagesByRoles(
    roomId: string,
    roles: Message["role"][],
    limit = 250,
  ): Message[] {
    if (roles.length === 0 || limit <= 0) {
      return [];
    }

    const placeholders = roles.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `
      SELECT * FROM (
        SELECT *, rowid AS _rid FROM messages
        WHERE room_id = ?
          AND role IN (${placeholders})
        ORDER BY rowid DESC
        LIMIT ?
      ) sub
      ORDER BY _rid ASC
    `,
      )
      .all(roomId, ...roles, limit) as (MessageRow & { _rid: number })[];

    return rows.map(messageRowToDomain);
  }

  public countMessages(roomId: string, roles?: string[]): number {
    if (roles && roles.length > 0) {
      const placeholders = roles.map(() => "?").join(",");
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM messages WHERE room_id = ? AND role IN (${placeholders})`,
        )
        .get(roomId, ...roles) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE room_id = ?`)
      .get(roomId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  public listMessagesAfter(roomId: string, afterMessageId: string): Message[] {
    const rows = this.db
      .prepare(
        `
      SELECT m.*
      FROM messages m
      JOIN messages anchor
        ON anchor.room_id = m.room_id
       AND anchor.id = ?
      WHERE m.room_id = ?
        AND m.rowid > anchor.rowid
      ORDER BY m.rowid ASC
    `,
      )
      .all(afterMessageId, roomId) as MessageRow[];

    return rows.map(messageRowToDomain);
  }

  public getMaxMessageSeq(roomId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(rowid) AS max_seq FROM messages WHERE room_id = ?`)
      .get(roomId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? null;
  }

  public listMessagesDelta(
    roomId: string,
    afterSeq: number,
    cutoffSeq: number,
    excludeAuthor: string,
  ): Message[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM messages
      WHERE room_id = ?
        AND rowid > ?
        AND rowid <= ?
        AND author != ?
      ORDER BY rowid ASC
    `,
      )
      .all(roomId, afterSeq, cutoffSeq, excludeAuthor) as MessageRow[];
    return rows.map(messageRowToDomain);
  }

  public addPinnedContext(
    roomId: string,
    label: string,
    content: string,
    pinnedBy: string,
  ): PinnedContext {
    const pinned: PinnedContext = {
      id: createId("pin"),
      roomId,
      label,
      content,
      pinnedBy,
      createdAt: nowIso(),
    };

    this.db
      .prepare(
        `
      INSERT INTO pinned_context (id, room_id, label, content, pinned_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        pinned.id,
        pinned.roomId,
        pinned.label,
        pinned.content,
        pinned.pinnedBy,
        pinned.createdAt,
      );

    return pinned;
  }

  public listPinnedContext(roomId: string): PinnedContext[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pinned_context WHERE room_id = ? ORDER BY created_at ASC`,
      )
      .all(roomId) as PinnedContextRow[];

    return rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      label: row.label,
      content: row.content,
      pinnedBy: row.pinned_by,
      createdAt: row.created_at,
    }));
  }

  public removePinnedContext(roomId: string, pinId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM pinned_context WHERE room_id = ? AND id = ?`)
      .run(roomId, pinId);
    return result.changes > 0;
  }

  public saveCheckpoint(
    roomId: string,
    summaryText: string,
    fromMessageId: string,
    toMessageId: string,
  ): Checkpoint {
    const checkpoint: Checkpoint = {
      id: createId("chk"),
      roomId,
      summaryText,
      fromMessageId,
      toMessageId,
      createdAt: nowIso(),
    };

    this.db
      .prepare(
        `
      INSERT INTO checkpoints (
        id, room_id, summary_text, from_message_id, to_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        checkpoint.id,
        checkpoint.roomId,
        checkpoint.summaryText,
        checkpoint.fromMessageId,
        checkpoint.toMessageId,
        checkpoint.createdAt,
      );

    return checkpoint;
  }

  public getLatestCheckpoint(roomId: string): Checkpoint | null {
    const row = this.db
      .prepare(
        `SELECT * FROM checkpoints WHERE room_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(roomId) as CheckpointRow | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      roomId: row.room_id,
      summaryText: row.summary_text,
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      createdAt: row.created_at,
    };
  }

  public getCheckpointCoverage(
    roomId: string,
  ): { fromMessageId: string; toMessageId: string } | null {
    const row = this.db
      .prepare(
        `
      SELECT from_message_id, to_message_id
      FROM checkpoints
      WHERE room_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(roomId) as CheckpointCoverageRow | undefined;

    if (!row) {
      return null;
    }

    return {
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
    };
  }

  public appendEvent(event: EventEnvelope): void {
    this.db
      .prepare(
        `
      INSERT INTO events_log (
        event_id, room_id, session_id, timestamp, source, type, request_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        event.eventId,
        event.roomId,
        event.sessionId,
        event.timestamp,
        event.source,
        event.type,
        event.requestId,
        JSON.stringify(event.payload),
      );
  }

  public getLastFailedRequest(roomId: string, adapterName: string): string | null {
    const source = `adapter.${adapterName}`;
    const failedRow = this.db
      .prepare(
        `
      SELECT row_id, request_id FROM events_log
      WHERE room_id = ? AND source = ? AND type = 'message.error'
      ORDER BY row_id DESC LIMIT 1
    `,
      )
      .get(roomId, source) as { row_id: number; request_id: string } | undefined;
    if (!failedRow) {
      return null;
    }

    const recoveredRow = this.db
      .prepare(
        `
      SELECT row_id FROM events_log
      WHERE room_id = ? AND source = ? AND type = 'message.completed' AND row_id > ?
      ORDER BY row_id DESC LIMIT 1
    `,
      )
      .get(roomId, source, failedRow.row_id) as { row_id: number } | undefined;

    return recoveredRow ? null : failedRow.request_id;
  }

  public createAgentSession(roomId: string, agentName: string): AgentSession {
    const id = createId("agtsess");
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO agent_sessions (id, room_id, agent_name, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(id, roomId, agentName, now);
    const session = this.getAgentSessionById(id);
    if (!session) {
      throw new Error(`Failed to create agent session: read-back for id=${id} returned null`);
    }
    return session;
  }

  public getActiveAgentSession(roomId: string, agentName: string): AgentSession | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM agent_sessions
      WHERE room_id = ? AND agent_name = ? AND status = 'active'
    `,
      )
      .get(roomId, agentName) as AgentSessionRow | undefined;
    return row ? agentSessionRowToDomain(row) : null;
  }

  public listActiveAgentSessions(roomId: string): AgentSession[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM agent_sessions
      WHERE room_id = ? AND status = 'active'
      ORDER BY COALESCE(last_turn_at, created_at) DESC, created_at DESC
    `,
      )
      .all(roomId) as AgentSessionRow[];
    return rows.map(agentSessionRowToDomain);
  }

  public updateAgentSessionNativeId(id: string, nativeId: string): void {
    if (!nativeId) {
      return;
    }
    this.db
      .prepare(
        `
      UPDATE agent_sessions
      SET native_session_id = ?,
          last_turn_at = ?
      WHERE id = ?
    `,
      )
      .run(nativeId, Date.now(), id);
  }

  public updateAgentSessionCursor(id: string, seq: number): void {
    this.db
      .prepare(
        `
      UPDATE agent_sessions
      SET last_seen_seq = CASE
          WHEN last_seen_seq IS NULL THEN ?
          WHEN ? > last_seen_seq THEN ?
          ELSE last_seen_seq
        END,
        last_turn_at = ?
      WHERE id = ?
    `,
      )
      .run(seq, seq, seq, Date.now(), id);
  }

  public updateAgentSessionStatus(
    id: string,
    status: AgentSession["status"],
  ): void {
    this.db
      .prepare(`UPDATE agent_sessions SET status = ? WHERE id = ?`)
      .run(status, id);
  }

  public incrementAgentSessionFailCount(id: string): number {
    this.db
      .prepare(
        `
      UPDATE agent_sessions
      SET fail_count = fail_count + 1
      WHERE id = ?
    `,
      )
      .run(id);
    const row = this.db
      .prepare(`SELECT fail_count FROM agent_sessions WHERE id = ?`)
      .get(id) as { fail_count: number } | undefined;
    return row?.fail_count ?? 0;
  }

  public createTeamRun(input: CreateTeamRunInput): TeamRun {
    const now = nowIso();
    const id = createId("teamrun");
    this.db
      .prepare(
        `
      INSERT INTO team_runs (
        id, room_id, strategy, status, stage, goal, participants_json,
        step_count, no_progress_count, max_steps, max_no_progress_steps, max_duration_ms,
        checks_enabled, created_by, created_at, started_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.roomId,
        input.strategy,
        input.stage,
        input.goal,
        JSON.stringify(input.participants),
        input.maxSteps,
        input.maxNoProgressSteps,
        input.maxDurationMs,
        input.checksEnabled ? 1 : 0,
        input.createdBy,
        now,
        now,
        now,
      );

    const run = this.getTeamRun(id);
    if (!run) {
      throw new Error(`Failed to create team run: read-back for id=${id} returned null`);
    }
    return run;
  }

  public getTeamRun(runId: string): TeamRun | null {
    const row = this.db
      .prepare(`SELECT * FROM team_runs WHERE id = ?`)
      .get(runId) as TeamRunRow | undefined;
    return row ? teamRunRowToDomain(row) : null;
  }

  public getActiveTeamRun(roomId: string): TeamRun | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM team_runs
      WHERE room_id = ?
        AND status IN ('active', 'waiting_user_input')
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      )
      .get(roomId) as TeamRunRow | undefined;
    return row ? teamRunRowToDomain(row) : null;
  }

  public getLatestResumableTeamRun(roomId: string): TeamRun | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM team_runs
      WHERE room_id = ?
        AND status IN ('active', 'waiting_user_input')
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      )
      .get(roomId) as TeamRunRow | undefined;
    return row ? teamRunRowToDomain(row) : null;
  }

  public updateTeamRunStatus(
    runId: string,
    status: TeamRunStatus,
    options: { stage?: TeamRunStage; finalSummary?: string | null; completedAt?: string | null } = {},
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `
      UPDATE team_runs
      SET status = ?,
          stage = COALESCE(?, stage),
          final_summary = CASE
            WHEN ? IS NOT NULL THEN ?
            ELSE final_summary
          END,
          completed_at = COALESCE(?, completed_at),
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        status,
        options.stage ?? null,
        options.finalSummary ?? null,
        options.finalSummary ?? null,
        options.completedAt ?? null,
        now,
        runId,
      );
  }

  public updateTeamRunProgress(
    runId: string,
    updates: {
      stage?: TeamRunStage;
      stepCount?: number;
      noProgressCount?: number;
      finalSummary?: string | null;
    },
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `
      UPDATE team_runs
      SET stage = COALESCE(?, stage),
          step_count = COALESCE(?, step_count),
          no_progress_count = COALESCE(?, no_progress_count),
          final_summary = CASE
            WHEN ? IS NOT NULL THEN ?
            ELSE final_summary
          END,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        updates.stage ?? null,
        updates.stepCount ?? null,
        updates.noProgressCount ?? null,
        updates.finalSummary ?? null,
        updates.finalSummary ?? null,
        now,
        runId,
      );
  }

  public addTeamStep(input: CreateTeamStepInput): TeamStep {
    const id = createId("teamstep");
    const createdAt = nowIso();
    this.db
      .prepare(
        `
      INSERT INTO team_steps (
        id, run_id, seq, stage, actor, dispatch_id, request_id,
        input_text, output_text, result, error_class, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.runId,
        input.seq,
        input.stage,
        input.actor,
        input.dispatchId,
        input.requestId,
        input.inputText,
        input.outputText,
        input.result,
        input.errorClass ?? null,
        createdAt,
      );

    const row = this.db
      .prepare(`SELECT * FROM team_steps WHERE id = ?`)
      .get(id) as TeamStepRow | undefined;
    if (!row) {
      throw new Error(`Failed to create team step: read-back for id=${id} returned null`);
    }
    return teamStepRowToDomain(row);
  }

  public listTeamSteps(runId: string, limit = 50): TeamStep[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM team_steps
      WHERE run_id = ?
      ORDER BY seq DESC
      LIMIT ?
    `,
      )
      .all(runId, limit) as TeamStepRow[];

    return rows.reverse().map(teamStepRowToDomain);
  }

  public enqueueTeamFeedback(
    runId: string,
    messageId: string,
    feedbackText: string,
  ): TeamFeedback {
    const id = createId("teamfb");
    const createdAt = nowIso();
    this.db
      .prepare(
        `
      INSERT INTO team_feedback_queue (
        id, run_id, message_id, feedback_text, status, created_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)
    `,
      )
      .run(id, runId, messageId, feedbackText, createdAt);

    const row = this.db
      .prepare(`SELECT * FROM team_feedback_queue WHERE id = ?`)
      .get(id) as TeamFeedbackRow | undefined;
    if (!row) {
      throw new Error(`Failed to enqueue team feedback: read-back for id=${id} returned null`);
    }
    return teamFeedbackRowToDomain(row);
  }

  public listPendingTeamFeedback(runId: string, limit = 20): TeamFeedback[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM team_feedback_queue
      WHERE run_id = ?
        AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `,
      )
      .all(runId, limit) as TeamFeedbackRow[];
    return rows.map(teamFeedbackRowToDomain);
  }

  public countPendingTeamFeedback(runId: string): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS cnt FROM team_feedback_queue
      WHERE run_id = ? AND status = 'pending'
    `,
      )
      .get(runId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  public consumeTeamFeedback(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const now = nowIso();
    this.db
      .prepare(
        `
      UPDATE team_feedback_queue
      SET status = 'consumed',
          consumed_at = ?
      WHERE id IN (${placeholders})
    `,
      )
      .run(now, ...ids);
  }

  public addTeamCheck(input: CreateTeamCheckInput): TeamCheck {
    const id = createId("teamchk");
    const createdAt = nowIso();
    this.db
      .prepare(
        `
      INSERT INTO team_checks (
        id, run_id, step_id, command, status, exit_code, stdout_text, stderr_text, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.runId,
        input.stepId ?? null,
        input.command,
        input.status,
        input.exitCode ?? null,
        input.stdoutText ?? "",
        input.stderrText ?? "",
        input.durationMs ?? 0,
        createdAt,
      );

    const row = this.db
      .prepare(`SELECT * FROM team_checks WHERE id = ?`)
      .get(id) as TeamCheckRow | undefined;
    if (!row) {
      throw new Error(`Failed to add team check: read-back for id=${id} returned null`);
    }
    return teamCheckRowToDomain(row);
  }

  public listTeamChecks(runId: string, limit = 20): TeamCheck[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM team_checks
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(runId, limit) as TeamCheckRow[];
    return rows.reverse().map(teamCheckRowToDomain);
  }

  public getMemorySnapshot(roomId: string): MemorySnapshot | null {
    const row = this.db.prepare(
      "SELECT * FROM memory_snapshot WHERE room_id = ?"
    ).get(roomId) as any;
    if (!row) return null;
    return snapshotRowToDomain(row);
  }

  public upsertMemorySnapshot(roomId: string, input: UpsertSnapshotInput): MemorySnapshot {
    const existing = this.getMemorySnapshot(roomId);
    if (existing && input.lastLogId < existing.lastLogId) {
      throw new Error(`Monotonic violation: new lastLogId ${input.lastLogId} < current ${existing.lastLogId}`);
    }
    this.db.prepare(`
      INSERT INTO memory_snapshot (room_id, current_goal, active_branch, active_worktrees,
        key_decisions, blockers, next_actions, task_status, last_log_id, reducer_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        current_goal = excluded.current_goal,
        active_branch = excluded.active_branch,
        active_worktrees = excluded.active_worktrees,
        key_decisions = excluded.key_decisions,
        blockers = excluded.blockers,
        next_actions = excluded.next_actions,
        task_status = excluded.task_status,
        last_log_id = excluded.last_log_id,
        reducer_version = excluded.reducer_version,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(
      roomId, input.currentGoal, input.activeBranch,
      JSON.stringify(input.activeWorktrees), JSON.stringify(input.keyDecisions),
      JSON.stringify(input.blockers), JSON.stringify(input.nextActions),
      JSON.stringify(input.taskStatus), input.lastLogId, input.reducerVersion,
    );
    return this.getMemorySnapshot(roomId)!;
  }

  public deleteMemorySnapshot(roomId: string): void {
    this.db.prepare("DELETE FROM memory_snapshot WHERE room_id = ?").run(roomId);
  }

  public appendMemoryEvent(input: AppendMemoryEventInput): MemoryLogEntry | null {
    const stmt = this.db.prepare(`
      INSERT INTO memory_log (event_id, room_id, source, event_type, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);
    const result = stmt.run(
      input.eventId, input.roomId, input.source,
      input.eventType, JSON.stringify(input.payload),
    );
    if (result.changes === 0) return null;
    return this.getMemoryLogEntry(result.lastInsertRowid as number);
  }

  private getMemoryLogEntry(id: number): MemoryLogEntry {
    const row = this.db.prepare("SELECT * FROM memory_log WHERE id = ?").get(id) as any;
    return memoryRowToEntry(row);
  }

  public listMemoryEvents(roomId: string, filter?: MemoryLogFilter): MemoryLogEntry[] {
    let sql = "SELECT * FROM memory_log WHERE room_id = ?";
    const params: unknown[] = [roomId];
    if (filter?.eventType) { sql += " AND event_type = ?"; params.push(filter.eventType); }
    if (filter?.source) { sql += " AND source = ?"; params.push(filter.source); }
    if (filter?.since) { sql += " AND timestamp >= ?"; params.push(filter.since); }
    sql += " ORDER BY id ASC";
    if (filter?.limit != null) { sql += " LIMIT ?"; params.push(filter.limit); }
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(memoryRowToEntry);
  }

  public listMemoryEventsAfter(roomId: string, afterId: number): MemoryLogEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM memory_log WHERE room_id = ? AND id > ? ORDER BY id ASC"
    ).all(roomId, afterId) as any[];
    return rows.map(memoryRowToEntry);
  }

  public getMaxMemoryLogId(roomId: string): number | null {
    const row = this.db.prepare(
      "SELECT MAX(id) as max_id FROM memory_log WHERE room_id = ?"
    ).get(roomId) as any;
    return row?.max_id ?? null;
  }

  private getAgentSessionById(id: string): AgentSession | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE id = ?`)
      .get(id) as AgentSessionRow | undefined;
    return row ? agentSessionRowToDomain(row) : null;
  }

  public close(): void {
    this.db.close();
  }
}

const roomRowToDomain = (row: RoomRow): Room => ({
  id: row.id,
  name: row.name,
  participants: tryParseJson<string[]>(row.participants_json, []),
  config: {
    mode: row.mode as RoomConfig["mode"],
    checkpointThreshold: row.checkpoint_threshold,
    maxHistoryMessages: row.max_history_messages,
    maxContextTokens: row.max_context_tokens,
  },
  createdAt: row.created_at,
});

const tryParseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch (error: unknown) {
    console.error(
      `[storage] Failed to parse JSON column: ${
        error instanceof Error ? error.message : String(error)
      } — value preview: ${value.slice(0, 100)}`,
    );
    return fallback;
  }
};

const messageRowToDomain = (row: MessageRow): Message => ({
  id: row.id,
  roomId: row.room_id,
  author: row.author,
  role: row.role,
  text: row.text,
  format: row.format,
  metadata: tryParseJson(row.metadata_json, {}),
  createdAt: row.created_at,
});

const agentSessionRowToDomain = (row: AgentSessionRow): AgentSession => ({
  id: row.id,
  roomId: row.room_id,
  agentName: row.agent_name,
  nativeSessionId: row.native_session_id,
  transportMode: row.transport_mode as AgentSession["transportMode"],
  status: row.status as AgentSession["status"],
  lastSeenSeq: row.last_seen_seq,
  failCount: row.fail_count,
  createdAt: row.created_at,
  lastTurnAt: row.last_turn_at,
});

const teamRunRowToDomain = (row: TeamRunRow): TeamRun => ({
  id: row.id,
  roomId: row.room_id,
  strategy: row.strategy,
  status: row.status,
  stage: row.stage,
  goal: row.goal,
  participants: tryParseJson<string[]>(row.participants_json, []),
  stepCount: row.step_count,
  noProgressCount: row.no_progress_count,
  maxSteps: row.max_steps,
  maxNoProgressSteps: row.max_no_progress_steps,
  maxDurationMs: row.max_duration_ms,
  checksEnabled: row.checks_enabled === 1,
  createdBy: row.created_by,
  createdAt: row.created_at,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  finalSummary: row.final_summary,
});

const teamStepRowToDomain = (row: TeamStepRow): TeamStep => ({
  id: row.id,
  runId: row.run_id,
  seq: row.seq,
  stage: row.stage,
  actor: row.actor,
  dispatchId: row.dispatch_id,
  requestId: row.request_id,
  inputText: row.input_text,
  outputText: row.output_text,
  result: row.result,
  errorClass: row.error_class as TeamStep["errorClass"],
  createdAt: row.created_at,
});

const teamFeedbackRowToDomain = (row: TeamFeedbackRow): TeamFeedback => ({
  id: row.id,
  runId: row.run_id,
  messageId: row.message_id,
  feedbackText: row.feedback_text,
  status: row.status,
  createdAt: row.created_at,
  consumedAt: row.consumed_at,
});

const memoryRowToEntry = (row: any): MemoryLogEntry => ({
  id: row.id,
  eventId: row.event_id,
  roomId: row.room_id,
  timestamp: row.timestamp,
  source: row.source,
  eventType: row.event_type,
  payload: JSON.parse(row.payload),
});

const snapshotRowToDomain = (row: any): MemorySnapshot => ({
  roomId: row.room_id,
  currentGoal: row.current_goal,
  activeBranch: row.active_branch,
  activeWorktrees: JSON.parse(row.active_worktrees),
  keyDecisions: JSON.parse(row.key_decisions),
  blockers: JSON.parse(row.blockers),
  nextActions: JSON.parse(row.next_actions),
  taskStatus: JSON.parse(row.task_status),
  lastLogId: row.last_log_id,
  reducerVersion: row.reducer_version,
  updatedAt: row.updated_at,
});

const teamCheckRowToDomain = (row: TeamCheckRow): TeamCheck => ({
  id: row.id,
  runId: row.run_id,
  stepId: row.step_id,
  command: row.command,
  status: row.status,
  exitCode: row.exit_code,
  stdoutText: row.stdout_text,
  stderrText: row.stderr_text,
  durationMs: row.duration_ms,
  createdAt: row.created_at,
});
