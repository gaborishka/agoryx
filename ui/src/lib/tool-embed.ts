/** A ```tool fence names one native table tool and nothing else: no JSON, no HTML, no second copy of its model. */
export const toolEmbedId = (fence: string): string | null => {
  const id = fence.trim();
  return /^W[1-9]\d*$/.test(id) ? id : null;
};

/** Only a posted message pins a version: a streaming reply or a table body has no message event to pin to. */
export const toolEmbedMessage = (source: string | undefined): string | null =>
  source && /^m:m[1-9]\d*$/.test(source) ? source.slice(2) : null;

export type ToolEmbedView = "pinned" | "current";

/**
 * What the switch may offer. The current version is reachable whenever today's item is still a native tool on the table,
 * even when its model is unchanged: saved inputs move on without a new revision, and saving lives only there.
 */
export function toolEmbedState(pinnedSeq: number, current: { contentSeq?: number; seq: number; archived?: boolean; kind?: string; ui?: unknown } | null) {
  if (!current) return { changed: true, reachable: false, note: "This tool was removed from the table. The version from this message is shown." };
  if (current.archived) return { changed: true, reachable: false, note: "This tool is archived. The version from this message is shown." };
  if (current.kind !== "interactive" || !current.ui) return { changed: true, reachable: false, note: "This item is no longer a native tool. The version from this message is shown." };
  const changed = (current.contentSeq ?? current.seq) !== pinnedSeq;
  return { changed, reachable: true, note: changed ? "The tool has changed since this message." : null };
}
