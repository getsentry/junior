import type { SlackAdapter } from "@chat-adapter/slack";
import { logWarn } from "@/chat/logging";
import { normalizeSlackConversationId } from "@/chat/slack/client";
import { getSlackClient } from "@/chat/slack/client";
import { truncateStatusText } from "@/chat/runtime/status-format";

const STATUS_PATTERNS = {
  thinking: {
    defaultContext: "…",
    variants: ["Thinking", "Reasoning", "Considering", "Working through"],
  },
  searching: {
    defaultContext: "sources",
    variants: ["Searching", "Scanning", "Probing", "Trawling"],
  },
  reading: {
    defaultContext: "task",
    variants: ["Reading", "Inspecting", "Parsing", "Skimming"],
  },
  reviewing: {
    defaultContext: "results",
    variants: ["Reviewing", "Checking", "Inspecting", "Auditing"],
  },
  loading: {
    defaultContext: "task",
    variants: ["Loading", "Priming", "Booting", "Spinning up"],
  },
  updating: {
    defaultContext: "state",
    variants: ["Updating", "Patching", "Refreshing", "Adjusting"],
  },
  fetching: {
    defaultContext: "sources",
    variants: ["Fetching", "Pulling", "Retrieving", "Loading"],
  },
  creating: {
    defaultContext: "draft",
    variants: ["Creating", "Building", "Assembling", "Generating"],
  },
  listing: {
    defaultContext: "items",
    variants: ["Listing", "Gathering", "Collecting", "Enumerating"],
  },
  posting: {
    defaultContext: "reply",
    variants: ["Posting", "Sending", "Delivering", "Dispatching"],
  },
  adding: {
    defaultContext: "details",
    variants: ["Adding", "Applying", "Attaching", "Dropping in"],
  },
  running: {
    defaultContext: "tasks",
    variants: ["Running", "Executing", "Launching", "Processing"],
  },
} as const;

export type AssistantStatusKind = keyof typeof STATUS_PATTERNS;

export interface AssistantStatusSpec {
  kind: AssistantStatusKind;
  context?: string;
}

/**
 * Slack assistant status transport contract.
 *
 * Slack's `assistant.threads.setStatus` API auto-clears after roughly two
 * minutes if no message is sent, so callers must refresh non-empty statuses
 * periodically during long-running work and clear them explicitly with an
 * empty status when the turn ends.
 */
export interface AssistantStatusTransport {
  /** Best-effort update for the visible assistant status in a Slack thread. */
  setStatus: (
    channelId: string,
    threadTs: string,
    status: string,
    suggestions?: string[],
  ) => Promise<void>;
}

/**
 * Rendered Slack assistant status payload.
 *
 * Statuses are explicit specs (`kind + context`). Specs use one consistent
 * `Verb target` pattern and may rotate verbs within the same kind.
 */
export interface AssistantStatusPresentation {
  key: string;
  hint: string;
  visible: string;
  suggestions?: string[];
}

/** Build a typed assistant status from a stable kind and optional context. */
export function makeAssistantStatus(
  kind: AssistantStatusKind,
  context?: string,
): AssistantStatusSpec {
  return { kind, ...(context ? { context } : {}) };
}

/** Normalize a typed assistant status context before handing it to Slack. */
export function normalizeAssistantStatusText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return truncateStatusText(trimmed.replace(/(?:\.\s*)+$/, "").trim());
}

/**
 * Render a Slack assistant status from a typed spec.
 *
 * Typed specs follow a consistent `Verb target` shape and rotate only within
 * their declared kind.
 */
export function buildAssistantStatusPresentation(args: {
  status: AssistantStatusSpec;
  random?: () => number;
}): AssistantStatusPresentation {
  const random = args.random ?? Math.random;
  const pattern = STATUS_PATTERNS[args.status.kind];
  const context =
    normalizeAssistantStatusText(args.status.context ?? "") ||
    pattern.defaultContext;
  const index = Math.floor(random() * pattern.variants.length);
  const verb = pattern.variants[index] ?? pattern.variants[0];
  const visible = truncateStatusText(`${verb} ${context}`);
  const hint = truncateStatusText(`${pattern.variants[0]} ${context}`);

  return {
    key: `${args.status.kind}:${context}`,
    hint,
    visible,
    suggestions: Array.from(new Set([visible, hint])),
  };
}

/** Create a best-effort Slack adapter transport for assistant status updates. */
export function createSlackAdapterAssistantStatusTransport(args: {
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantStatus">;
}): AssistantStatusTransport {
  const adapter = args.getSlackAdapter() as Pick<
    SlackAdapter,
    "setAssistantStatus" | "withBotToken"
  > & {
    requestContext?: {
      getStore: () => { token?: string } | undefined;
    };
  };
  const boundToken = getSlackAdapterRequestToken(adapter);

  return {
    async setStatus(channelId, threadTs, status, suggestions) {
      const normalizedChannelId = normalizeSlackConversationId(channelId);
      if (!normalizedChannelId) {
        return;
      }
      try {
        await runWithBoundSlackToken(adapter, boundToken, () =>
          adapter.setAssistantStatus(
            normalizedChannelId,
            threadTs,
            status,
            suggestions,
          ),
        );
      } catch (error) {
        logAssistantStatusFailure({
          status,
          error,
          channelId,
          normalizedChannelId,
          threadTs,
        });
      }
    },
  };
}

function getSlackAdapterRequestToken(adapter: {
  requestContext?: {
    getStore: () => { token?: string } | undefined;
  };
}): string | undefined {
  // Slack assistant status updates can be emitted later from debounce/rotation
  // timers. Capture the adapter's current request-scoped token up front so
  // those delayed updates stay pinned to the same workspace installation.
  const token = adapter.requestContext?.getStore()?.token;
  if (typeof token !== "string") {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed || undefined;
}

async function runWithBoundSlackToken<T>(
  adapter: Pick<SlackAdapter, "withBotToken">,
  token: string | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!token) {
    return await task();
  }
  return await adapter.withBotToken(token, task);
}

/**
 * Create a best-effort Web API transport for assistant status updates.
 *
 * This is used by flows that do not have a chat adapter instance handy, such
 * as OAuth resume handlers, but it still follows the same status semantics and
 * `loading_messages` payload shape as the adapter-backed runtime path.
 */
export function createSlackWebApiAssistantStatusTransport(args?: {
  getSlackClient?: typeof getSlackClient;
}): AssistantStatusTransport {
  const getClient = args?.getSlackClient ?? getSlackClient;
  return {
    async setStatus(channelId, threadTs, status, suggestions) {
      const normalizedChannelId = normalizeSlackConversationId(channelId);
      if (!normalizedChannelId) {
        return;
      }
      try {
        await getClient().assistant.threads.setStatus({
          channel_id: normalizedChannelId,
          thread_ts: threadTs,
          status,
          ...(suggestions ? { loading_messages: suggestions } : {}),
        });
      } catch (error) {
        logAssistantStatusFailure({
          status,
          error,
          channelId,
          normalizedChannelId,
          threadTs,
        });
      }
    },
  };
}

function logAssistantStatusFailure(args: {
  status: string;
  error: unknown;
  channelId: string;
  normalizedChannelId: string;
  threadTs: string;
}): void {
  logWarn(
    "assistant_status_update_failed",
    {},
    {
      "app.slack.status_text": args.status || "(clear)",
      "app.slack.channel_id_raw": args.channelId,
      "app.slack.channel_id": args.normalizedChannelId,
      "app.slack.thread_ts": args.threadTs,
      "error.message":
        args.error instanceof Error ? args.error.message : String(args.error),
    },
    `Failed to update assistant status channel=${args.normalizedChannelId} raw=${args.channelId} thread=${args.threadTs}`,
  );
}
