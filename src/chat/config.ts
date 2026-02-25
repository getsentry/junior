export const botConfig = {
  userName: "junior",
  modelId: process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6",
  routerModelId: process.env.AI_ROUTER_MODEL ?? process.env.AI_MODEL ?? "anthropic/claude-sonnet-4.6"
};

export function hasRedisConfig(): boolean {
  return Boolean(process.env.REDIS_URL);
}
