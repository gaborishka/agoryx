import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface WorkspaceConfig {
  enabled: boolean;
  maxContextTokens: number;
  statusLines: number;
  diffLines: number;
  treeLines: number;
  pinnedDocCharsPerFile: number;
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  enabled: true,
  maxContextTokens: 3000,
  statusLines: 50,
  diffLines: 30,
  treeLines: 200,
  pinnedDocCharsPerFile: 4096,
};

export interface PinnedDoc {
  path: string;
  content: string;
  truncated: boolean;
}

export interface AlwaysOnContext {
  branch: string;
  status: string;
  stagedDiff: string;
  unstagedDiff: string;
  tree: string;
  pinnedDocs: PinnedDoc[];
  unavailable: string | null;
}

export interface OnDemandContext {
  recentLog: string;
  branchDiffStat: string;
  unavailable: string | null;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n");
}

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export class WorkspaceCollector {
  constructor(private readonly config: WorkspaceConfig) {}

  public collectAlwaysOn(cwd: string, pinnedDocPaths?: string[]): AlwaysOnContext {
    try {
      // Verify this is a git repo
      gitExec(["rev-parse", "--is-inside-work-tree"], cwd);
    } catch (error: unknown) {
      this.logWorkspaceWarning(`collectAlwaysOn repo check failed for '${cwd}'`, error);
      return {
        branch: "",
        status: "",
        stagedDiff: "",
        unstagedDiff: "",
        tree: "",
        pinnedDocs: [],
        unavailable: `not a git repository: ${cwd}`,
      };
    }

    try {
      const branch = this.getBranch(cwd);
      const status = truncateLines(
        gitExec(["status", "--porcelain"], cwd),
        this.config.statusLines,
      );
      const stagedDiff = truncateLines(
        gitExec(["diff", "--cached"], cwd),
        this.config.diffLines,
      );
      const unstagedDiff = truncateLines(
        gitExec(["diff"], cwd),
        this.config.diffLines,
      );
      const tree = truncateLines(
        gitExec(["ls-files"], cwd),
        this.config.treeLines,
      );
      const pinnedDocs = this.loadPinnedDocs(pinnedDocPaths ?? [], cwd);

      return {
        branch,
        status,
        stagedDiff,
        unstagedDiff,
        tree,
        pinnedDocs,
        unavailable: null,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logWorkspaceWarning(`collectAlwaysOn failed for '${cwd}'`, err);
      return {
        branch: "",
        status: "",
        stagedDiff: "",
        unstagedDiff: "",
        tree: "",
        pinnedDocs: [],
        unavailable: detail,
      };
    }
  }

  public collectOnDemand(cwd: string): OnDemandContext {
    try {
      const recentLog = gitExec(["log", "--oneline", "-20"], cwd);
      let branchDiffStat = "";
      let unavailable: string | null = null;
      try {
        const defaultBranch = this.detectDefaultBranch(cwd);
        if (!defaultBranch) {
          unavailable = "default branch is unavailable";
        } else {
          branchDiffStat = gitExec(["diff", "--stat", `${defaultBranch}...HEAD`], cwd);
        }
      } catch (error: unknown) {
        unavailable = error instanceof Error ? error.message : String(error);
        this.logWorkspaceWarning(
          `collectOnDemand branch diff stat unavailable for '${cwd}'`,
          error,
        );
      }
      return { recentLog, branchDiffStat, unavailable };
    } catch (error: unknown) {
      const unavailable = error instanceof Error ? error.message : String(error);
      this.logWorkspaceWarning(`collectOnDemand failed for '${cwd}'`, error);
      return { recentLog: "", branchDiffStat: "", unavailable };
    }
  }

  public format(ctx: AlwaysOnContext): string {
    if (ctx.unavailable) {
      return `[Workspace unavailable: ${ctx.unavailable}]`;
    }

    const parts: string[] = ["[Workspace]"];

    if (ctx.branch) {
      parts.push(`Branch: ${ctx.branch}`);
    }

    if (ctx.status) {
      parts.push("", "Status:", ctx.status);
    }

    if (ctx.stagedDiff) {
      parts.push("", "Staged:", ctx.stagedDiff);
    }

    if (ctx.unstagedDiff) {
      parts.push("", "Unstaged:", ctx.unstagedDiff);
    }

    if (ctx.tree) {
      parts.push("", "Files:", ctx.tree);
    }

    if (ctx.pinnedDocs.length > 0) {
      parts.push("");
      for (const doc of ctx.pinnedDocs) {
        parts.push(`[Pinned doc: ${doc.path}]`);
        parts.push(doc.content);
        if (doc.truncated) {
          parts.push("[truncated]");
        }
      }
    }

    return parts.join("\n");
  }

  public formatFull(alwaysOn: AlwaysOnContext, onDemand: OnDemandContext): string {
    const base = this.format(alwaysOn);
    if (alwaysOn.unavailable) return base;

    const parts: string[] = [base];

    if (onDemand.recentLog) {
      parts.push("", "Recent commits:", onDemand.recentLog);
    }

    if (onDemand.branchDiffStat) {
      parts.push("", "Branch diff stat:", onDemand.branchDiffStat);
    }

    if (onDemand.unavailable) {
      parts.push("", `[Workspace on-demand unavailable: ${onDemand.unavailable}]`);
    }

    return parts.join("\n");
  }

  private getBranch(cwd: string): string {
    try {
      return gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    } catch (error: unknown) {
      this.logWorkspaceWarning(`failed to read branch for '${cwd}'`, error);
      return "";
    }
  }

  private detectDefaultBranch(cwd: string): string | null {
    try {
      const ref = gitExec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
      return ref.replace("refs/remotes/origin/", "");
    } catch {
      for (const candidate of ["main", "master"]) {
        if (this.hasLocalBranch(cwd, candidate)) {
          return candidate;
        }
      }

      try {
        const branch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
        if (branch && branch !== "HEAD") {
          return branch;
        }
      } catch {
        // no-op; handled below
      }

      this.logWorkspaceWarning(
        `failed to detect default branch for '${cwd}'`,
        "origin/HEAD missing and no local fallback branch found",
      );
      return null;
    }
  }

  private hasLocalBranch(cwd: string, branch: string): boolean {
    try {
      gitExec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
      return true;
    } catch {
      return false;
    }
  }

  private loadPinnedDocs(paths: string[], rootCwd: string): PinnedDoc[] {
    const docs: PinnedDoc[] = [];
    for (const configuredPath of paths) {
      const resolvedPath = resolve(rootCwd, configuredPath);
      if (!this.isWithinWorkspaceRoot(resolvedPath, rootCwd)) {
        this.logWorkspaceWarning(
          `skipping pinned doc outside workspace root: '${configuredPath}'`,
          `resolved=${resolvedPath}, root=${resolve(rootCwd)}`,
        );
        continue;
      }
      try {
        const raw = readFileSync(resolvedPath, "utf-8");
        const limit = this.config.pinnedDocCharsPerFile;
        if (raw.length > limit) {
          docs.push({ path: configuredPath, content: raw.slice(0, limit), truncated: true });
        } else {
          docs.push({ path: configuredPath, content: raw, truncated: false });
        }
      } catch (error: unknown) {
        this.logWorkspaceWarning(
          `failed to read pinned doc '${configuredPath}'`,
          error,
        );
      }
    }
    return docs;
  }

  private isWithinWorkspaceRoot(candidatePath: string, rootCwd: string): boolean {
    const normalizedRoot = this.normalizePathForRootCheck(rootCwd);
    const normalizedCandidate = this.normalizePathForRootCheck(candidatePath);
    if (normalizedCandidate === normalizedRoot) {
      return true;
    }
    const rootPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedCandidate.startsWith(rootPrefix);
  }

  private normalizePathForRootCheck(path: string): string {
    const resolvedPath = resolve(path);
    try {
      return realpathSync(resolvedPath).replace(/\\/g, "/");
    } catch {
      return resolvedPath.replace(/\\/g, "/");
    }
  }

  private logWorkspaceWarning(context: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[workspace] ${context}: ${detail}`);
  }
}
