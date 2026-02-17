import type {
  Checkpoint,
  Message,
  PinnedContext,
  Room,
} from "../../internal/events/types.js";
import { SQLiteStore } from "../../internal/storage/sqlite.js";

export interface SessionExportData {
  targetId: string;
  room: Room;
  checkpoint: Checkpoint | null;
  pinnedContext: PinnedContext[];
  messages: Message[];
  exportedAt?: string;
}

export type SessionExportFormat = "markdown" | "json";

export interface ExportCommandArgs {
  format: SessionExportFormat;
  outPath?: string;
}

const resolveExportedAt = (value?: string): string => value ?? new Date().toISOString();
const EXPORT_MESSAGE_LIMIT = 10_000;

// "normalize" also resolves default behavior: omitted format => markdown.
// Unknown non-empty values are rejected via null for explicit caller handling.
export const normalizeExportFormat = (value?: string): SessionExportFormat | null => {
  if (!value) {
    return "markdown";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "markdown" || normalized === "json") {
    return normalized;
  }

  return null;
};

export const parseExportCommandArgs = (args: string[]): ExportCommandArgs | null => {
  let cursor = 0;
  let format: SessionExportFormat = "markdown";
  let outPath: string | undefined;

  const maybeFormat = args[cursor];
  const normalizedFormat = normalizeExportFormat(maybeFormat);
  if (maybeFormat && normalizedFormat) {
    format = normalizedFormat;
    cursor += 1;
  } else if (maybeFormat && !maybeFormat.startsWith("--")) {
    return null;
  }

  while (cursor < args.length) {
    const token = args[cursor];
    if (token !== "--out") {
      return null;
    }
    if (outPath) {
      // Duplicate --out is ambiguous; reject instead of silently overwriting.
      return null;
    }

    const value = args[cursor + 1];
    if (!value || value.startsWith("--")) {
      return null;
    }

    outPath = value;
    cursor += 2;
  }

  return { format, outPath };
};

export const collectRoomExportData = (
  store: SQLiteStore,
  roomId: string,
  targetId = roomId,
): SessionExportData => {
  const room = store.getRoom(roomId);
  if (!room) {
    throw new Error(`Room ${roomId} was not found.`);
  }

  return {
    targetId,
    room,
    checkpoint: store.getLatestCheckpoint(room.id),
    pinnedContext: store.listPinnedContext(room.id),
    // Export is intentionally capped to keep memory/output bounded in v0.1.
    messages: store.listMessages(room.id, EXPORT_MESSAGE_LIMIT),
  };
};

export const collectTargetExportData = (
  store: SQLiteStore,
  targetId: string,
): SessionExportData => {
  const roomId = store.resolveRoomId(targetId);
  if (!roomId) {
    throw new Error(`No room/session found for id: ${targetId}`);
  }

  return collectRoomExportData(store, roomId, targetId);
};

export const renderSessionAsJson = (input: SessionExportData): string =>
  JSON.stringify(
    {
      exportedAt: resolveExportedAt(input.exportedAt),
      targetId: input.targetId,
      room: input.room,
      checkpoint: input.checkpoint,
      pinnedContext: input.pinnedContext,
      messages: input.messages,
    },
    null,
    2,
  );

export const renderSessionAsMarkdown = (input: SessionExportData): string => {
  const lines: string[] = [];
  lines.push("# Agoryx Session Export");
  lines.push("");
  lines.push(`- Exported At: ${resolveExportedAt(input.exportedAt)}`);
  lines.push(`- Target Id: ${input.targetId}`);
  lines.push(`- Room Id: ${input.room.id}`);
  lines.push(`- Room Name: ${input.room.name}`);
  lines.push(`- Mode: ${input.room.config.mode}`);
  lines.push(`- Participants: ${input.room.participants.join(", ")}`);
  lines.push("");

  if (input.pinnedContext.length > 0) {
    lines.push("## Pinned Context");
    lines.push("");
    for (const pin of input.pinnedContext) {
      lines.push(`### ${pin.label} (${pin.id})`);
      lines.push(pin.content);
      lines.push("");
    }
  }

  if (input.checkpoint?.summaryText) {
    lines.push("## Latest Checkpoint");
    lines.push("");
    lines.push(input.checkpoint.summaryText);
    lines.push("");
  }

  lines.push("## Messages");
  lines.push("");
  for (const message of input.messages) {
    lines.push(`### ${message.author} (${message.createdAt})`);
    lines.push("");
    lines.push(message.text);
    lines.push("");
  }

  return lines.join("\n");
};

export const renderSessionExport = (
  input: SessionExportData,
  format: SessionExportFormat,
): string => (format === "json" ? renderSessionAsJson(input) : renderSessionAsMarkdown(input));
