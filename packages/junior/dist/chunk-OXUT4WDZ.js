// src/chat/config.ts
function buildBotConfig() {
  return {
    userName: process.env.JUNIOR_BOT_NAME ?? "junior",
    modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
    fastModelId: process.env.AI_FAST_MODEL ?? process.env.AI_MODEL ?? "anthropic/claude-haiku-4-5"
  };
}
var botConfig = buildBotConfig();
function toOptionalTrimmed(value) {
  if (!value) {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function getSlackBotToken() {
  return toOptionalTrimmed(process.env.SLACK_BOT_TOKEN) ?? toOptionalTrimmed(process.env.SLACK_BOT_USER_TOKEN);
}
function getSlackSigningSecret() {
  return toOptionalTrimmed(process.env.SLACK_SIGNING_SECRET);
}
function getSlackClientId() {
  return toOptionalTrimmed(process.env.SLACK_CLIENT_ID);
}
function getSlackClientSecret() {
  return toOptionalTrimmed(process.env.SLACK_CLIENT_SECRET);
}
function hasRedisConfig() {
  return Boolean(process.env.REDIS_URL);
}

export {
  botConfig,
  getSlackBotToken,
  getSlackSigningSecret,
  getSlackClientId,
  getSlackClientSecret,
  hasRedisConfig
};
