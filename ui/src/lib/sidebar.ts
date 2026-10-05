import { baseName, shortPath } from "./format";
import type { RoomSummary } from "./types";

/**
 * How the room list is laid out: the rooms by the folder they work in, and — when the human keeps it on — the rooms
 * whose agents are busy and ask nothing of the human folded into one Working section at the foot of the list. A room
 * comes back out the moment its run ends or it waits for the human, at the top. Busy rooms keep their places, so the list
 * moves only when a room comes back. Only what this browser shows; nothing reaches the agents.
 */

/** Rooms in a folder Agoryx made for them (no folder of the human's) are grouped together. */
export const OWN = "";
export const CHATS = "::chats";
export const groupKey = (room: RoomSummary) => room.projectKey !== undefined ? (room.projectKey ?? CHATS) : room.mode === "chat" ? CHATS : room.folder ?? OWN;

export interface Group {
  key: string;
  label: string;
  title: string;
  /** The group's rooms the list shows (not the folded working ones). */
  rooms: RoomSummary[];
  /** How many of its rooms are folded into Working. */
  busy: number;
  /** A folder's group: its project, by hash (the head opens the project's page). */
  project?: string;
}

/** Agents are at work in the room. */
export const isBusy = (room: RoomSummary) => room.running || Boolean(room.working?.length);

/** Folds into Working: busy and asking nothing of the human. The open room never folds, so sending never moves it away. */
export const folds = (room: RoomSummary, current: string | null) => room.id !== current && !room.waiting && isBusy(room);

/**
 * Where a room stands in the list: the last time it came back to the human — its last word once its agents stop, the
 * moment it began to wait for the human. While agents work and nothing waits, the room keeps the place it had when the
 * work began (or when this page first saw it), so a busy room's messages do not shuffle the list under the human's hand.
 * `held` remembers those places between calls; a page's own list keeps one for its life.
 */
const places = new Map<string, number>();
export const returnTime = (room: RoomSummary, held: Map<string, number> = places) => {
  const last = Date.parse(room.updatedAt) || 0;
  const waits = room.waiting ? Date.parse(room.waiting.ts) || 0 : 0;
  if (!isBusy(room)) {
    held.delete(room.id);
    return Math.max(last, waits);
  }
  let place = held.get(room.id);
  if (place === undefined) {
    place = last;
    held.set(room.id, place);
  }
  return Math.max(place, waits);
};

/** The rooms by `returnTime`, the latest first; a tie keeps the order they came in. */
export const orderRooms = (rooms: RoomSummary[], held: Map<string, number> = places) => {
  const ids = new Set(rooms.map((room) => room.id));
  for (const id of held.keys()) if (!ids.has(id)) held.delete(id);
  return rooms
    .map((room, index) => ({ room, index, at: returnTime(room, held) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ room }) => room);
};

/** When the room's work began: its earliest running turn, or its last activity. */
const workSince = (room: RoomSummary) => {
  const since = (room.working ?? []).map((w) => Date.parse(w.since)).filter((t) => !Number.isNaN(t));
  return since.length ? Math.min(...since) : Date.parse(room.updatedAt) || 0;
};

/**
 * Grouped when the rooms work in more than one folder, or when one of them works in a folder of the human's (its head
 * opens the project); decided on all rooms, so folding does not reshape the list.
 */
export const isGrouped = (rooms: RoomSummary[]) => new Set(rooms.map(groupKey)).size > 1 || rooms.some((room) => room.projectHash);

/** Groups in the order of `rooms`; every group of `rooms` stays, even when all its rooms are folded. */
export const groupRooms = (rooms: RoomSummary[], shown: (room: RoomSummary) => boolean = () => true): Group[] => {
  const groups = new Map<string, Group>();
  for (const room of rooms) {
    const key = groupKey(room);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        rooms: [],
        busy: 0,
        ...(key === CHATS
          ? { label: "Conversations", title: "Conversations without a project" }
          : key === OWN
            ? { label: "New folders", title: "Folders Agoryx created for rooms" }
            : { label: baseName(key), title: key }),
      };
      groups.set(key, group);
    }
    if (shown(room)) group.rooms.push(room);
    else group.busy += 1;
    if (key !== CHATS && key !== OWN && room.projectHash) {
      group.project = room.projectHash;
      if (room.projectName) group.label = room.projectName;
    }
  }
  const list = [...groups.values()];
  // Two folders of one name: say which is which.
  for (const group of list) {
    if (group.key !== OWN && group.key !== CHATS && list.some((other) => other !== group && other.label === group.label) && group.label === baseName(group.key)) group.label = shortPath(group.key);
  }
  return list;
};

export interface SidebarLayout {
  grouped: boolean;
  /** Grouped: the folders, each with the rooms it shows. */
  groups: Group[];
  /** Not grouped: the rooms the list shows. */
  rooms: RoomSummary[];
  /** Folded into Working, the newest work first. Empty when folding is off. */
  working: RoomSummary[];
}

export const layoutRooms = (all: RoomSummary[], current: string | null, fold: boolean, held: Map<string, number> = places): SidebarLayout => {
  const rooms = orderRooms(all, held);
  const shown = (room: RoomSummary) => !fold || !folds(room, current);
  const working = rooms.filter((room) => !shown(room)).sort((a, b) => workSince(b) - workSince(a) || a.id.localeCompare(b.id));
  const grouped = isGrouped(rooms);
  return { grouped, groups: grouped ? groupRooms(rooms, shown) : [], rooms: grouped ? [] : rooms.filter(shown), working };
};
