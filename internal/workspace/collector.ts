import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface WorkspaceConfig {
  enabled: boolean;
  maxContextTokens: number;
  statusLines: number;
  diffLines: number;
  treeLines: number;
  pinnedDocBytesPerFile: number;
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  enabled: true,
  maxContextTokens: 3000,
  statusLines: 50,
  diffLines: 30,
  treeLines: 200,
  pinnedDocBytesPerFile: 4096,
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
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(0, maxLines).join("\n");
}

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export class WorkspaceCollector {
  constructor(private readonly config: WorkspaceConfig) {}

  public collectAlwaysOn(cwd: string, pinnedDocPaths?: string[]): AlwaysOnContext {
    try {
      // Verify this is a git repo
      gitExec(["rev-parse", "--is-inside-work-tree"], cwd);
    } catch {
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
      const pinnedDocs = this.loadPinnedDocs(pinnedDocPaths ?? []);

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
      try {
        const defaultBranch = this.detectDefaultBranch(cwd);
        branchDiffStat = gitExec(["diff", "--stat", `${defaultBranch}...HEAD`], cwd);
      } catch {
        // No remote or single-branch repo
      }
      return { recentLog, branchDiffStat };
    } catch {
      return { recentLog: "", branchDiffStat: "" };
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

    return parts.join("\n");
  }

  private getBranch(cwd: string): string {
    try {
      return gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    } catch {
      return "";
    }
  }

  private detectDefaultBranch(cwd: string): string {
    try {
      const ref = gitExec(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
      return ref.replace("refs/remotes/origin/", "");
    } catch {
      return "main";
    }
  }

  private loadPinnedDocs(paths: string[]): PinnedDoc[] {
    const docs: PinnedDoc[] = [];
    for (const path of paths) {
      try {
        const raw = readFileSync(path, "utf-8");
        const limit = this.config.pinnedDocBytesPerFile;
        if (raw.length > limit) {
          docs.push({ path, content: raw.slice(0, limit), truncated: true });
        } else {
          docs.push({ path, content: raw, truncated: false });
        }
      } catch {
        // File doesn't exist or can't be read — skip
      }
    }
    return docs;
  }
}
