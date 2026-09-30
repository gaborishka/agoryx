import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agoraHome } from "./paths.js";

/**
 * Paired devices: the human's phone (or any other browser off this computer) with a token of its own.
 *
 * The human makes a pairing code on this computer (`agoryx pair`, or «Відкрити на телефоні» in the UI);
 * the phone trades it for a device token, which it keeps as an HttpOnly cookie. A pairing is two secrets
 * for one use: a short code to type, and a long one (128 bits) in the QR link. Both live in memory only
 * and expire after five minutes, and either one used spends both. Typed codes are guessable, so wrong
 * ones are limited per address and in total (too many and the live codes can no longer be typed); the
 * link's secret is not, so no guessing ever locks it out. Of a device token only its hash is kept, in
 * `<agoraHome>/devices.json`, so nothing an agent can read there opens the daemon. A device acts as the
 * human; the human revokes it (`agoryx devices revoke`, or the list in the UI).
 */

export const DEVICE_TOKEN_PREFIX = "agxd1";

export const isDeviceToken = (value: string): boolean => value.startsWith(`${DEVICE_TOKEN_PREFIX}.`);

/** A browser's Web Push subscription, as `PushSubscription.toJSON()` gives it. */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 of the whole token, hex. */
  hash: string;
  createdAt: string;
  lastSeen: string;
  push?: PushSubscriptionJson;
}

/** A device as the human sees it: never its hash or its push endpoint. */
export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string;
  push: boolean;
}

/**
 * Why a claim failed, for the phone to say in its own words: the code is wrong (or used, or expired);
 * this address guessed wrong too often; or everyone did, and typed codes were stopped.
 */
export type PairingFailure = "wrong" | "slow-down" | "typing-stopped";

export class PairingError extends Error {
  constructor(
    readonly status: number,
    readonly reason: PairingFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface DeviceRegistryOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long a pairing code lives; default 5 minutes. */
  codeTtlMs?: number;
}

/** Letters and digits that cannot be misread for each other (no 0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
/** The QR link's secret: 26 of the same letters, about 128 bits — nothing to rate-limit. */
const SECRET_LENGTH = 26;
const MAX_LIVE_CODES = 3;
/** Wrong codes from one address: at most this many per minute. */
const PER_ADDRESS_FAILS = 5;
const PER_ADDRESS_WINDOW_MS = 60_000;
/** Wrong codes from anywhere within ten minutes: past this, the live codes can no longer be typed (their links still work). */
const TOTAL_FAILS = 20;
const TOTAL_WINDOW_MS = 10 * 60_000;
/** lastSeen is written at most this often per device (it is kept in memory in between). */
const SEEN_SAVE_MS = 60_000;

export const devicesFile = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "devices.json");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const safeEqualText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** "ABCD-EFGH" for reading aloud or typing; the dash and case do not matter when it is typed back. */
export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export const normalizeCode = (typed: string): string => typed.toUpperCase().replace(/[^0-9A-Z]/g, "");

/**
 * A short name from the User-Agent: "iPhone · Safari", "Android · Chrome", "curl"; empty when nothing is
 * recognised (each place that shows it says "unknown browser" in its own language).
 */
export const deviceName = (userAgent: string | undefined): string => {
  const ua = userAgent ?? "";
  if (!ua.trim()) return "";
  const tool = /^(curl|Wget|HTTPie|python-requests|node)\b/i.exec(ua);
  if (tool) return tool[1]!;
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /EdgA?\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /CriOS\/|Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return [system, browser].filter(Boolean).join(" · ");
};

/** A device's name for the terminal and the log. */
export const deviceLabel = (device: { name: string; id: string }): string => `${device.name || "unknown browser"} (${device.id})`;

const randomLetters = (length: number): string => Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

interface LiveCode {
  secret: string;
  expires: number;
  /** False once guessing stopped typed codes: only the link's secret still works. */
  typable: boolean;
}

const readRecords = (path: string): DeviceRecord[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const fields = parsed && typeof parsed === "object" ? (parsed as { version?: unknown; devices?: unknown }) : {};
  if (fields.version !== 1 || !Array.isArray(fields.devices)) return [];
  return fields.devices.filter(
    (entry): entry is DeviceRecord =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as DeviceRecord).id === "string" &&
      typeof (entry as DeviceRecord).hash === "string" &&
      typeof (entry as DeviceRecord).name === "string",
  );
};

const info = (record: DeviceRecord): DeviceInfo => ({
  id: record.id,
  name: record.name,
  createdAt: record.createdAt,
  lastSeen: record.lastSeen,
  push: Boolean(record.push),
});

export class DeviceRegistry {
  readonly file: string;
  private readonly now: () => number;
  private readonly codeTtlMs: number;
  private records: DeviceRecord[];
  /** Live pairing codes (the typed one → its link secret and expiry). In memory only. */
  private readonly codes = new Map<string, LiveCode>();
  private readonly failsByAddress = new Map<string, number[]>();
  private fails: number[] = [];
  /** When each device's lastSeen was last written. */
  private readonly seenSaved = new Map<string, number>();

  constructor(options: DeviceRegistryOptions = {}) {
    this.file = devicesFile(options.env);
    this.now = options.now ?? Date.now;
    this.codeTtlMs = options.codeTtlMs ?? 5 * 60_000;
    this.records = readRecords(this.file);
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  /**
   * A new single-use pairing: `code` to type, `secret` for the QR link. At most three live at once: a
   * fourth drops the oldest.
   */
  createCode(): { code: string; secret: string; expiresAt: string } {
    this.dropExpired();
    let code = "";
    do code = randomLetters(CODE_LENGTH);
    while (this.codes.has(code));
    while (this.codes.size >= MAX_LIVE_CODES) this.codes.delete(this.codes.keys().next().value!);
    const expires = this.now() + this.codeTtlMs;
    const secret = randomLetters(SECRET_LENGTH);
    this.codes.set(code, { secret, expires, typable: true });
    return { code, secret, expiresAt: new Date(expires).toISOString() };
  }

  /** How many codes can still be used. */
  liveCodes(): number {
    this.dropExpired();
    return this.codes.size;
  }

  /**
   * Trades a typed code, or a link's secret, for a device token (returned once, never stored). Throws
   * PairingError: 400 for a code that is wrong, used or expired; for a typed code, 429 while its address
   * guessed wrong too often, or once everyone did. `from.address` is who asks: the client's address, not
   * the proxy's, when a proxy (Tailscale serve) forwards it.
   */
  claim(typed: unknown, from: { address: string; userAgent?: string }): { token: string; device: DeviceInfo } {
    const now = this.now();
    this.dropExpired();
    const given = typeof typed === "string" ? normalizeCode(typed) : "";
    let code: string | undefined;
    if (given.length === SECRET_LENGTH) {
      // The QR link's secret: too long to guess, so not limited — the phone that scans it always gets in.
      for (const [candidate, live] of this.codes) if (safeEqualText(live.secret, given)) code = candidate;
      if (!code) throw new PairingError(400, "wrong", "this link is used or expired — make a new code on the computer");
    } else {
      const recent = (this.failsByAddress.get(from.address) ?? []).filter((at) => now - at < PER_ADDRESS_WINDOW_MS);
      if (recent.length >= PER_ADDRESS_FAILS) throw new PairingError(429, "slow-down", "too many wrong codes from this address; wait a minute");
      const live = given ? this.codes.get(given) : undefined;
      if (live && !live.typable) throw new PairingError(429, "typing-stopped", "this code can no longer be typed (too many wrong codes) — scan the QR code, or make a new code on the computer");
      if (!live) {
        recent.push(now);
        this.failsByAddress.set(from.address, recent);
        this.fails = this.fails.filter((at) => now - at < TOTAL_WINDOW_MS);
        this.fails.push(now);
        if (this.fails.length >= TOTAL_FAILS) {
          // Someone is guessing: the live codes can no longer be typed. Their QR links still work, and
          // a code made after this can be typed again.
          for (const entry of this.codes.values()) entry.typable = false;
          this.fails = [];
          throw new PairingError(429, "typing-stopped", "too many wrong codes; the live codes can no longer be typed — scan the QR code, or make a new code on the computer");
        }
        throw new PairingError(400, "wrong", "this code is wrong, used or expired — make a new one on the computer");
      }
      code = given;
    }
    this.codes.delete(code);
    const id = randomBytes(6).toString("hex");
    const token = `${DEVICE_TOKEN_PREFIX}.${id}.${randomBytes(32).toString("base64url")}`;
    const stamp = new Date(now).toISOString();
    const record: DeviceRecord = { id, name: deviceName(from.userAgent), hash: sha256(token), createdAt: stamp, lastSeen: stamp };
    this.records = [...this.records, record];
    this.save();
    this.seenSaved.set(id, now);
    return { token, device: info(record) };
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /** The device a token belongs to, or null (unknown, revoked, malformed). Records when it was last seen. */
  authenticate(token: string): DeviceInfo | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== DEVICE_TOKEN_PREFIX) return null;
    const record = this.records.find((entry) => entry.id === parts[1]);
    if (!record) return null;
    const want = Buffer.from(record.hash, "hex");
    const given = Buffer.from(sha256(token), "hex");
    if (want.length !== given.length || !timingSafeEqual(want, given)) return null;
    const now = this.now();
    record.lastSeen = new Date(now).toISOString();
    if (now - (this.seenSaved.get(record.id) ?? 0) >= SEEN_SAVE_MS) {
      this.seenSaved.set(record.id, now);
      this.save();
    }
    return info(record);
  }

  /** Whether a device is paired (not revoked); unlike authenticate, it does not count as being seen. */
  has(id: string): boolean {
    return this.records.some((entry) => entry.id === id);
  }

  list(): DeviceInfo[] {
    return this.records.map(info);
  }

  /** Revokes a device by its id (or a unique prefix of it). Returns what was revoked, or null. */
  revoke(ref: string): DeviceInfo | null {
    const wanted = ref.trim().toLowerCase();
    if (!wanted) return null;
    const matches = this.records.filter((entry) => entry.id === wanted || entry.id.startsWith(wanted));
    const exact = matches.find((entry) => entry.id === wanted);
    const target = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!target) return null;
    this.records = this.records.filter((entry) => entry.id !== target.id);
    this.seenSaved.delete(target.id);
    this.save();
    return info(target);
  }

  /** Sets (or with null, clears) a device's push subscription. */
  setPush(id: string, subscription: PushSubscriptionJson | null): boolean {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) return false;
    if (subscription) record.push = subscription;
    else delete record.push;
    this.save();
    return true;
  }

  /** The devices that asked for notifications, with where to send them. */
  pushTargets(): Array<{ device: DeviceInfo; subscription: PushSubscriptionJson }> {
    return this.records.flatMap((record) => (record.push ? [{ device: info(record), subscription: record.push }] : []));
  }

  /** Writes what is pending (lastSeen). */
  close(): void {
    this.save();
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [code, live] of this.codes) if (live.expires <= now) this.codes.delete(code);
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${JSON.stringify({ version: 1, devices: this.records }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
