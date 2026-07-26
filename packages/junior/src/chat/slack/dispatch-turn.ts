import { Message, ThreadImpl } from "chat";
import type { SlackAdapter } from "@chat-adapter/slack";
import type {
  TurnExecutionContext,
  TurnExecutionOutcome,
} from "@/chat/runtime/reply-executor";
import { getStateAdapter } from "@/chat/state/adapter";
import type { DispatchRecord } from "@/chat/agent-dispatch/types";
import { getChannelConfigurationServiceById } from "@/chat/runtime/thread-state";
import {
  getDispatchConversationId,
  getDispatchTurnId,
} from "@/chat/agent-dispatch/store";
import {
  buildDispatchRoutingContext,
  type DispatchTurnResult,
} from "@/chat/agent-dispatch/work";

interface DispatchReplyToThread {
  (
    thread: ThreadImpl,
    message: Message,
    options: {
      ack?: () => Promise<void>;
      destination: DispatchRecord["destination"];
      execution: TurnExecutionContext;
      onTurnDeliveryAccepted?: (messageId?: string) => void;
      onTurnOutcome?: (outcome: TurnExecutionOutcome) => void;
      shouldYield?: () => boolean;
      skipBackfill?: boolean;
    },
  ): Promise<void>;
}

/** Build the Slack provider adapter for plugin-dispatched conversation turns. */
export function createSlackDispatchTurnRunner(options: {
  getSlackAdapter: () => SlackAdapter;
  replyToThread: DispatchReplyToThread;
}) {
  return async function runSlackDispatchTurn(
    dispatch: DispatchRecord,
    hooks: {
      ack: () => Promise<void>;
      shouldYield?: () => boolean;
    },
  ): Promise<DispatchTurnResult> {
    const state = getStateAdapter();
    await state.connect();
    const conversationId = getDispatchConversationId(dispatch);
    const adapter = options.getSlackAdapter();
    const message = new Message({
      id: `agent-dispatch:${dispatch.id}`,
      threadId: conversationId,
      text: dispatch.input,
      attachments: [],
      formatted: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: dispatch.input }],
          },
        ],
      },
      metadata: {
        dateSent: new Date(dispatch.createdAtMs),
        edited: false,
      },
      raw: {
        channel: dispatch.destination.channelId,
        team: dispatch.destination.teamId,
      },
      author: {
        userId: dispatch.actor.name,
        userName: dispatch.actor.name,
        fullName: dispatch.actor.name,
        isBot: true,
        isMe: false,
      },
    });
    message.isMention = true;
    const thread = new ThreadImpl({
      adapter,
      stateAdapter: state,
      id: conversationId,
      channelId: dispatch.destination.channelId,
      channelVisibility:
        dispatch.destinationVisibility === "public" ? "workspace" : "private",
      currentMessage: message,
      initialMessage: message,
      isDM: dispatch.destination.channelId.startsWith("D"),
      isSubscribedContext: true,
    });

    let outcome: TurnExecutionOutcome | undefined;
    let resultMessageTs: string | undefined;
    const routing = buildDispatchRoutingContext(dispatch);
    await options.replyToThread(thread, message, {
      ack: hooks.ack,
      destination: dispatch.destination,
      execution: {
        authorizationFlowMode: "disabled",
        channelConfiguration: getChannelConfigurationServiceById(
          dispatch.destination.channelId,
        ),
        credentialContext: routing.credentialContext,
        destinationVisibility: dispatch.destinationVisibility,
        dispatch: routing.dispatch,
        skipProviderDefaultConfig: true,
        source: dispatch.source,
        surface: routing.surface,
        turnId: getDispatchTurnId(dispatch.id),
      },
      onTurnDeliveryAccepted: (messageId) => {
        resultMessageTs = messageId;
      },
      onTurnOutcome: (nextOutcome) => {
        outcome = nextOutcome;
      },
      shouldYield: hooks.shouldYield,
      skipBackfill: true,
    });
    return {
      ...(outcome ? { outcome } : {}),
      ...(resultMessageTs ? { resultMessageTs } : {}),
    };
  };
}
