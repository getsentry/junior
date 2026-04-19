import type { SlackAdapter } from "@chat-adapter/slack";
import { botConfig } from "@/chat/config";
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
  type AssistantStatusSpec,
} from "@/chat/slack/assistant-thread/status-render";
export type { AssistantStatusSession } from "@/chat/slack/assistant-thread/status-scheduler";

/**
 * Create a Slack adapter-backed session for Slack's assistant loading state.
 *
 * The session accepts internal progress updates and leaves it to the sender to
 * map them onto Slack's fixed generic `status` field plus dynamic
 * `loading_messages`.
 */
export function createSlackAdapterAssistantStatusSession(args: {
  channelId?: string;
  threadTs?: string;
  getSlackAdapter: () => Pick<SlackAdapter, "setAssistantStatus">;
  loadingMessages?: string[];
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
    loadingMessages: args.loadingMessages ?? botConfig.loadingMessages,
    now: args.now,
    setTimer: args.setTimer,
    clearTimer: args.clearTimer,
    random: args.random,
  });
}

/**
 * Create a Web API-backed session for Slack's assistant loading state in
 * resume/callback flows that do not use the adapter thread object.
 */
export function createSlackWebApiAssistantStatusSession(args: {
  channelId?: string;
  threadTs?: string;
  getSlackClient?: typeof getSlackClient;
  loadingMessages?: string[];
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
    loadingMessages: args.loadingMessages ?? botConfig.loadingMessages,
    now: args.now,
    setTimer: args.setTimer,
    clearTimer: args.clearTimer,
    random: args.random,
  });
}
