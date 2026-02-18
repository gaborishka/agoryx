export type EngineLogLevel = "debug" | "info" | "warn" | "error";

export interface EngineLogger {
  log(level: EngineLogLevel, event: string, fields?: Record<string, unknown>): void;
}

const LEVEL_WEIGHT: Record<EngineLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface ConsoleEngineLoggerOptions {
  minLevel?: EngineLogLevel;
  sink?: (line: string) => void;
}

export class ConsoleEngineLogger implements EngineLogger {
  private readonly minLevel: EngineLogLevel;
  private readonly sink: (line: string) => void;

  public constructor(options: ConsoleEngineLoggerOptions = {}) {
    this.minLevel = options.minLevel ?? "warn";
    this.sink = options.sink ?? console.error;
  }

  public log(level: EngineLogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) {
      return;
    }

    this.sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...fields,
      }),
    );
  }
}

export class NullEngineLogger implements EngineLogger {
  public log(): void {
    // Intentionally empty.
  }
}

export const createDefaultEngineLogger = (): EngineLogger => {
  const level = process.env["AGORYX_ENGINE_LOG"]?.trim().toLowerCase() as EngineLogLevel | undefined;
  if (!level || !(level in LEVEL_WEIGHT)) {
    return new NullEngineLogger();
  }
  return new ConsoleEngineLogger({ minLevel: level });
};
