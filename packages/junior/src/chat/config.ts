const MIN_AGENT_TURN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_QUEUE_CALLBACK_MAX_DURATION_SECONDS = 800;
const TURN_TIMEOUT_BUFFER_SECONDS = 20;

export interface BotConfig {
  fastModelId: string;
  modelId: string;
  turnTimeoutMs: number;
  userName: string;
}

export interface ChatConfig {
  bot: BotConfig;
  queue: {
    callbackMaxDurationSeconds: number;
  };
  slack: {
    botToken?: string;
    clientId?: string;
    clientSecret?: string;
    signingSecret?: string;
  };
  state: {
    adapter: "memory" | "redis";
    redisUrl?: string;
  };
}

function parseAgentTurnTimeoutMs(
  rawValue: string | undefined,
  maxTimeoutMs: number,
): number {
  const value = Number.parseInt(rawValue ?? "", 10);
  if (Number.isNaN(value)) {
    return Math.max(
      MIN_AGENT_TURN_TIMEOUT_MS,
      Math.min(DEFAULT_AGENT_TURN_TIMEOUT_MS, maxTimeoutMs),
    );
  }
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, Math.min(value, maxTimeoutMs));
}

function resolveQueueCallbackMaxDurationSeconds(
  env: NodeJS.ProcessEnv,
): number {
  const value = Number.parseInt(
    env.QUEUE_CALLBACK_MAX_DURATION_SECONDS ?? "",
    10,
  );
  if (Number.isNaN(value) || value <= 0) {
    return DEFAULT_QUEUE_CALLBACK_MAX_DURATION_SECONDS;
  }
  return value;
}

function resolveMaxTurnTimeoutMs(
  queueCallbackMaxDurationSeconds: number,
): number {
  const budgetSeconds =
    queueCallbackMaxDurationSeconds - TURN_TIMEOUT_BUFFER_SECONDS;
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, budgetSeconds * 1000);
}

function toOptionalTrimmed(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBotConfig(env: NodeJS.ProcessEnv): BotConfig {
  const queueCallbackMaxDurationSeconds =
    resolveQueueCallbackMaxDurationSeconds(env);
  const maxTurnTimeoutMs = resolveMaxTurnTimeoutMs(
    queueCallbackMaxDurationSeconds,
  );

  return {
    userName: env.JUNIOR_BOT_NAME ?? "junior",
    modelId: env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
    fastModelId:
      env.AI_FAST_MODEL ?? env.AI_MODEL ?? "anthropic/claude-haiku-4.5",
    turnTimeoutMs: parseAgentTurnTimeoutMs(
      env.AGENT_TURN_TIMEOUT_MS,
      maxTurnTimeoutMs,
    ),
  };
}

export function readChatConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChatConfig {
  return {
    bot: readBotConfig(env),
    queue: {
      callbackMaxDurationSeconds: resolveQueueCallbackMaxDurationSeconds(env),
    },
    slack: {
      botToken:
        toOptionalTrimmed(env.SLACK_BOT_TOKEN) ??
        toOptionalTrimmed(env.SLACK_BOT_USER_TOKEN),
      signingSecret: toOptionalTrimmed(env.SLACK_SIGNING_SECRET),
      clientId: toOptionalTrimmed(env.SLACK_CLIENT_ID),
      clientSecret: toOptionalTrimmed(env.SLACK_CLIENT_SECRET),
    },
    state: {
      adapter:
        env.JUNIOR_STATE_ADAPTER?.trim().toLowerCase() === "memory"
          ? "memory"
          : "redis",
      redisUrl: toOptionalTrimmed(env.REDIS_URL),
    },
  };
}

export function getChatConfig(): ChatConfig {
  return readChatConfig(process.env);
}

export const botConfig = {
  get userName(): string {
    return getChatConfig().bot.userName;
  },
  get modelId(): string {
    return getChatConfig().bot.modelId;
  },
  get fastModelId(): string {
    return getChatConfig().bot.fastModelId;
  },
  get turnTimeoutMs(): number {
    return getChatConfig().bot.turnTimeoutMs;
  },
} satisfies BotConfig;

export function getSlackBotToken(): string | undefined {
  return getChatConfig().slack.botToken;
}

export function getSlackSigningSecret(): string | undefined {
  return getChatConfig().slack.signingSecret;
}

export function getSlackClientId(): string | undefined {
  return getChatConfig().slack.clientId;
}

export function getSlackClientSecret(): string | undefined {
  return getChatConfig().slack.clientSecret;
}

export function hasRedisConfig(): boolean {
  return Boolean(getChatConfig().state.redisUrl);
}
