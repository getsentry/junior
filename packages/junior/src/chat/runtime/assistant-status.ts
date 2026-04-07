import type { SlackAdapter } from "@chat-adapter/slack";
import { logWarn } from "@/chat/logging";
import { getSlackClient } from "@/chat/slack/client";
import { truncateStatusText } from "@/chat/runtime/status-format";

const STATUS_PATTERNS = {
  thinking: {
    defaultContext: "task",
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

export type AssistantStatusInput = string | AssistantStatusSpec;

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
 * Statuses are either explicit specs (`kind + context`) or pre-rendered
 * strings. Specs use one consistent `Verb target` pattern and may rotate
 * verbs within the same kind when refreshed.
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

/** Normalize an arbitrary string status before handing it to Slack. */
export function normalizeAssistantStatusText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return truncateStatusText(trimmed.replace(/(?:\.\s*)+$/, "").trim());
}

/**
 * Render a Slack assistant status from either a typed spec or a raw string.
 *
 * Typed specs follow a consistent `Verb target` shape and rotate only within
 * their declared kind. Raw strings are treated as already-rendered statuses.
 */
export function buildAssistantStatusPresentation(args: {
  status: AssistantStatusInput;
  currentVisible?: string;
  random?: () => number;
}): AssistantStatusPresentation {
  if (typeof args.status === "string") {
    const visible = normalizeAssistantStatusText(args.status);
    return {
      key: `text:${visible}`,
      hint: visible,
      visible,
      suggestions: visible ? [visible] : undefined,
    };
  }

  const random = args.random ?? Math.random;
  const pattern = STATUS_PATTERNS[args.status.kind];
  const context =
    normalizeAssistantStatusText(args.status.context ?? "") ||
    pattern.defaultContext;
  const currentVerb = extractLeadingVerb(args.currentVisible);
  const verbs = pattern.variants.filter((variant) => variant !== currentVerb);
  const pool = verbs.length > 0 ? verbs : [...pattern.variants];
  const index = Math.floor(random() * pool.length);
  const verb = pool[index] ?? pattern.variants[0];
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
  return {
    async setStatus(channelId, threadTs, status, suggestions) {
      try {
        await args
          .getSlackAdapter()
          .setAssistantStatus(channelId, threadTs, status, suggestions);
      } catch (error) {
        logAssistantStatusFailure(status, error);
      }
    },
  };
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
      try {
        await getClient().assistant.threads.setStatus({
          channel_id: channelId,
          thread_ts: threadTs,
          status,
          ...(suggestions ? { loading_messages: suggestions } : {}),
        });
      } catch (error) {
        logAssistantStatusFailure(status, error);
      }
    },
  };
}

function extractLeadingVerb(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^([A-Za-z]+)\b/.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function logAssistantStatusFailure(status: string, error: unknown): void {
  logWarn(
    "assistant_status_update_failed",
    {},
    {
      "app.slack.status_text": status || "(clear)",
      "error.message": error instanceof Error ? error.message : String(error),
    },
    "Failed to update assistant status",
  );
}
