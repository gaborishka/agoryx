import { applyTableOp, emptyTable } from "./table.js";
import { parseIntelligentUI } from "./intelligent-ui.js";
import type { RoomEvent, RoomState, TableComponent } from "./types.js";

export class ToolEmbedError extends Error {
  constructor(public readonly status: 400 | 404, message: string) { super(message); }
}

export interface ToolEmbed {
  pinned: TableComponent;
  current: TableComponent | null;
  messageSeq: number;
}

/** Resolve a chat reference against the immutable message event, never today's model. */
export function resolveToolEmbed(events: readonly RoomEvent[], state: RoomState, messageId: string, componentId: string): ToolEmbed {
  if (!/^m[1-9]\d*$/.test(messageId) || !/^W[1-9]\d*$/.test(componentId)
    || messageId.trim() !== messageId || componentId.trim() !== componentId) {
    throw new ToolEmbedError(400, "Use a message ID (m1) and a tool ID (W1)");
  }
  const message = state.messages.find(item => item.id === messageId);
  if (!message) throw new ToolEmbedError(404, "No such message in this room");
  const table = emptyTable();
  for (const event of events) {
    if (event.seq > message.seq) break;
    if (event.type === "table.op") applyTableOp(table, event.op, event.seq);
  }
  const pinned = table.components?.find(item => item.id === componentId);
  if (!pinned || pinned.kind !== "interactive" || !pinned.ui) {
    throw new ToolEmbedError(404, "No native tool with this ID at the time of this message");
  }
  // Historical events are not trusted executable data. Validate the same bounded
  // contract as publication, even if an old log was written by an earlier version.
  try { pinned.ui = parseIntelligentUI(pinned.ui, pinned.refs); }
  catch { throw new ToolEmbedError(404, "The historical tool definition is unavailable"); }
  const current = state.table.components?.find(item => item.id === componentId) ?? null;
  return { pinned, current: current ? structuredClone(current) : null, messageSeq: message.seq };
}
