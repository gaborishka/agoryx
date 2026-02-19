import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorktreeInfo {
  agent: string;
  path: string;
  branch: string;
  head: string;
}

export class WorktreeManager {
  private readonly worktreeDir: string;
  private readonly agentMap = new Map<string, WorktreeInfo>();
  private locked = false;

  public constructor(private readonly repoRoot: string) {
    this.worktreeDir = join(repoRoot, ".agoryx", "worktrees");
  }

  public create(agent: string): WorktreeInfo {
    const existing = this.agentMap.get(agent);
    if (existing && existsSync(existing.path)) {
      return existing;
    }

    this.acquireLock();
    try {
      const wtPath = join(this.worktreeDir, agent);
      if (existsSync(wtPath)) {
        // Worktree directory exists from a previous run; reconcile and return
        this.reconcileOne(wtPath, agent);
        const info = this.agentMap.get(agent);
        if (info) return info;
      }

      mkdirSync(this.worktreeDir, { recursive: true });

      const shortId = randomUUID().slice(0, 8);
      const branch = `agoryx/${agent}-${shortId}`;

      execFileSync(
        "git",
        ["worktree", "add", "-b", branch, wtPath],
        { cwd: this.repoRoot, encoding: "utf-8" },
      );

      const head = this.getHead(wtPath);
      const info: WorktreeInfo = { agent, path: wtPath, branch, head };
      this.agentMap.set(agent, info);
      return info;
    } finally {
      this.releaseLock();
    }
  }

  public list(): WorktreeInfo[] {
    return [...this.agentMap.values()];
  }

  public getForAgent(agent: string): WorktreeInfo | null {
    return this.agentMap.get(agent) ?? null;
  }

  public remove(agent: string, force = false): void {
    const info = this.agentMap.get(agent);
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
        { cwd: this.repoRoot, encoding: "utf-8" },
      );

      // Clean up the branch
      try {
        execFileSync(
          "git",
          ["branch", "-D", info.branch],
          { cwd: this.repoRoot, encoding: "utf-8" },
        );
      } catch {
        // Branch may not exist if it was already deleted
      }

      this.agentMap.delete(agent);
    } finally {
      this.releaseLock();
    }
  }

  public status(): Array<WorktreeInfo & { dirty: boolean; ahead: number; behind: number }> {
    return this.list().map((info) => {
      const dirty = this.isDirty(info.path);
      const { ahead, behind } = this.getAheadBehind(info.path);
      return { ...info, dirty, ahead, behind };
    });
  }

  public ensureClean(agent: string): void {
    const info = this.agentMap.get(agent);
    if (!info) return;
    if (this.isDirty(info.path)) {
      throw new Error(`Worktree for ${agent} has uncommitted changes.`);
    }
  }

  public reconcile(): void {
    const porcelain = this.parseWorktreeList();
    for (const wt of porcelain) {
      // Match paths like .agoryx/worktrees/<agent>
      if (!wt.path.includes(join(".agoryx", "worktrees"))) continue;

      const agent = basename(wt.path);
      if (!agent) continue;

      const info: WorktreeInfo = {
        agent,
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
      };
      this.agentMap.set(agent, info);
    }
  }

  private reconcileOne(path: string, agent: string): void {
    const porcelain = this.parseWorktreeList();
    const wt = porcelain.find((w) => w.path === path);
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
      { cwd: this.repoRoot, encoding: "utf-8" },
    );

    const blocks = output.split("\n\n").filter(Boolean);
    const results: Array<{ path: string; branch: string; head: string }> = [];

    for (const block of blocks) {
      const lines = block.split("\n");
      let path = "";
      let head = "";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        } else if (line.startsWith("HEAD ")) {
          head = line.slice("HEAD ".length);
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

  private getHead(cwd: string): string {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "";
    }
  }

  private isDirty(cwd: string): boolean {
    try {
      const output = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf-8",
      });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  private getAheadBehind(cwd: string): { ahead: number; behind: number } {
    try {
      const defaultBranch = this.detectDefaultBranch();
      const output = execFileSync(
        "git",
        ["rev-list", "--left-right", "--count", `${defaultBranch}...HEAD`],
        { cwd, encoding: "utf-8" },
      );
      const [behind, ahead] = output.trim().split(/\s+/).map(Number);
      return { ahead: ahead ?? 0, behind: behind ?? 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  private detectDefaultBranch(): string {
    try {
      const ref = execFileSync(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD"],
        { cwd: this.repoRoot, encoding: "utf-8" },
      ).trim();
      return ref.replace("refs/remotes/origin/", "");
    } catch {
      return "main";
    }
  }

  private acquireLock(): void {
    if (this.locked) {
      throw new Error("WorktreeManager: concurrent operation in progress");
    }
    this.locked = true;
  }

  private releaseLock(): void {
    this.locked = false;
  }
}
