/**
 * Structured token usage captured for a single agent turn.
 *
 * Fields are stored individually so renderers can decide whether to display a
 * breakdown or a single aggregate. Providers only populate the counters they
 * report; missing fields mean "not reported" rather than zero.
 */
export interface AgentTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export const AGENT_TURN_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "reasoningTokens",
  "totalTokens",
] as const satisfies readonly (keyof AgentTurnUsage)[];
