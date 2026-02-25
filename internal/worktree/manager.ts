import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorktreeInfo {
  agent: string;
  path: string;
  branch: string;
  head: string;
}

export interface WorktreeStatus extends WorktreeInfo {
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  syncUnavailable: string | null;
}

export interface MergeResult {
  success: boolean;
  conflicts: string[] | null;
}

export const WORKTREE_AGENT_NAME_PATTERN = /^[a-z0-9._-]+$/;

export const normalizeWorktreeAgentName = (agent: string): string =>
  agent.trim().toLowerCase();

export const isValidWorktreeAgentName = (agent: string): boolean =>
  WORKTREE_AGENT_NAME_PATTERN.test(agent);

export class WorktreeManager {
  private readonly worktreeDir: string;
  private readonly includeLegacyDefaultWorktreePaths: boolean;
  private readonly agentMap = new Map<string, WorktreeInfo>();
  private locked = false;

  public constructor(
    private readonly repoRoot: string,
    worktreeDir?: string,
  ) {
    this.includeLegacyDefaultWorktreePaths = !worktreeDir;
    this.worktreeDir = worktreeDir ? resolve(worktreeDir) : join(repoRoot, ".agoryx", "worktrees");
  }

  public create(agent: string): WorktreeInfo {
    const normalizedAgent = normalizeWorktreeAgentName(agent);
    if (!isValidWorktreeAgentName(normalizedAgent)) {
      throw new Error(
        `Invalid agent name '${agent}'. Allowed characters: a-z, 0-9, dot, underscore, hyphen.`,
      );
    }

    const existing = this.agentMap.get(normalizedAgent);
    if (existing && existsSync(existing.path)) {
      return existing;
    }

    this.acquireLock();
    try {
      const wtPath = join(this.worktreeDir, normalizedAgent);
      if (existsSync(wtPath)) {
        // Worktree directory exists from a previous run; reconcile and return
        this.reconcileOne(wtPath, normalizedAgent);
        const info = this.agentMap.get(normalizedAgent);
        if (info) return info;
      }

      mkdirSync(this.worktreeDir, { recursive: true });

      const shortId = randomUUID().slice(0, 8);
      const branch = `agoryx/${normalizedAgent}-${shortId}`;

      execFileSync(
        "git",
        ["worktree", "add", "-b", branch, wtPath],
        {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const head = this.getHead(wtPath);
      const info: WorktreeInfo = { agent: normalizedAgent, path: wtPath, branch, head };
      this.agentMap.set(normalizedAgent, info);
      return info;
    } finally {
      this.releaseLock();
    }
  }

  public list(): WorktreeInfo[] {
    return [...this.agentMap.values()];
  }

  public getForAgent(agent: string): WorktreeInfo | null {
    return this.agentMap.get(normalizeWorktreeAgentName(agent)) ?? null;
  }

  public remove(agent: string, force = false): void {
    const normalizedAgent = normalizeWorktreeAgentName(agent);
    const info = this.agentMap.get(normalizedAgent);
    if (!info) return;

    this.acquireLock();
    try {
      if (!force && this.isDirty(info.path)) {
        throw new Error(
          `Worktree for ${agent} has uncommitted changes. Use force=true to remove anyway.`,
        );
      }

      execFileSync(
        "git",
        ["worktree", "remove", ...(force ? ["--force"] : []), info.path],
        {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // Clean up the branch
      try {
        execFileSync(
          "git",
          ["branch", "-D", info.branch],
          {
            cwd: this.repoRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch (error: unknown) {
        this.logGitFailure(
          `failed to delete branch '${info.branch}' for agent '${normalizedAgent}'`,
          error,
        );
      }

      this.agentMap.delete(normalizedAgent);
    } finally {
      this.releaseLock();
    }
  }

  public merge(agent: string): MergeResult {
    const normalizedAgent = normalizeWorktreeAgentName(agent);
    const info = this.agentMap.get(normalizedAgent);
    if (!info) {
      throw new Error(`No worktree found for agent '${agent}'.`);
    }

    // Check if agent branch has any commits ahead of current HEAD
    try {
      const diffOutput = execFileSync(
        "git",
        ["log", "--oneline", `HEAD..${info.branch}`],
        { cwd: this.repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      if (!diffOutput) {
        return { success: true, conflicts: null };
      }
    } catch {
      // Branch comparison failed — attempt merge anyway
    }

    try {
      execFileSync(
        "git",
        ["merge", info.branch, "--no-edit", "-m", `Merge ${info.branch} into current branch`],
        { cwd: this.repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { success: true, conflicts: null };
    } catch {
      // Merge failed — likely conflicts
      try {
        const statusOutput = execFileSync(
          "git",
          ["diff", "--name-only", "--diff-filter=U"],
          { cwd: this.repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
        const conflicts = statusOutput ? statusOutput.split("\n") : [];
        // Abort the failed merge
        try {
          execFileSync("git", ["merge", "--abort"], {
            cwd: this.repoRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          // Abort may fail if no merge in progress
        }
        return { success: false, conflicts };
      } catch {
        return { success: false, conflicts: ["unknown conflict — manual resolution required"] };
      }
    }
  }

  public status(): WorktreeStatus[] {
    return this.list().map((info) => {
      const dirty = this.isDirty(info.path);
      const sync = this.getAheadBehind(info.path);
      return {
        ...info,
        dirty,
        ahead: sync.ahead,
        behind: sync.behind,
        syncUnavailable: sync.unavailable,
      };
    });
  }

  public ensureClean(agent: string): void {
    const info = this.agentMap.get(normalizeWorktreeAgentName(agent));
    if (!info) return;
    if (this.isDirty(info.path)) {
      throw new Error(`Worktree for ${agent} has uncommitted changes.`);
    }
  }

  public reconcile(): void {
    let porcelain: Array<{ path: string; branch: string; head: string }>;
    try {
      porcelain = this.parseWorktreeList();
    } catch (error: unknown) {
      this.logGitFailure("failed to reconcile git worktrees", error);
      return;
    }
    this.agentMap.clear();
    for (const wt of porcelain) {
      if (!this.isManagedWorktreePath(wt.path)) continue;

      const normalizedAgent = normalizeWorktreeAgentName(basename(wt.path));
      if (!isValidWorktreeAgentName(normalizedAgent)) continue;

      const info: WorktreeInfo = {
        agent: normalizedAgent,
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
      };
      this.agentMap.set(normalizedAgent, info);
    }
  }

  private reconcileOne(path: string, agent: string): void {
    const requested = this.normalizePath(path);
    const porcelain = this.parseWorktreeList();
    const wt = porcelain.find((item) => this.normalizePath(item.path) === requested);
    if (wt) {
      this.agentMap.set(agent, {
        agent,
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
      });
    }
  }

  private parseWorktreeList(): Array<{ path: string; branch: string; head: string }> {
    const output = execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      {
        cwd: this.repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const blocks = output.split("\n\n").filter(Boolean);
    const results: Array<{ path: string; branch: string; head: string }> = [];

    for (const block of blocks) {
      const lines = block.split("\n");
      let path = "";
      let head = "unknown";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        } else if (line.startsWith("HEAD ")) {
          head = line.slice("HEAD ".length) || "unknown";
        } else if (line.startsWith("branch ")) {
          branch = line.slice("branch ".length).replace("refs/heads/", "");
        }
      }

      if (path) {
        results.push({ path, head, branch });
      }
    }

    return results;
  }

  private isManagedWorktreePath(candidatePath: string): boolean {
    const normalizedCandidate = this.normalizePath(candidatePath);
    const normalizedRoot = this.normalizePath(this.worktreeDir);
    if (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}/`)
    ) {
      return true;
    }
    if (!this.includeLegacyDefaultWorktreePaths) {
      return false;
    }
    const legacyRoot = this.normalizePath(join(this.repoRoot, ".agoryx", "worktrees"));
    return normalizedCandidate === legacyRoot ||
      normalizedCandidate.startsWith(`${legacyRoot}/`);
  }

  private normalizePath(path: string): string {
    const resolved = resolve(path);
    if (existsSync(resolved)) {
      return realpathSync(resolved).replace(/\\/g, "/");
    }
    return resolved.replace(/\\/g, "/");
  }

  private getHead(cwd: string): string {
    try {
      const value = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return value || "unknown";
    } catch (error: unknown) {
      this.logGitFailure(`failed to read HEAD for '${cwd}'`, error);
      return "unknown";
    }
  }

  private isDirty(cwd: string): boolean {
    try {
      const output = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return output.trim().length > 0;
    } catch (error: unknown) {
      this.logGitFailure(`failed to check dirty status for '${cwd}'`, error);
      return true;
    }
  }

  private getAheadBehind(
    cwd: string,
  ): { ahead: number | null; behind: number | null; unavailable: string | null } {
    const defaultBranch = this.detectDefaultBranch();
    if (!defaultBranch) {
      return {
        ahead: null,
        behind: null,
        unavailable: "default branch is unavailable",
      };
    }

    try {
      const output = execFileSync(
        "git",
        ["rev-list", "--left-right", "--count", `${defaultBranch}...HEAD`],
        {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const [behindRaw, aheadRaw] = output.trim().split(/\s+/, 2);
      const behind = Number(behindRaw);
      const ahead = Number(aheadRaw);
      if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
        throw new Error(`unexpected rev-list output: '${output.trim()}'`);
      }
      return { ahead, behind, unavailable: null };
    } catch (error: unknown) {
      this.logGitFailure(`failed to compute ahead/behind for '${cwd}'`, error);
      const message = error instanceof Error ? error.message : String(error);
      return { ahead: null, behind: null, unavailable: message };
    }
  }

  private detectDefaultBranch(): string | null {
    try {
      const ref = execFileSync(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
      return ref.replace("refs/remotes/origin/", "");
    } catch {
      for (const candidate of ["main", "master"]) {
        if (this.hasLocalBranch(candidate)) {
          return candidate;
        }
      }

      try {
        const current = execFileSync(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          {
            cwd: this.repoRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).trim();
        if (current && current !== "HEAD") {
          return current;
        }
      } catch {
        // no-op; handled below
      }

      this.logGitFailure(
        "failed to detect default branch",
        "origin/HEAD missing and no local fallback branch found",
      );
      return null;
    }
  }

  private hasLocalBranch(branch: string): boolean {
    try {
      execFileSync(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        {
          cwd: this.repoRoot,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  private logGitFailure(context: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const firstLine = detail.split(/\r?\n/, 1)[0] ?? detail;
    console.error(`[worktree] ${context}: ${firstLine}`);
  }

  private acquireLock(): void {
    if (this.locked) {
      throw new Error("WorktreeManager: concurrent operation in progress");
    }
    // Defensive re-entrancy guard around multi-step git mutations.
    this.locked = true;
  }

  private releaseLock(): void {
    this.locked = false;
  }
}
