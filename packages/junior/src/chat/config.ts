import { toOptionalTrimmed } from "@/chat/optional-string";

const MIN_AGENT_TURN_TIMEOUT_MS = 10 * 1000;
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_FUNCTION_MAX_DURATION_SECONDS = 800;
/** Buffer between the Vercel function timeout and the agent turn timeout,
 *  so the agent can abort and post a failure reply before Vercel kills it. */
const FUNCTION_TIMEOUT_BUFFER_SECONDS = 20;

export interface BotConfig {
  fastModelId: string;
  modelId: string;
  turnTimeoutMs: number;
  userName: string;
}

export interface ChatConfig {
  bot: BotConfig;
  functionMaxDurationSeconds: number;
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

function resolveFunctionMaxDurationSeconds(env: NodeJS.ProcessEnv): number {
  const raw =
    env.FUNCTION_MAX_DURATION_SECONDS ??
    env.QUEUE_CALLBACK_MAX_DURATION_SECONDS;
  const value = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(value) || value <= 0) {
    return DEFAULT_FUNCTION_MAX_DURATION_SECONDS;
  }
  return value;
}

function resolveMaxTurnTimeoutMs(functionMaxDurationSeconds: number): number {
  const budgetSeconds =
    functionMaxDurationSeconds - FUNCTION_TIMEOUT_BUFFER_SECONDS;
  return Math.max(MIN_AGENT_TURN_TIMEOUT_MS, budgetSeconds * 1000);
}

function readBotConfig(env: NodeJS.ProcessEnv): BotConfig {
  const functionMaxDurationSeconds = resolveFunctionMaxDurationSeconds(env);
  const maxTurnTimeoutMs = resolveMaxTurnTimeoutMs(functionMaxDurationSeconds);

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

/** Parse all chat configuration from environment variables. */
export function readChatConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChatConfig {
  return {
    bot: readBotConfig(env),
    functionMaxDurationSeconds: resolveFunctionMaxDurationSeconds(env),
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

/** Chat configuration parsed once at module load from the process environment. */
const chatConfig: ChatConfig = readChatConfig(process.env);

/** Return the chat configuration (parsed once at startup). */
export function getChatConfig(): ChatConfig {
  return chatConfig;
}

/** Bot configuration derived from environment at module load. */
export const botConfig: BotConfig = chatConfig.bot;

export function getSlackBotToken(): string | undefined {
  return chatConfig.slack.botToken;
}

export function getSlackSigningSecret(): string | undefined {
  return chatConfig.slack.signingSecret;
}

export function getSlackClientId(): string | undefined {
  return chatConfig.slack.clientId;
}

export function getSlackClientSecret(): string | undefined {
  return chatConfig.slack.clientSecret;
}

export function hasRedisConfig(): boolean {
  return Boolean(chatConfig.state.redisUrl);
}

// ---------------------------------------------------------------------------
// Runtime metadata
// ---------------------------------------------------------------------------

export interface RuntimeMetadata {
  version?: string;
}

/** Return runtime metadata (version from deploy environment). */
export function getRuntimeMetadata(): RuntimeMetadata {
  return {
    version: toOptionalTrimmed(process.env.VERCEL_GIT_COMMIT_SHA),
  };
}
