export const botConfig = {
  userName: "junior",
  modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
  routerModelId: process.env.AI_ROUTER_MODEL ?? process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6"
};

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
