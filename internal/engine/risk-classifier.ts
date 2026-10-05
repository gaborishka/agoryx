/**
 * Risk classification for tool approval requests.
 *
 * LOW: read-only operations, safe commands (ls, cat, git status)
 * MEDIUM: file writes, git commits, npm install
 * HIGH: destructive commands (rm, git push --force), network ops, sudo
 */

export type RiskLevel = "low" | "medium" | "high";

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
}

/** Patterns for risk classification */
const HIGH_RISK_PATTERNS: [RegExp, string][] = [
  [/\brm\s+-rf?\b/, "destructive remove command"],
  [/\bgit\s+push\s+.*--force\b/, "force push overwrites remote history"],
  [/\bgit\s+reset\s+--hard\b/, "hard reset discards local changes"],
  [/\bsudo\b/, "elevated privileges"],
  [/\bchmod\s+777\b/, "world-writable permissions"],
  [/\bdrop\s+table\b/i, "destructive SQL operation"],
  [/\bdelete\s+from\b/i, "destructive SQL operation"],
  [/\bcurl\b.*\|\s*sh\b/, "piping remote script to shell"],
  [/\bwget\b.*\|\s*sh\b/, "piping remote script to shell"],
];

const LOW_RISK_PATTERNS: [RegExp, string][] = [
  [/\bls\b/, "directory listing"],
  [/\bcat\b/, "file read"],
  [/\bhead\b/, "file read"],
  [/\btail\b/, "file read"],
  [/\bwc\b/, "word/line count"],
  [/\bgit\s+(status|log|diff|branch|show)\b/, "read-only git operation"],
  [/\bpwd\b/, "print working directory"],
  [/\becho\b/, "echo output"],
  [/\bfind\b.*-name\b/, "file search"],
  [/\bgrep\b/, "text search"],
  [/\btree\b/, "directory tree"],
];

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /\.env\b/,
  /\.ssh\b/,
  /credentials/i,
  /\.aws\b/,
  /\.gnupg\b/,
  /id_rsa/,
  /\.pem$/,
  /secrets?\b/i,
];

/** Classify a command string by risk level. */
export function classifyCommand(command: string): RiskAssessment {
  for (const [pattern, reason] of HIGH_RISK_PATTERNS) {
    if (pattern.test(command)) {
      return { level: "high", reason };
    }
  }
  for (const [pattern, reason] of LOW_RISK_PATTERNS) {
    if (pattern.test(command)) {
      return { level: "low", reason };
    }
  }
  return { level: "medium", reason: "unrecognized command" };
}

/** Classify a file operation by risk level. */
export function classifyFileOp(
  filePath: string,
  kind: "read" | "write" | "delete",
): RiskAssessment {
  // Sensitive paths are always HIGH regardless of operation kind
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return { level: "high", reason: `sensitive path: ${filePath}` };
    }
  }

  switch (kind) {
    case "read":
      return { level: "low", reason: "file read" };
    case "write":
      return { level: "medium", reason: "file write" };
    case "delete":
      return { level: "high", reason: "file delete" };
  }
}

/** Classify a full ApprovalRequest. */
export function classifyApprovalRequest(request: {
  kind: "command" | "file" | "permissions";
  command?: string;
  filePath?: string;
  toolName: string;
}): RiskAssessment {
  if (request.kind === "permissions") {
    return { level: "high", reason: "permissions change requested" };
  }

  if (request.kind === "command" && request.command) {
    return classifyCommand(request.command);
  }

  if (request.kind === "file" && request.filePath) {
    // Infer operation kind from toolName
    const name = request.toolName.toLowerCase();
    let fileKind: "read" | "write" | "delete" = "write";
    if (name.includes("read") || name.includes("view") || name.includes("cat")) {
      fileKind = "read";
    } else if (name.includes("delete") || name.includes("remove") || name.includes("rm")) {
      fileKind = "delete";
    }
    return classifyFileOp(request.filePath, fileKind);
  }

  return { level: "medium", reason: "unknown request type" };
}
