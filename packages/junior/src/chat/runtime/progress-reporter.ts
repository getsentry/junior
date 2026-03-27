import { logWarn } from "@/chat/logging";
import { truncateStatusText } from "@/chat/runtime/status-format";

const STATUS_UPDATE_DEBOUNCE_MS = 1000;
const STATUS_MIN_VISIBLE_MS = 1200;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ProgressReporter {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setStatus: (text: string) => Promise<void>;
}

/** Create a debounced status reporter that drives the Slack "typing" indicator during a turn. */
export function createProgressReporter(args: {
  channelId?: string;
  threadTs?: string;
  setAssistantStatus: (
    channelId: string,
    threadTs: string,
    text: string,
    suggestions?: string[],
  ) => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}): ProgressReporter {
  const now = args.now ?? (() => Date.now());
  const setTimer =
    args.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    args.clearTimer ?? ((timer: TimerHandle) => clearTimeout(timer));

  let active = false;
  let currentStatus = "";
  let lastStatusAt = 0;
  let pendingStatus: string | null = null;
  let pendingTimer: TimerHandle | null = null;
  let inflightStatusUpdate: Promise<void> = Promise.resolve();

  const postStatus = async (text: string): Promise<void> => {
    const channelId = args.channelId;
    const threadTs = args.threadTs;
    if (!channelId || !threadTs) {
      return;
    }
    if (!text && !currentStatus) {
      return;
    }

    currentStatus = text;
    lastStatusAt = now();
    const suggestions = text ? [text] : undefined;
    const previous = inflightStatusUpdate;
    const request = (async () => {
      await previous;
      try {
        await args.setAssistantStatus(channelId, threadTs, text, suggestions);
      } catch (error) {
        logWarn(
          "assistant_status_update_failed",
          {},
          {
            "app.slack.status_text": text || "(clear)",
            "error.message":
              error instanceof Error ? error.message : String(error),
          },
          "Failed to update assistant status",
        );
      }
    })();
    inflightStatusUpdate = request;
    await request;
  };

  const clearPending = () => {
    if (pendingTimer) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
  };

  const flushPending = async () => {
    if (!active || !pendingStatus) {
      clearPending();
      return;
    }

    const next = pendingStatus;
    clearPending();
    if (next !== currentStatus) {
      await postStatus(next);
    }
  };

  return {
    async start() {
      active = true;
      clearPending();
      void postStatus("Thinking...");
    },
    async stop() {
      active = false;
      clearPending();
      await postStatus("");
    },
    async setStatus(text: string) {
      const truncated = truncateStatusText(text);
      if (
        !active ||
        !truncated ||
        truncated === currentStatus ||
        truncated === pendingStatus
      ) {
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
        void postStatus(truncated);
        return;
      }

      pendingStatus = truncated;
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
