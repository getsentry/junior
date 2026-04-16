import type { SlackAdapter } from "@chat-adapter/slack";
import { logWarn } from "@/chat/logging";
import {
  getSlackClient,
  normalizeSlackConversationId,
} from "@/chat/slack/client";
import { normalizeSlackStatusText } from "@/chat/slack/mrkdwn";
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

const STATUS_UPDATE_DEBOUNCE_MS = 1000;
const STATUS_MIN_VISIBLE_MS = 1200;
const STATUS_ROTATION_INTERVAL_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type AssistantStatusPresentation = {
  key: string;
  hint: string;
  visible: string;
  suggestions?: string[];
};

type AssistantStatusKind = keyof typeof STATUS_PATTERNS;

export interface AssistantStatusSpec {
  kind: AssistantStatusKind;
  context?: string;
}

export interface AssistantStatusSession {
  start: () => void;
  stop: () => Promise<void>;
  update: (status: AssistantStatusSpec) => void;
}

/** Build a typed assistant status from a stable kind and optional context. */
export function makeAssistantStatus(
  kind: AssistantStatusKind,
  context?: string,
): AssistantStatusSpec {
  return { kind, ...(context ? { context } : {}) };
}

function buildAssistantStatusPresentation(args: {
  status: AssistantStatusSpec;
  random?: () => number;
}): AssistantStatusPresentation {
  const random = args.random ?? Math.random;
  const pattern = STATUS_PATTERNS[args.status.kind];
  const context =
    normalizeSlackStatusText(args.status.context ?? "") ||
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

/**
 * Create a debounced Slack assistant-status session for a single turn.
 *
 * `start()` and `update()` are intentionally fire-and-forget. Status is a
 * best-effort UX surface, not a turn-execution dependency.
 */
export function createSlackAssistantStatusSession(args: {
  channelId?: string;
  threadTs?: string;
  setStatus: (
    channelId: string,
    threadTs: string,
    status: string,
    suggestions?: string[],
  ) => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  random?: () => number;
}): AssistantStatusSession {
  const now = args.now ?? (() => Date.now());
  const setTimer =
    args.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    args.clearTimer ?? ((timer: TimerHandle) => clearTimeout(timer));
  const random = args.random ?? Math.random;

  let active = false;
  let currentKey = "";
  let currentStatus: AssistantStatusSpec = makeAssistantStatus("thinking");
  let currentVisibleStatus = "";
  let lastStatusAt = 0;
  let pendingStatus: AssistantStatusSpec | null = null;
  let pendingKey = "";
  let pendingTimer: TimerHandle | null = null;
  let rotationTimer: TimerHandle | null = null;
  let inflightStatusUpdate: Promise<void> = Promise.resolve();

  const enqueueStatusUpdate = (task: () => Promise<void>): Promise<void> => {
    const request = inflightStatusUpdate
      .catch(() => undefined)
      .then(async () => {
        await task();
      });
    inflightStatusUpdate = request.catch(() => undefined);
    return request;
  };

  const scheduleRotation = () => {
    if (rotationTimer) {
      clearTimer(rotationTimer);
      rotationTimer = null;
    }

    if (!active || !currentVisibleStatus) {
      return;
    }

    rotationTimer = setTimer(() => {
      rotationTimer = null;
      if (!active || !currentVisibleStatus) {
        return;
      }
      void postRenderedStatus(currentStatus);
    }, STATUS_ROTATION_INTERVAL_MS);
  };

  const postStatus = async (
    text: string,
    suggestions?: string[],
  ): Promise<void> => {
    const channelId = args.channelId;
    const threadTs = args.threadTs;
    if (!channelId || !threadTs) {
      return;
    }
    if (!text && !currentVisibleStatus) {
      return;
    }

    currentVisibleStatus = text;
    lastStatusAt = now();
    scheduleRotation();
    await enqueueStatusUpdate(async () => {
      await args.setStatus(channelId, threadTs, text, suggestions);
    });
  };

  const postRenderedStatus = async (
    status: AssistantStatusSpec,
  ): Promise<void> => {
    const presentation = buildAssistantStatusPresentation({
      status,
      random,
    });
    currentStatus = status;
    currentKey = presentation.key;
    await postStatus(presentation.visible, presentation.suggestions);
  };

  const clearPending = () => {
    if (pendingTimer) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
    pendingKey = "";
  };

  const flushPending = async () => {
    if (!active || !pendingStatus) {
      clearPending();
      return;
    }

    const next = pendingStatus;
    clearPending();
    const nextPresentation = buildAssistantStatusPresentation({
      status: next,
      random,
    });
    if (nextPresentation.key !== currentKey) {
      await postRenderedStatus(next);
    }
  };

  return {
    start() {
      active = true;
      clearPending();
      currentStatus = makeAssistantStatus("thinking");
      currentKey = "";
      void postRenderedStatus(currentStatus);
    },
    async stop() {
      active = false;
      clearPending();
      if (rotationTimer) {
        clearTimer(rotationTimer);
        rotationTimer = null;
      }
      currentKey = "";
      await postStatus("");
    },
    update(status: AssistantStatusSpec) {
      if (!active) {
        return;
      }
      const presentation = buildAssistantStatusPresentation({
        status,
        random,
      });
      if (!presentation.visible) {
        return;
      }
      if (presentation.key === currentKey || presentation.key === pendingKey) {
        return;
      }

      const elapsed = now() - lastStatusAt;
      const waitMs = Math.max(
        STATUS_UPDATE_DEBOUNCE_MS - elapsed,
        STATUS_MIN_VISIBLE_MS - elapsed,
        0,
      );

      if (waitMs <= 0) {
        clearPending();
        void postRenderedStatus(status);
        return;
      }

      pendingStatus = status;
      pendingKey = presentation.key;
      if (pendingTimer) {
        return;
      }

      pendingTimer = setTimer(
        () => {
          pendingTimer = null;
          void flushPending();
        },
        Math.max(1, waitMs),
      );
    },
  };
}

/** Create a Slack adapter-backed assistant status session for a single turn. */
export function createSlackAdapterAssistantStatusSession(args: {
  channelId?: string;
  threadTs?: string;
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantStatus">;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  random?: () => number;
}): AssistantStatusSession {
  const adapter = args.getSlackAdapter() as Pick<
    SlackAdapter,
    "setAssistantStatus" | "withBotToken"
  > & {
    requestContext?: {
      getStore: () => { token?: string } | undefined;
    };
  };
  const boundToken = getSlackAdapterRequestToken(adapter);

  return createSlackAssistantStatusSession({
    channelId: args.channelId,
    threadTs: args.threadTs,
    setStatus: async (channelId, threadTs, status, suggestions) => {
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
    now: args.now,
    setTimer: args.setTimer,
    clearTimer: args.clearTimer,
    random: args.random,
  });
}

/** Create a Web API-backed assistant status session for non-adapter flows. */
export function createSlackWebApiAssistantStatusSession(args: {
  channelId?: string;
  threadTs?: string;
  getSlackClient?: typeof getSlackClient;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  random?: () => number;
}): AssistantStatusSession {
  const getClient = args.getSlackClient ?? getSlackClient;
  return createSlackAssistantStatusSession({
    channelId: args.channelId,
    threadTs: args.threadTs,
    setStatus: async (channelId, threadTs, status, suggestions) => {
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
    now: args.now,
    setTimer: args.setTimer,
    clearTimer: args.clearTimer,
    random: args.random,
  });
}

function getSlackAdapterRequestToken(adapter: {
  requestContext?: {
    getStore: () => { token?: string } | undefined;
  };
}): string | undefined {
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
