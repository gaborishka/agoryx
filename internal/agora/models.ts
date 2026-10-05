import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentModels, KindModels, ModelChoice } from "./types.js";

/**
 * The models and effort levels each CLI offers, so the human can pick them for an agent. Read from the
 * CLIs themselves where they say it (Claude's --help, Codex's own model cache); the human can still type
 * any name the CLI takes.
 */

export type { AgentModels, KindModels, ModelChoice };

const CLAUDE_MODELS: ModelChoice[] = [
  { id: "fable", label: "Fable" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];

const help = (bin: string): Promise<string> =>
  new Promise((resolve) => {
    execFile(bin, ["--help"], { timeout: 8000, maxBuffer: 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? "")));
  });

/** "--effort <level>  … (low, medium, high, xhigh, max)" in Claude's help. */
export const claudeEffortsFromHelp = (text: string): string[] | null => {
  const match = /--effort <[^>]+>[\s\S]*?\(([a-z, ]+)\)/.exec(text);
  const levels = match?.[1]?.split(",").map((level) => level.trim()).filter(Boolean);
  return levels?.length ? levels : null;
};

export const codexModelsFromCache = (raw: unknown): ModelChoice[] => {
  const list = (raw as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const slug = typeof entry?.slug === "string" ? entry.slug : null;
    if (!slug || (entry.visibility && entry.visibility !== "list")) return [];
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((level: { effort?: unknown }) => level?.effort).filter((level: unknown): level is string => typeof level === "string")
      : undefined;
    return [
      {
        id: slug,
        label: typeof entry.display_name === "string" ? entry.display_name : slug,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(efforts?.length ? { efforts } : {}),
        ...(typeof entry.default_reasoning_level === "string" ? { defaultEffort: entry.default_reasoning_level } : {}),
      },
    ];
  });
};

let claudeEfforts: Promise<string[]> | null = null;

export const agentModels = async (env: NodeJS.ProcessEnv = process.env): Promise<AgentModels> => {
  claudeEfforts ??= help(env.AGORYX_CLAUDE_BIN || "claude").then((text) => claudeEffortsFromHelp(text) ?? CLAUDE_EFFORTS);
  let codex: ModelChoice[] = [];
  try {
    const home = env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex");
    codex = codexModelsFromCache(JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")));
  } catch {
    // Codex has not fetched its models yet: the human types a name.
  }
  const codexEfforts = [...new Set(codex.flatMap((model) => model.efforts ?? []))];
  return {
    claude: { models: CLAUDE_MODELS, efforts: await claudeEfforts },
    codex: { models: codex, efforts: codexEfforts.length ? codexEfforts : CODEX_EFFORTS },
  };
};
