function buildBotConfig() {
  return {
    userName: process.env.JUNIOR_BOT_NAME ?? "junior",
    modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
    fastModelId: process.env.AI_FAST_MODEL ?? process.env.AI_MODEL ?? "anthropic/claude-haiku-4-5"
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
