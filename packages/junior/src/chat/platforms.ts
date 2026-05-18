export const SUPPORTED_CHAT_PLATFORMS = ["slack", "github"] as const;

export type ChatPlatform = (typeof SUPPORTED_CHAT_PLATFORMS)[number];

export const DEFAULT_CHAT_PLATFORMS: ChatPlatform[] = ["slack"];

/** Validate and normalize the chat ingress platforms enabled for this app. */
export function resolveEnabledChatPlatforms(
  platforms: readonly string[] | undefined,
  optionName = "enabledPlatforms",
): ChatPlatform[] {
  if (platforms === undefined) {
    return [...DEFAULT_CHAT_PLATFORMS];
  }

  const normalized = new Set<ChatPlatform>();
  for (const rawPlatform of platforms) {
    const platform = rawPlatform.trim().toLowerCase();
    if (!platform) {
      continue;
    }
    if (!SUPPORTED_CHAT_PLATFORMS.includes(platform as ChatPlatform)) {
      throw new Error(
        `${optionName} must contain only: ${SUPPORTED_CHAT_PLATFORMS.join(", ")}`,
      );
    }
    normalized.add(platform as ChatPlatform);
  }

  if (normalized.size === 0) {
    throw new Error(
      `${optionName} must contain at least one platform: ${SUPPORTED_CHAT_PLATFORMS.join(", ")}`,
    );
  }

  return [...normalized];
}
