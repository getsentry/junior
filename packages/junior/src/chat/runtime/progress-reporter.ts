import {
  buildAssistantStatusPresentation,
  makeAssistantStatus,
  normalizeAssistantStatusText,
  type AssistantStatusInput,
  type AssistantStatusTransport,
} from "@/chat/runtime/assistant-status";

const STATUS_UPDATE_DEBOUNCE_MS = 1000;
const STATUS_MIN_VISIBLE_MS = 1200;
const STATUS_ROTATION_INTERVAL_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ProgressReporter {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setStatus: (status: AssistantStatusInput) => Promise<void>;
}

/**
 * Create a debounced assistant-status reporter for long-running Slack turns.
 *
 * The runtime emits semantic hints such as tool or sandbox phases. This
 * reporter owns the Slack-specific lifecycle on top of those hints:
 * start with a non-empty status, debounce rapid phase changes, refresh the
 * status before Slack's `assistant.threads.setStatus` timeout window makes it
 * disappear, and clear the status explicitly with `""` when the turn stops.
 */
export function createProgressReporter(args: {
  channelId?: string;
  threadTs?: string;
  transport: AssistantStatusTransport;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  random?: () => number;
}): ProgressReporter {
  const now = args.now ?? (() => Date.now());
  const setTimer =
    args.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    args.clearTimer ?? ((timer: TimerHandle) => clearTimeout(timer));
  const random = args.random ?? Math.random;

  let active = false;
  let currentKey = "";
  let currentStatus: AssistantStatusInput = makeAssistantStatus("thinking");
  let currentVisibleStatus = "";
  let lastStatusAt = 0;
  let pendingStatus: AssistantStatusInput | null = null;
  let pendingKey = "";
  let pendingTimer: TimerHandle | null = null;
  let rotationTimer: TimerHandle | null = null;
  let inflightStatusUpdate: Promise<void> = Promise.resolve();

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
    const previous = inflightStatusUpdate;
    const request = (async () => {
      await previous;
      await args.transport.setStatus(channelId, threadTs, text, suggestions);
    })();
    inflightStatusUpdate = request;
    await request;
  };

  const postRenderedStatus = async (
    status: AssistantStatusInput,
  ): Promise<void> => {
    const presentation = buildAssistantStatusPresentation({
      status,
      currentVisible: currentVisibleStatus,
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
      currentVisible: currentVisibleStatus,
      random,
    });
    if (nextPresentation.key !== currentKey) {
      await postRenderedStatus(next);
    }
  };

  return {
    async start() {
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
    async setStatus(status: AssistantStatusInput) {
      if (!active) {
        return;
      }
      const presentation = buildAssistantStatusPresentation({
        status:
          typeof status === "string"
            ? normalizeAssistantStatusText(status)
            : status,
        currentVisible: currentVisibleStatus,
        random,
      });
      if (!presentation.visible) {
        return;
      }
      if (presentation.key === currentKey || presentation.key === pendingKey) {
        return;
      }
      const nextStatus =
        typeof status === "string"
          ? normalizeAssistantStatusText(status)
          : status;

      const elapsed = now() - lastStatusAt;
      const waitMs = Math.max(
        STATUS_UPDATE_DEBOUNCE_MS - elapsed,
        STATUS_MIN_VISIBLE_MS - elapsed,
        0,
      );

      if (waitMs <= 0) {
        clearPending();
        void postRenderedStatus(nextStatus);
        return;
      }

      pendingStatus = nextStatus;
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
