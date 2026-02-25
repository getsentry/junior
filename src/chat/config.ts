function readBooleanFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

export const botConfig = {
  userName: process.env.BOT_USERNAME ?? "junior",
  modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
  slackBotUserId: process.env.SLACK_BOT_USER_ID,
  progressFallbackEnabled: readBooleanFlag("JUNIOR_PROGRESS_FALLBACK_ENABLED", false)
};

export function hasRedisConfig(): boolean {
  return Boolean(process.env.REDIS_URL);
}
