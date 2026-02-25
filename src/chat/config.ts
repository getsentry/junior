export const botConfig = {
  userName: process.env.BOT_USERNAME ?? "junior",
  modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
  slackBotUserId: process.env.SLACK_BOT_USER_ID
};

export function hasRedisConfig(): boolean {
  return Boolean(process.env.REDIS_URL);
}
