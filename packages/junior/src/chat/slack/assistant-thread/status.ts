import type { SlackAdapter } from "@chat-adapter/slack";
import { getSlackClient } from "@/chat/slack/client";
import {
  createAssistantStatusScheduler,
  type AssistantStatusSession,
  type TimerHandle,
} from "@/chat/slack/assistant-thread/status-scheduler";
import {
  createSlackAdapterStatusSender,
  createSlackWebApiStatusSender,
} from "@/chat/slack/assistant-thread/status-send";
export {
  makeAssistantStatus,
  type AssistantStatusKind,
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status-render";
export type { AssistantStatusSession } from "@/chat/slack/assistant-thread/status-scheduler";

/**
 * Create an assistant-status session for a single turn.
 *
 * `start()` and `update()` are intentionally fire-and-forget. Status is a
 * best-effort UX surface, not a turn-execution dependency. Callers may await
 * `flush()` immediately before the first visible reply to preserve Slack's
 * final status ordering without blocking model/tool execution.
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
  return createAssistantStatusScheduler({
    sendStatus: (text, suggestions) => {
      const channelId = args.channelId;
      const threadTs = args.threadTs;
      if (!channelId || !threadTs) {
        return Promise.resolve();
      }

      return args.setStatus(channelId, threadTs, text, suggestions);
    },
    now: args.now,
    setTimer: args.setTimer,
    clearTimer: args.clearTimer,
    random: args.random,
  });
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
  return createAssistantStatusScheduler({
    sendStatus: createSlackAdapterStatusSender({
      channelId: args.channelId,
      threadTs: args.threadTs,
      getSlackAdapter: args.getSlackAdapter,
    }),
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
  return createAssistantStatusScheduler({
    sendStatus: createSlackWebApiStatusSender({
      channelId: args.channelId,
      threadTs: args.threadTs,
      getSlackClient: args.getSlackClient,
    }),
    now: args.now,
    setTimer: args.setTimer,
    clearTimer: args.clearTimer,
    random: args.random,
  });
}
