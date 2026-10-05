export interface AutonomyConfig {
  enabled: boolean;
  maxAgentTurns: number;
}

export class AutonomyGuard {
  private turns = 0;

  public constructor(private readonly config: AutonomyConfig) {}

  public registerAgentTurn(): boolean {
    if (!this.config.enabled) {
      return false;
    }
    this.turns += 1;
    return this.turns <= this.config.maxAgentTurns;
  }

  public reset(): void {
    this.turns = 0;
  }

  public status(): { enabled: boolean; turns: number; maxAgentTurns: number } {
    return {
      enabled: this.config.enabled,
      turns: this.turns,
      maxAgentTurns: this.config.maxAgentTurns,
    };
  }
}
