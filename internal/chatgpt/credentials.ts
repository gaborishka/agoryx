import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agoraHome } from "../agora/paths.js";

/**
 * What Sign in with ChatGPT leaves on this machine: this host's id, and each registered account's tokens.
 * Owner-only files; never logged, never passed to the agents Agoryx runs.
 */

export const chatgptDir = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "chatgpt");

export const PLAN_SCOPE = "chatgpt.tokens.use.direct";

export interface ChatGptAccount {
  /** The client id OpenAI issued when the human registered Agoryx with this account and workspace (oaiapp_…). */
  clientId: string;
  /** From the validated ID token. */
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  /** What the last token response granted. */
  scopes: string[];
  /** Kept for id_token_hint on the next sign-in; cleared on sign-out, like the others. */
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  earliestRefreshAt: string | null;
  savedAt: string;
  /** When Agoryx said, once, that it now uses the human's plan. */
  welcomedAt?: string;
}

export interface ChatGptAccounts {
  active: string | null;
  accounts: Record<string, ChatGptAccount>;
}

export const planUsageOn = (account: ChatGptAccount): boolean => account.scopes.includes(PLAN_SCOPE);

const accountsPath = (dir: string): string => join(dir, "accounts.json");
const hostPath = (dir: string): string => join(dir, "host.json");

const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

/** Writes the whole file or nothing, readable by its owner alone. */
export const writePrivateJson = (path: string, value: unknown): void => {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
};

/**
 * This host's ext_agent_host_id: made once, before its first sign-in, and the same on every later one.
 * An opaque urn:uuid, not an identity or a credential.
 */
export const hostId = (dir: string): string => {
  const path = hostPath(dir);
  if (existsSync(path)) {
    const saved = (JSON.parse(readFileSync(path, "utf8")) as { extAgentHostId?: unknown }).extAgentHostId;
    if (typeof saved === "string" && saved.startsWith("urn:uuid:")) return saved;
  }
  ensureDir(dir);
  const id = `urn:uuid:${randomUUID()}`;
  writePrivateJson(path, { extAgentHostId: id, createdAt: new Date().toISOString() });
  return id;
};

export const readAccounts = (dir: string): ChatGptAccounts => {
  const path = accountsPath(dir);
  if (!existsSync(path)) return { active: null, accounts: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ChatGptAccounts>;
  return { active: raw.active ?? null, accounts: raw.accounts ?? {} };
};

export const writeAccounts = (dir: string, accounts: ChatGptAccounts): void => {
  ensureDir(dir);
  writePrivateJson(accountsPath(dir), accounts);
};

export const activeAccount = (dir: string): ChatGptAccount | null => {
  const { active, accounts } = readAccounts(dir);
  return active ? (accounts[active] ?? null) : null;
};

/** Saves one account's record whole (never another's tokens with it) and, unless told not to, makes it the active one. */
export const saveAccount = (dir: string, account: ChatGptAccount, { activate = true } = {}): void => {
  const current = readAccounts(dir);
  current.accounts[account.clientId] = account;
  if (activate) current.active = account.clientId;
  writeAccounts(dir, current);
};

/** The account without its tokens: what is kept after sign-out, so the next sign-in reuses its client id. */
export const withoutTokens = (account: ChatGptAccount): ChatGptAccount => ({
  ...account,
  idToken: null,
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  earliestRefreshAt: null,
  savedAt: new Date().toISOString(),
});

const STALE_LOCK_MS = 30_000;

/** Runs fn while holding this directory's refresh lock, so two processes never spend one rotating refresh token. */
export const withRefreshLock = async <T>(dir: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> => {
  ensureDir(dir);
  const path = join(dir, "refresh.lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) rmSync(path, { force: true });
      } catch {
        // gone already
      }
      if (Date.now() > deadline) throw new Error(`another Agoryx process holds ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
};
