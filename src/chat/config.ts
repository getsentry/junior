import { loadHomeConfig } from "@/chat/home";

function buildBotConfig() {
  const home = loadHomeConfig();
  return {
    userName: home.bot.name,
    modelId: process.env.AI_MODEL ?? home.ai.model,
    fastModelId: process.env.AI_FAST_MODEL ?? home.ai.fast_model
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
