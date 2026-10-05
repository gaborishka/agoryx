import type { RoomState } from "./types.js";

/** The filesystem a historical message/turn belonged to, even after a mode switch. */
export const workspaceAt = (state: RoomState, seq: number): string =>
  state.workspaceHistory?.filter((entry) => entry.seq <= seq).at(-1)?.workspace ?? state.workspace;
