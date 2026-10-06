import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agoraHome } from "./paths.js";

// Whether a newer Agoryx has been released: the latest release on GitHub against this install's version.
// The daemon asks only when a page asks it (GET /api/update), at most every CHECK_EVERY_MS, and remembers the
// answer in <AGORYX_HOME>/update.json across restarts. Nothing is downloaded or installed here: the UI shows
// the release and the human installs it. AGORYX_UPDATE_CHECK=off turns the check off.
// A forced check ("Check for updates") clicked again within a minute gets the answer just given: GitHub's
// unauthenticated limit is shared by everything on this address.

export const RELEASES_REPO = "gaborishka/agoryx";
const LATEST_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`;

/** How often the release is asked for again: GitHub allows 60 unauthenticated requests an hour per address. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** After a failed check (offline, rate-limited): sooner than a successful one, not on every page load. */
const RETRY_AFTER_MS = 30 * 60 * 1000;
/** "Check for updates" clicked again within this: the answer just given, not another request. */
const FORCE_GAP_MS = 60 * 1000;
const TIMEOUT_MS = 8_000;

export interface ReleaseInfo {
  version: string;
  name: string;
  /** The release's page (notes and every asset). */
  url: string;
  /** The macOS download (the release's .dmg), when it has one. */
  download: string | null;
  publishedAt: string | null;
  /** The release notes as written (Markdown), cut to MAX_NOTES characters. */
  notes: string;
}

export interface UpdateStatus {
  /** This install's version; null when it cannot tell. */
  current: string | null;
  /** The latest release, once asked. */
  latest: ReleaseInfo | null;
  /** The latest release is newer than this install. */
  available: boolean;
  /** When GitHub last answered or failed to (ISO); null: not asked yet. */
  checkedAt: string | null;
  /** Why the last check failed; the previous answer, if any, still stands. */
  error: string | null;
  /** AGORYX_UPDATE_CHECK=off. */
  disabled: boolean;
}

const MAX_NOTES = 4000;

/** `v1.2.3`, `1.2.3-beta.1` → comparable parts; null for anything that is not a version. */
const parseVersion = (text: string): { core: number[]; pre: string[] } | null => {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)], pre: match[4] ? match[4].split(".") : [] };
};

/** Semantic-version order: -1, 0 or 1; null when either is not a version. A pre-release comes before its release. */
export const compareVersions = (a: string, b: string): number | null => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx < ny ? -1 : 1;
    if (nx !== null) return -1;
    if (ny !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
};

/** Whether `latest` is a newer release than `current`. */
export const isNewer = (latest: string, current: string | null): boolean => current !== null && compareVersions(latest, current) === 1;

/** An https link on github.com, or null: nothing else is offered as the release's page or download. */
const githubLink = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.href : null;
  } catch {
    return null;
  }
};

const cutNotes = (text: string): string => (text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES).trimEnd()}…` : text);

/** GitHub's release JSON → what the UI shows; null when it names no version. Only https links on github.com pass. */
export const parseRelease = (raw: unknown): ReleaseInfo | null => {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (body.draft === true || body.prerelease === true) return null;
  const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
  if (!parseVersion(tag)) return null;
  const version = tag.replace(/^v/, "");
  const assets = Array.isArray(body.assets) ? (body.assets as Array<Record<string, unknown>>) : [];
  const dmg = assets.find((asset) => typeof asset?.name === "string" && /\.dmg$/i.test(asset.name));
  const notes = typeof body.body === "string" ? body.body.replace(/\r\n/g, "\n").trim() : "";
  return {
    version,
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : `Agoryx ${version}`,
    url: githubLink(body.html_url) ?? RELEASES_PAGE,
    download: githubLink(dmg?.browser_download_url),
    publishedAt: typeof body.published_at === "string" ? body.published_at : null,
    notes: cutNotes(notes),
  };
};

/**
 * A release as update.json keeps it, checked again on the way back: the file is in the state folder, which any
 * process of this user (an agent's among them) can write, so its links pass the same filter as GitHub's answer.
 */
const rememberedRelease = (raw: unknown): ReleaseInfo | null => {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!parseVersion(version)) return null;
  return {
    version: version.replace(/^v/, ""),
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : `Agoryx ${version}`,
    url: githubLink(body.url) ?? RELEASES_PAGE,
    download: githubLink(body.download),
    publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : null,
    notes: typeof body.notes === "string" ? cutNotes(body.notes) : "",
  };
};

interface Remembered {
  latest: ReleaseInfo | null;
  checkedAt: string | null;
  error: string | null;
}

export const updatePath = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "update.json");

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UpdateCheckerOptions {
  env?: NodeJS.ProcessEnv;
  /** This install's version. */
  current: string | null;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
  /** How long GitHub is given to answer (default 8s). */
  timeoutMs?: number;
}

export class UpdateChecker {
  private readonly env: NodeJS.ProcessEnv;
  private readonly current: string | null;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  private remembered: Remembered;
  private checking: Promise<void> | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.env = options.env ?? process.env;
    this.current = options.current;
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.remembered = this.read();
  }

  get disabled(): boolean {
    return /^(off|0|false|no)$/i.test(this.env.AGORYX_UPDATE_CHECK?.trim() ?? "");
  }

  status(): UpdateStatus {
    const { latest, checkedAt, error } = this.remembered;
    return {
      current: this.current,
      latest,
      available: !this.disabled && latest !== null && isNewer(latest.version, this.current),
      checkedAt,
      error,
      disabled: this.disabled,
    };
  }

  /** Whether the remembered answer is old enough to ask again. */
  stale(): boolean {
    const { checkedAt, error } = this.remembered;
    const at = checkedAt ? Date.parse(checkedAt) : NaN;
    if (!Number.isFinite(at) || at > this.now()) return true;
    return this.now() - at >= (error ? RETRY_AFTER_MS : CHECK_EVERY_MS);
  }

  /**
   * The status, asking GitHub first when the answer is stale (or `force`). Never rejects: a failed check is
   * recorded in `error`, and the previous answer stays.
   */
  async check(force = false): Promise<UpdateStatus> {
    if (this.disabled) return this.status();
    if ((force && !this.justAsked()) || this.stale()) {
      this.checking ??= this.ask().finally(() => {
        this.checking = null;
      });
      await this.checking;
    }
    return this.status();
  }

  /** GitHub answered (or failed) less than FORCE_GAP_MS ago. */
  private justAsked(): boolean {
    const at = this.remembered.checkedAt ? Date.parse(this.remembered.checkedAt) : NaN;
    return Number.isFinite(at) && at <= this.now() && this.now() - at < FORCE_GAP_MS;
  }

  private async ask(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const response = await this.fetcher(LATEST_URL, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": `agoryx/${this.current ?? "unknown"}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 404 ? "no release published yet" : `GitHub answered HTTP ${response.status}`);
      const latest = parseRelease(await response.json());
      if (!latest) throw new Error("the latest release names no version");
      if (latest.version !== this.remembered.latest?.version) this.log(`latest release: ${latest.version} (this is ${this.current ?? "unknown"})`);
      this.remember({ latest, checkedAt, error: null });
    } catch (error) {
      const message = controller.signal.aborted ? "GitHub did not answer in time" : error instanceof Error ? error.message : String(error);
      this.remember({ ...this.remembered, checkedAt, error: message });
    } finally {
      clearTimeout(timer);
    }
  }

  private read(): Remembered {
    try {
      const parsed = JSON.parse(readFileSync(updatePath(this.env), "utf8")) as Record<string, unknown>;
      return {
        latest: rememberedRelease(parsed.latest),
        checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : null,
        error: typeof parsed.error === "string" ? parsed.error : null,
      };
    } catch {
      return { latest: null, checkedAt: null, error: null };
    }
  }

  private remember(next: Remembered): void {
    this.remembered = next;
    try {
      const path = updatePath(this.env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      // Remembering saves a request on the next start; the answer stands without it.
    }
  }
}
