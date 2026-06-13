import { vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

interface SlackImageConversationStateArgs {
  messages?: unknown[];
  vision?: {
    backfillCompletedAtMs?: number;
    byFileId?: Record<string, unknown>;
  };
}

/** Create a Slack runtime after applying image-hydration environment flags. */
export async function createSlackImageRuntime(
  args: Parameters<typeof import("../chat-runtime").createTestChatRuntime>[0],
  env: NodeJS.ProcessEnv = {},
) {
  process.env = {
    ...ORIGINAL_ENV,
    AI_VISION_MODEL: "",
    SLACK_BOT_TOKEN: "",
    SLACK_BOT_USER_TOKEN: "",
    ...env,
  };
  vi.resetModules();
  const { createTestChatRuntime } = await import("../chat-runtime");
  return createTestChatRuntime(args);
}

/** Reset modules, mocks, and env mutations used by image-hydration tests. */
export function resetSlackImageRuntimeEnv(): void {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
}

/** Build persisted conversation state used by Slack image hydration tests. */
export function createSlackImageConversationState(
  args: SlackImageConversationStateArgs = {},
) {
  const messages = args.messages ?? [];
  return {
    conversation: {
      schemaVersion: 1,
      messages,
      compactions: [],
      backfill: {
        completedAtMs: 1_700_000_000_000,
        source: "recent_messages",
      },
      processing: {},
      stats: {
        estimatedContextTokens: 0,
        totalMessageCount: messages.length,
        compactedMessageCount: 0,
        updatedAtMs: 1_700_000_000_000,
      },
      vision: {
        byFileId: {},
        ...(args.vision ?? {}),
      },
    },
  };
}
