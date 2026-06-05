import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { createTestChatRuntime } from "./chat-runtime";
import type { FakeSlackAdapter } from "./slack-harness";

const emptyThreadReplies = async () => [];

/** Create a Slack runtime harness with deterministic empty thread hydration. */
export function createSlackBehaviorRuntime(
  args: {
    services?: JuniorRuntimeServiceOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const services = args.services ?? {};
  return createTestChatRuntime({
    slackAdapter: args.slackAdapter,
    services: {
      ...services,
      visionContext: {
        listThreadReplies: emptyThreadReplies,
        ...(services.visionContext ?? {}),
      },
    },
  });
}

/** Extract user-visible text from a fake Slack post value. */
export function postedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "string") {
      return raw;
    }
  }

  return String(value);
}

/** Read persisted conversation messages from a fake Slack thread state. */
export function conversationMessages(thread: {
  getState: () => Record<string, unknown>;
}): Array<{ id?: string; text?: string }> {
  const state = thread.getState() as {
    conversation?: {
      messages?: Array<{ id?: string; text?: string }>;
    };
  };
  return state.conversation?.messages ?? [];
}

/** Check whether any fake Slack post contains the expected visible text. */
export function threadHasPostText(
  thread: { posts: unknown[] },
  text: string,
): boolean {
  return thread.posts.some((post) => postedText(post).includes(text));
}
