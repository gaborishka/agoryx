import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agoraHome } from "./paths.js";
import type { RoomAgent } from "./types.js";

/**
 * The human's profile: who they are, how they work, what matters to them — written once, by them, in
 * <AGORYX_HOME>/profile.md, and given to the agents of every room, except those whose roster entry says
 * `"profile": false`. The room's history is seen by everyone; the profile only by those it is on for.
 *
 * Agoryx never copies it anywhere: not into the workspace, not into .agoryx/, not into commits, not into
 * the room's event log (which keeps only a hash of the version each agent was given, so a restarted
 * daemon still knows who has which version).
 */

/** A profile is a page, not a book: past this it is cut, and the agent is told so. */
export const MAX_PROFILE_CHARS = 4_000;

export const profilePath = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "profile.md");

export interface Profile {
  /** What an agent is given (already cut to MAX_PROFILE_CHARS). */
  text: string;
  /** Of `text`: tells one version from the next. */
  hash: string;
  truncated: boolean;
  /** The whole file, in characters. */
  chars: number;
}

/** The profile as it is now, or null when there is no file or nothing in it. */
export const readProfile = (path: string | null | undefined): Profile | null => {
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const whole = raw.replace(/\r\n/g, "\n").trim();
  if (!whole) return null;
  let text = whole;
  const truncated = whole.length > MAX_PROFILE_CHARS;
  if (truncated) {
    const cut = whole.lastIndexOf("\n", MAX_PROFILE_CHARS);
    text = `${whole.slice(0, cut > MAX_PROFILE_CHARS / 2 ? cut : MAX_PROFILE_CHARS).trimEnd()}\n[… cut here: the profile is ${whole.length} characters, only the first ${MAX_PROFILE_CHARS} are given to agents]`;
  }
  return { text, hash: createHash("sha256").update(text).digest("hex").slice(0, 16), truncated, chars: whole.length };
};

/** Whether this agent is given the profile (on unless its roster entry says `"profile": false`). */
export const seesProfile = (agent: RoomAgent): boolean => agent.profile !== false;

const KEEP =
  "It is for you, not for the room: the room's history is shared, this is not. Let it shape how you work with them; don't quote or copy it into messages, the table, files or commits.";

/** The profile for a fresh session's briefing. */
export const profileBriefing = (profile: Profile, human: string): string =>
  [`About ${human}, in their own words — ${human} wrote this profile about themself, once, for the agents they work with. ${KEEP}`, "~~~~", profile.text, "~~~~"].join("\n");

/**
 * The profile for a session that already runs: given once when it is new to this session (written or changed
 * since the agent last got it), a notice once when it was removed, and nothing otherwise.
 */
export const profileUpdate = (profile: Profile | null, held: string, human: string): string | null => {
  if (profile) {
    if (profile.hash === held) return null;
    const lead = held
      ? `── ${human} changed their profile since you last got it. This version replaces the earlier one; they wrote it about themself.`
      : `── ${human} wrote a profile about themself, for the agents they work with.`;
    return [`${lead} ${KEEP}`, "~~~~", profile.text, "~~~~"].join("\n");
  }
  return held ? `── ${human} removed their profile: what it said no longer applies.` : null;
};

export interface ProfileReader {
  agent: RoomAgent;
  /**
   * off: the roster keeps it from this agent. has: its session holds this version.
   * next: it gets this version with its next turn (it never had it, or had an older one).
   */
  status: "off" | "has" | "next";
}

/** Who in a room sees the profile, and whether they already hold the current version (from the room's log). */
export const profileReaders = (
  state: { agents: RoomAgent[]; profiles?: Record<string, string> },
  profile: Profile | null,
): ProfileReader[] =>
  state.agents.map((agent) => ({
    agent,
    status: !seesProfile(agent) ? "off" : profile && state.profiles?.[agent.id] === profile.hash ? "has" : "next",
  }));

/** `agoryx profile`: where the file is, whether there is one, and who in the room sees it. */
export const describeProfile = (
  path: string,
  profile: Profile | null,
  room: { name: string; id: string; agents: RoomAgent[]; profiles?: Record<string, string> } | null,
): string[] => {
  const lines = [`Profile: ${path}`];
  if (!profile) {
    lines.push("  none yet (or empty) — no agent is given anything. Write who you are, how you work and what matters to you there;");
    lines.push("  agents in every room get it, except those with \"profile\": false in their roster entry.");
  } else {
    lines.push(`  ${profile.chars} characters${profile.truncated ? ` — over ${MAX_PROFILE_CHARS}, so agents get only the first ${MAX_PROFILE_CHARS}, with a note that it was cut` : ""}`);
    lines.push("  Agoryx never writes it into a workspace, .agoryx/ or a commit; the room's log keeps only a hash of the version each agent got.");
  }
  if (!room) return lines;
  lines.push("", `Room "${room.name}" (${room.id}):`);
  const width = Math.max(...room.agents.map((agent) => `${agent.label} (@${agent.id})`.length));
  for (const { agent, status } of profileReaders(room, profile)) {
    const who = `${agent.label} (@${agent.id})`.padEnd(width);
    const what =
      status === "off"
        ? 'is not given it ("profile": false in the roster; its own tools could still read the file)'
        : !profile
          ? "would see it (none written)"
          : status === "has"
            ? "sees it — has this version"
            : "sees it — gets this version with its next turn";
    lines.push(`  ${who}  ${what}`);
  }
  return lines;
};
