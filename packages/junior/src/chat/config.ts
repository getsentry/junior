const MIN_AGENT_TURN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_QUEUE_CALLBACK_MAX_DURATION_SECONDS = 800;
const TURN_TIMEOUT_BUFFER_SECONDS = 20;

function parseAgentTurnTimeoutMs(rawValue: string | undefined, maxTimeoutMs: number): number {
  const value = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(value)) {
    return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, Math.min(DEFAULT_AGENT_TURN_TIMEOUT_MS, maxTimeoutMs));
  }
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, Math.min(value, maxTimeoutMs));
}

function resolveQueueCallbackMaxDurationSeconds(): number {
  const value = Number.parseInt(process.env.QUEUE_CALLBACK_MAX_DURATION_SECONDS ?? "", 10);
  if (Number.isNaN(value) || value <= 0) {
    return DEFAULT_QUEUE_CALLBACK_MAX_DURATION_SECONDS;
  }
  return value;
}

function resolveMaxTurnTimeoutMs(queueCallbackMaxDurationSeconds: number): number {
  const budgetSeconds = queueCallbackMaxDurationSeconds - TURN_TIMEOUT_BUFFER_SECONDS;
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, budgetSeconds * 1000);
}

function buildBotConfig() {
  const queueCallbackMaxDurationSeconds = resolveQueueCallbackMaxDurationSeconds();
  const maxTurnTimeoutMs = resolveMaxTurnTimeoutMs(queueCallbackMaxDurationSeconds);
  return {
    userName: process.env.JUNIOR_BOT_NAME ?? "junior",
    modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
    fastModelId: process.env.AI_FAST_MODEL ?? process.env.AI_MODEL ?? "anthropic/claude-haiku-4.5",
    turnTimeoutMs: parseAgentTurnTimeoutMs(process.env.AGENT_TURN_TIMEOUT_MS, maxTurnTimeoutMs)
  };
}

export const botConfig = buildBotConfig();

function toOptionalTrimmed(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getSlackBotToken(): string | undefined {
  return toOptionalTrimmed(process.env.SLACK_BOT_TOKEN) ?? toOptionalTrimmed(process.env.SLACK_BOT_USER_TOKEN);
}

export function getSlackSigningSecret(): string | undefined {
  return toOptionalTrimmed(process.env.SLACK_SIGNING_SECRET);
}

export function getSlackClientId(): string | undefined {
  return toOptionalTrimmed(process.env.SLACK_CLIENT_ID);
}

export function getSlackClientSecret(): string | undefined {
  return toOptionalTrimmed(process.env.SLACK_CLIENT_SECRET);
}

export function hasRedisConfig(): boolean {
  return Boolean(process.env.REDIS_URL);
}
