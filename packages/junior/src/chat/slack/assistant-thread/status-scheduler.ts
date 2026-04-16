import {
  makeAssistantStatus,
  renderAssistantStatus,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status-render";

const STATUS_UPDATE_DEBOUNCE_MS = 1000;
const STATUS_MIN_VISIBLE_MS = 1200;
const STATUS_ROTATION_INTERVAL_MS = 30_000;

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface AssistantStatusSession {
  start: () => void;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
  update: (status: AssistantStatusSpec) => void;
}

/**
 * Pace assistant-status writes for a single turn.
 *
 * This layer owns only local scheduling policy: debounce, minimum visible
 * duration, refresh cadence, and write ordering. It intentionally does not
 * know about Slack channel IDs, tokens, or API clients.
 */
export function createAssistantStatusScheduler(args: {
  sendStatus: (text: string, suggestions?: string[]) => Promise<void>;
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
    // Status writes are best effort, but they still need strict ordering so a
    // slow "thinking" write cannot land after stop() already cleared the UI.
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

    // Slack removes assistant status automatically after about two minutes if
    // no reply arrives, so long-running turns must refresh the current status.
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
    if (!text && !currentVisibleStatus) {
      return;
    }

    currentVisibleStatus = text;
    lastStatusAt = now();
    scheduleRotation();
    await enqueueStatusUpdate(async () => {
      await args.sendStatus(text, suggestions);
    });
  };

  const postRenderedStatus = async (
    status: AssistantStatusSpec,
  ): Promise<void> => {
    const presentation = renderAssistantStatus({
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
    const nextPresentation = renderAssistantStatus({
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
    async flush() {
      // Drain writes that already started without forcing debounced future
      // updates to publish early.
      await inflightStatusUpdate.catch(() => undefined);
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
      const presentation = renderAssistantStatus({
        status,
        random,
      });
      if (!presentation.visible) {
        return;
      }
      if (presentation.key === currentKey || presentation.key === pendingKey) {
        return;
      }

      // Coalesce tool chatter and keep each visible status on screen long
      // enough to read before swapping to the next one.
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
