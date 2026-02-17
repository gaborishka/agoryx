import Database from "better-sqlite3";
import type {
  Checkpoint,
  EventEnvelope,
  Message,
  PinnedContext,
  Room,
  RoomConfig,
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

export class SQLiteStore {
  private readonly db: Database.Database;

  public constructor(dbPath: string) {
    this.db = new Database(dbPath);
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
  } catch {
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
