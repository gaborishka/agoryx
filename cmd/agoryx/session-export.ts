import type {
  Checkpoint,
  Message,
  PinnedContext,
  Room,
} from "../../internal/events/types.js";

export interface SessionExportData {
  targetId: string;
  room: Room;
  checkpoint: Checkpoint | null;
  pinnedContext: PinnedContext[];
  messages: Message[];
  exportedAt?: string;
}

const resolveExportedAt = (value?: string): string => value ?? new Date().toISOString();

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
