import {
  makeAssistantStatus,
  renderAssistantStatus,
  selectAssistantLoadingMessages,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status-render";

const STATUS_UPDATE_DEBOUNCE_MS = 1000;
const STATUS_MIN_VISIBLE_MS = 1200;
const STATUS_ROTATION_INTERVAL_MS = 30_000;

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface AssistantStatusSession {
  start: () => void;
  stop: () => Promise<void>;
  update: (status: AssistantStatusSpec) => void;
}

/**
 * Pace assistant loading-state writes for a single turn.
 *
 * This layer owns only local scheduling policy: debounce, minimum visible
 * duration, refresh cadence, and write ordering. It deals in user-visible
 * progress copy; the transport decides how that maps onto Slack's `status`
 * versus `loading_messages` fields.
 */
export function createAssistantStatusScheduler(args: {
  sendStatus: (text: string, loadingMessages?: string[]) => Promise<void>;
  loadingMessages?: string[];
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
  const loadingMessages = selectAssistantLoadingMessages({
    messages: args.loadingMessages ?? [],
    random,
  });
  const defaultStatus = makeAssistantStatus("thinking");

  let active = false;
  let currentKey = "";
  let currentVisibleStatus = "";
  let currentLoadingMessages: string[] | undefined;
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

    // Slack removes assistant loading state automatically after about two
    // minutes if no reply arrives, so long-running turns must refresh the
    // current visible loading copy.
    rotationTimer = setTimer(() => {
      rotationTimer = null;
      if (!active || !currentVisibleStatus) {
        return;
      }
      void postStatus(currentVisibleStatus, currentLoadingMessages);
    }, STATUS_ROTATION_INTERVAL_MS);
  };

  const getLoadingMessagesForVisibleStatus = (
    visible: string,
  ): string[] | undefined => (visible ? [visible] : undefined);

  const getInitialStatusText = (): string => {
    if (loadingMessages?.length) {
      return loadingMessages[0];
    }

    return defaultStatus.text;
  };

  const haveSameLoadingMessages = (
    left: string[] | undefined,
    right: string[] | undefined,
  ): boolean => {
    if (left === right) {
      return true;
    }
    if (!left || !right || left.length !== right.length) {
      return false;
    }
    return left.every((message, index) => message === right[index]);
  };

  const postStatus = async (
    text: string,
    nextLoadingMessages?: string[],
  ): Promise<void> => {
    if (!text && !currentVisibleStatus) {
      return;
    }

    currentVisibleStatus = text;
    currentLoadingMessages = nextLoadingMessages;
    lastStatusAt = now();
    scheduleRotation();
    await enqueueStatusUpdate(async () => {
      await args.sendStatus(text, nextLoadingMessages);
    });
  };

  const postRenderedStatus = async (
    status: AssistantStatusSpec,
  ): Promise<void> => {
    const presentation = renderAssistantStatus({
      status,
    });
    const nextLoadingMessages = getLoadingMessagesForVisibleStatus(
      presentation.visible,
    );
    currentKey = presentation.key;
    await postStatus(presentation.visible, nextLoadingMessages);
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
    });
    if (nextPresentation.key !== currentKey) {
      await postRenderedStatus(next);
    }
  };

  return {
    start() {
      active = true;
      clearPending();
      currentKey = "initial";
      void postStatus(getInitialStatusText(), loadingMessages);
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
      });
      if (!presentation.visible) {
        return;
      }
      if (presentation.key === currentKey || presentation.key === pendingKey) {
        return;
      }
      if (presentation.visible === currentVisibleStatus) {
        clearPending();
        currentKey = presentation.key;
        const nextLoadingMessages = getLoadingMessagesForVisibleStatus(
          presentation.visible,
        );
        if (
          !haveSameLoadingMessages(currentLoadingMessages, nextLoadingMessages)
        ) {
          void postStatus(presentation.visible, nextLoadingMessages);
        }
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
