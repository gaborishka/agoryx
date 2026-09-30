import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";
import { bannerFor } from "../desktop/attention.js";
import { deviceLabel, type DeviceRegistry, type PushSubscriptionJson } from "./devices.js";
import { agoraHome } from "./paths.js";
import type { AttentionItem } from "./types.js";

/**
 * Web Push to paired devices when a room starts waiting for the human (attention.ts raises it). The VAPID
 * keys are made here on first use and kept in `<agoraHome>/vapid.json`; the payload is encrypted for each
 * browser (web-push does the crypto) and sent to the push service its subscription names. Browsers give
 * push only to a secure page, so a phone subscribes over HTTPS (Tailscale serve), not over plain LAN http.
 *
 * An agent runs as the same user and can read vapid.json and devices.json, so it could push to a phone
 * itself. So a push carries only an id: the phone's service worker asks the daemon (with the device's
 * cookie) what it says, and shows nothing for an id the daemon did not send to that device.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Who sends: web push services want a contact, and Apple's refuses a localhost one. */
const SUBJECT = "https://github.com/gaborishka/agoryx";

export const vapidFile = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "vapid.json");

export const loadOrCreateVapid = (env: NodeJS.ProcessEnv = process.env): VapidKeys => {
  const path = vapidFile(env);
  try {
    const keys = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
    if (typeof keys.publicKey === "string" && typeof keys.privateKey === "string") return { publicKey: keys.publicKey, privateKey: keys.privateKey };
  } catch {
    // made below
  }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return keys;
};

/** A subscription as a browser sends it, or the text of the 400. */
export const parseSubscription = (body: unknown, options: { allowHttp?: boolean } = {}): PushSubscriptionJson | string => {
  const fields = (body && typeof body === "object" ? body : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof fields.endpoint !== "string" || fields.endpoint.length > 2048) return "endpoint must be a URL";
  let url: URL;
  try {
    url = new URL(fields.endpoint);
  } catch {
    return "endpoint must be a URL";
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) return "endpoint must be an https URL";
  const p256dh = fields.keys?.p256dh;
  const auth = fields.keys?.auth;
  if (typeof p256dh !== "string" || !/^[\w-]{40,200}$/.test(p256dh) || typeof auth !== "string" || !/^[\w-]{10,64}$/.test(auth)) {
    return "keys.p256dh and keys.auth are required (base64url)";
  }
  return { endpoint: fields.endpoint, keys: { p256dh, auth } };
};

/** What a notification says; a click opens the room. */
export interface PushNote {
  title: string;
  body: string;
  room: string | null;
  tag: string;
}

/** The room's name, why it waits, and its last line. */
export const noteFor = (item: AttentionItem): PushNote => {
  const banner = bannerFor([item]);
  return { title: banner.title, body: [banner.subtitle, banner.body].filter(Boolean).join("\n"), room: item.room, tag: `room-${item.room}` };
};

/** Longer than a push lives at the push service (TTL 1 hour), so a late one still finds its note. */
const NOTE_TTL_MS = 2 * 60 * 60_000;
const MAX_NOTES = 500;

/** The notes pushes point to, per device, in memory. */
export class PushNotes {
  private readonly notes = new Map<string, { device: string; note: PushNote; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Keeps a note for one device; the id goes in the push. */
  add(device: string, note: PushNote): string {
    const now = this.now();
    for (const [id, entry] of this.notes) if (entry.expires <= now) this.notes.delete(id);
    while (this.notes.size >= MAX_NOTES) this.notes.delete(this.notes.keys().next().value!);
    const id = randomBytes(16).toString("base64url");
    this.notes.set(id, { device, note, expires: now + NOTE_TTL_MS });
    return id;
  }

  /** The note, when it was sent to this device and has not expired. */
  get(id: string, device: string): PushNote | null {
    const entry = this.notes.get(id);
    return entry && entry.device === device && entry.expires > this.now() ? entry.note : null;
  }
}

export interface PushSenderOptions {
  env: NodeJS.ProcessEnv;
  devices: DeviceRegistry;
  notes: PushNotes;
  log?: (message: string) => void;
  fetch?: typeof fetch;
}

export class PushSender {
  private readonly devices: DeviceRegistry;
  private readonly notes: PushNotes;
  private readonly log: (message: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private keys: VapidKeys | null = null;

  constructor(options: PushSenderOptions) {
    this.env = options.env;
    this.devices = options.devices;
    this.notes = options.notes;
    this.log = options.log ?? (() => {});
    this.fetchImpl = options.fetch ?? fetch;
  }

  get publicKey(): string {
    return this.vapid().publicKey;
  }

  /**
   * Sends a note to every subscribed device (or one): the push carries only the note's id. A
   * subscription the push service says is gone is dropped.
   */
  async send(note: PushNote, only?: string): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const { publicKey, privateKey } = this.vapid();
    await Promise.all(
      this.devices.pushTargets().map(async ({ device, subscription }) => {
        if (only && device.id !== only) return;
        const payload = JSON.stringify({ id: this.notes.add(device.id, note) });
        try {
          const request = webpush.generateRequestDetails(subscription, payload, {
            vapidDetails: { subject: SUBJECT, publicKey, privateKey },
            TTL: 60 * 60,
            urgency: "high",
          });
          const response = await this.fetchImpl(request.endpoint, {
            method: request.method,
            headers: request.headers as Record<string, string>,
            body: request.body ? new Uint8Array(request.body) : null,
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 404 || response.status === 410) {
            // The browser dropped the subscription (unsubscribed, reinstalled, expired).
            this.devices.setPush(device.id, null);
            this.log(`push: ${deviceLabel(device)} no longer takes notifications; its subscription was removed`);
            failed += 1;
          } else if (!response.ok) {
            this.log(`push: ${deviceLabel(device)}: the push service answered ${response.status}`);
            failed += 1;
          } else sent += 1;
        } catch (error) {
          // Never the endpoint: it is the device's address at its push service.
          this.log(`push: ${deviceLabel(device)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
          failed += 1;
        }
      }),
    );
    return { sent, failed };
  }

  /** A room started waiting for the human. */
  notify(item: AttentionItem): Promise<{ sent: number; failed: number }> {
    return this.send(noteFor(item));
  }

  private vapid(): VapidKeys {
    this.keys ??= loadOrCreateVapid(this.env);
    return this.keys;
  }
}
