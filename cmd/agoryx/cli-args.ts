export const EXIT_USAGE_ERROR = 2;

export type OutputWriter = (line?: string) => void;

export interface OptionSpec {
  long: string;
  short?: string;
  takesValue: boolean;
}

export interface ParsedArgs {
  options: Record<string, string>;
  positionals: string[];
}

export class CliUsageError extends Error {
  public readonly exitCode = EXIT_USAGE_ERROR;

  public constructor(
    message: string,
    public readonly usage?: (write?: OutputWriter) => void,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

const levenshteinDistance = (left: string, right: string): number => {
  const matrix = Array.from(
    { length: left.length + 1 },
    () => new Array<number>(right.length + 1).fill(0),
  );
  for (let i = 0; i <= left.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[left.length][right.length];
};

export const renderUnknownOptionMessage = (
  token: string,
  specs: OptionSpec[],
): string => {
  const candidates = specs.flatMap((spec) => [
    `--${spec.long}`,
    ...(spec.short ? [`-${spec.short}`] : []),
  ]);

  let bestCandidate: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(token, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate && bestDistance <= 3) {
    return `Unknown option '${token}'. Did you mean '${bestCandidate}'?`;
  }
  return `Unknown option '${token}'.`;
};

export const renderUnknownCommandMessage = (
  command: string,
  availableCommands: readonly string[],
): string => {
  let bestCandidate: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of availableCommands) {
    const distance = levenshteinDistance(command, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate && bestDistance <= 3) {
    return `Unknown command '${command}'. Did you mean '${bestCandidate}'?`;
  }
  return `Unknown command '${command}'.`;
};

const parseCliArgs = (args: string[], specs: OptionSpec[]): ParsedArgs => {
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  const byLong = new Map(specs.map((spec) => [spec.long, spec] as const));
  const byShort = new Map(
    specs
      .filter((spec): spec is OptionSpec & { short: string } => Boolean(spec.short))
      .map((spec) => [spec.short, spec] as const),
  );

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }

    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const withoutPrefix = token.slice(2);
      const equalIndex = withoutPrefix.indexOf("=");
      const key = equalIndex >= 0 ? withoutPrefix.slice(0, equalIndex) : withoutPrefix;
      const inlineValue = equalIndex >= 0 ? withoutPrefix.slice(equalIndex + 1) : undefined;
      const spec = byLong.get(key);
      if (!spec) {
        throw new CliUsageError(
          renderUnknownOptionMessage(`--${key}`, specs),
          undefined,
          "Run with --help to see available options.",
        );
      }

      if (spec.takesValue) {
        if (inlineValue != null) {
          options[spec.long] = inlineValue;
          continue;
        }

        const next = args[i + 1];
        if (next == null || (next !== "-" && next.startsWith("-"))) {
          throw new CliUsageError(
            `Option --${spec.long} requires a value.`,
            undefined,
            `Provide a value, for example: --${spec.long} <value>.`,
          );
        }
        options[spec.long] = next;
        i += 1;
        continue;
      }

      if (inlineValue != null) {
        throw new CliUsageError(
          `Option --${spec.long} does not take a value.`,
          undefined,
          `Remove the value and pass only --${spec.long}.`,
        );
      }
      options[spec.long] = "true";
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const short = token.slice(1);
      if (short.length !== 1) {
        throw new CliUsageError(
          renderUnknownOptionMessage(token, specs),
          undefined,
          "Run with --help to see available options.",
        );
      }
      const spec = byShort.get(short);
      if (!spec) {
        throw new CliUsageError(
          renderUnknownOptionMessage(token, specs),
          undefined,
          "Run with --help to see available options.",
        );
      }
      if (spec.takesValue) {
        const next = args[i + 1];
        if (next == null || (next !== "-" && next.startsWith("-"))) {
          throw new CliUsageError(
            `Option -${short} requires a value.`,
            undefined,
            `Provide a value, for example: -${short} <value>.`,
          );
        }
        options[spec.long] = next;
        i += 1;
      } else {
        options[spec.long] = "true";
      }
      continue;
    }

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
  }
  return { options, positionals };
};

export const parseCliArgsOrThrow = (
  args: string[],
  specs: OptionSpec[],
  usage: (write?: OutputWriter) => void,
): ParsedArgs => {
  try {
    return parseCliArgs(args, specs);
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw new CliUsageError(error.message, usage, error.hint);
    }
    throw error;
  }
};
